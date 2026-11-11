//! Signing in to a server that asks with `WWW-Authenticate`.
//!
//! Basic auth is old, plain, and still how a great many internal tools and
//! staging servers are protected -- which is to say, the ones this browser is
//! for. Dive refused every challenge, because nothing implemented the
//! engine's callback, so those sites simply failed with an authentication
//! error and no way to answer it.
//!
//! The obvious hook is CEF's own `GetAuthCredentials`. It does not work: the
//! callback is wired into the vtable and the handler installs, and a real 401
//! from a server and a real 407 from a proxy both went past without it ever
//! being called. So the challenge is taken where this browser already has a
//! foothold in the network -- Chromium's own `Fetch` domain, which raises
//! `Fetch.authRequired` and waits for `Fetch.continueWithAuth`.
//!
//! The request is genuinely paused meanwhile, so the page finishes either
//! way: signed in, or shown the server's refusal.
//!
//! Two things are worth saying plainly on the card and are carried here for
//! it: whether the *proxy* is asking rather than the site, because a site
//! password typed into a proxy's prompt goes to the proxy; and whether the
//! connection is encrypted, because Basic auth over http sends the password
//! in the clear, recoverable by anyone on the way.
//!
//! Not everything that is challenged may put a card over the page. With
//! interception rules or privacy blocking on, images and scripts from any
//! third party pass through the same pipeline, and a card from one of them
//! would look like the page asking. So a card is raised only for a proxy,
//! the top-level document, or a request from the page's own site; any other
//! challenge is refused quietly and ends in the server's 401, as Chromium
//! does for cross-origin subresources. A second challenge for a realm that
//! already has a card joins that card instead of stacking another, a tab
//! holds at most three cards, and a realm the person just dismissed is not
//! asked again for a short while.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use dive_cdp::CdpSession;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use dive_core::TabId;

use crate::Runtime;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// A server or proxy is asking who you are.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct HttpAuthAsked {
    pub tab_id: TabId,
    /// Opaque; pass it back to `http_auth_answer`.
    pub request_id: String,
    /// The host asking, with its port when it is not the usual one.
    pub host: String,
    /// The server's name for the protected area. Often empty, and shown only
    /// when it is not: it is the one thing that distinguishes two prompts
    /// from the same host.
    pub realm: String,
    /// `basic`, `digest`, `ntlm`, `negotiate`.
    pub scheme: String,
    /// The proxy is asking, not the site.
    pub is_proxy: bool,
    /// The connection carrying the password is encrypted.
    pub secure: bool,
}

/// A challenge that is no longer waiting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct HttpAuthClosed {
    pub tab_id: TabId,
    pub request_id: String,
}

/// How long a dismissed realm is left alone.
const DISMISS_COOLDOWN: Duration = Duration::from_secs(10);

/// Most cards one tab may have up at once.
const MAX_OPEN_PER_TAB: usize = 3;

/// A card that is up, and the other requests answered together with it.
struct Open {
    asked: HttpAuthAsked,
    followers: Vec<String>,
}

/// The challenges waiting for an answer, by tab.
#[derive(Default)]
pub struct Registry {
    open: Mutex<HashMap<(TabId, String), Open>>,
    /// Realms the person dismissed, and when they may be asked again.
    dismissed: Mutex<HashMap<(TabId, String, String), Instant>>,
}

impl Registry {
    /// Record a challenge the chrome is about to be told about.
    pub fn add(&self, asked: HttpAuthAsked) {
        lock(&self.open).insert(
            (asked.tab_id, asked.request_id.clone()),
            Open {
                asked,
                followers: Vec::new(),
            },
        );
    }

    /// Forget one. False when it had already gone.
    pub fn remove(&self, tab_id: TabId, request_id: &str) -> bool {
        lock(&self.open)
            .remove(&(tab_id, request_id.to_owned()))
            .is_some()
    }

    /// Forget one together with the requests that joined it: the card's own
    /// request id first, then the followers. `None` when it had gone.
    pub fn remove_with_followers(
        &self,
        tab_id: TabId,
        request_id: &str,
    ) -> Option<(HttpAuthAsked, Vec<String>)> {
        let open = lock(&self.open).remove(&(tab_id, request_id.to_owned()))?;
        Some((open.asked, open.followers))
    }

    /// Every challenge still waiting in `tab`.
    pub fn for_tab(&self, tab_id: TabId) -> Vec<HttpAuthAsked> {
        lock(&self.open)
            .values()
            .filter(|open| open.asked.tab_id == tab_id)
            .map(|open| open.asked.clone())
            .collect()
    }

    /// How many cards `tab` has up.
    pub fn count(&self, tab_id: TabId) -> usize {
        lock(&self.open)
            .keys()
            .filter(|(tab, _)| *tab == tab_id)
            .count()
    }

    /// The request id of the card already up for this tab, host, realm and
    /// asker, if any.
    pub fn open_leader(
        &self,
        tab_id: TabId,
        host: &str,
        realm: &str,
        is_proxy: bool,
    ) -> Option<String> {
        lock(&self.open)
            .values()
            .find(|open| {
                open.asked.tab_id == tab_id
                    && open.asked.host == host
                    && open.asked.realm == realm
                    && open.asked.is_proxy == is_proxy
            })
            .map(|open| open.asked.request_id.clone())
    }

    /// Answer `request_id` together with the card `leader`.
    pub fn follow(&self, tab_id: TabId, leader: &str, request_id: &str) {
        if let Some(open) = lock(&self.open).get_mut(&(tab_id, leader.to_owned())) {
            open.followers.push(request_id.to_owned());
        }
    }

    /// Leave a realm alone until `until`.
    pub fn dismiss(&self, tab_id: TabId, host: &str, realm: &str, until: Instant) {
        lock(&self.dismissed).insert((tab_id, host.to_owned(), realm.to_owned()), until);
    }

    /// Whether the person dismissed this realm too recently to ask again,
    /// forgetting the dismissals that have run out.
    pub fn cooling(&self, tab_id: TabId, host: &str, realm: &str, now: Instant) -> bool {
        let mut dismissed = lock(&self.dismissed);
        dismissed.retain(|_, until| *until > now);
        dismissed.contains_key(&(tab_id, host.to_owned(), realm.to_owned()))
    }

    /// Drop a tab's challenges: it closed, or it navigated away.
    pub fn forget_tab(&self, tab_id: TabId) {
        lock(&self.open).retain(|(tab, _), _| *tab != tab_id);
        lock(&self.dismissed).retain(|(tab, _, _), _| *tab != tab_id);
    }

    /// Drop a tab's challenges and say which they were. Followers are not
    /// named: the Fetch reset that ends the cards releases them too.
    pub fn take_tab(&self, tab_id: TabId) -> Vec<String> {
        let mut open = lock(&self.open);
        let gone: Vec<String> = open
            .keys()
            .filter(|(tab, _)| *tab == tab_id)
            .map(|(_, request)| request.clone())
            .collect();
        for request in &gone {
            open.remove(&(tab_id, request.clone()));
        }
        gone
    }
}

/// The requests behind `tab_id`'s sign-in cards are gone: its page moved on
/// to another document, or interception was reset, which releases every
/// paused request. A card left up would answer a request nothing waits for,
/// and "that sign-in is no longer waiting" is all the person would get.
pub fn abandon_tab(app: &AppHandle<Runtime>, tab_id: TabId) {
    for request_id in app.state::<AppState>().http_auth.take_tab(tab_id) {
        let _ = HttpAuthClosed { tab_id, request_id }.emit(app);
    }
}

/// How the host is named on the card: the port only when it is a surprise.
fn address_of(origin: &str) -> String {
    let rest = origin.split_once("://").map_or(origin, |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let secure = origin.starts_with("https://");
    match authority.rsplit_once(':') {
        Some((host, port)) if port == "443" && secure => host.to_owned(),
        Some((host, port)) if port == "80" && !secure => host.to_owned(),
        _ => authority.to_owned(),
    }
}

/// A challenge as Chromium describes it, or `None` for an event that is not
/// one this browser can answer.
pub fn asked_from(tab_id: TabId, params: &Value) -> Option<HttpAuthAsked> {
    let request_id = params["requestId"].as_str()?.to_owned();
    let challenge = &params["authChallenge"];
    let origin = challenge["origin"].as_str().unwrap_or_default();
    Some(HttpAuthAsked {
        tab_id,
        request_id,
        host: address_of(origin),
        realm: challenge["realm"].as_str().unwrap_or_default().to_owned(),
        scheme: challenge["scheme"]
            .as_str()
            .unwrap_or_default()
            .to_lowercase(),
        is_proxy: challenge["source"].as_str() == Some("Proxy"),
        secure: origin.starts_with("https://"),
    })
}

/// What to do with a challenge, decided before anyone is asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Put a card up for it.
    Ask(HttpAuthAsked),
    /// A card for the same tab, host, realm and source is already up:
    /// answer this request together with that card's (its request id).
    Follow { leader: String },
    /// Refuse quietly (`CancelAuth`); the request ends in the server's 401.
    Refuse(&'static str),
}

/// Where the challenge came from, relative to the page.
pub struct Origin<'a> {
    pub top_frame_id: Option<&'a str>,
    pub top_document_url: &'a str,
}

/// Whether a card may be raised for this challenge, joins one already up, or
/// is refused. The order matters: a dismissal and an open card are settled
/// before anything is asked.
pub fn decide(
    registry: &Registry,
    tab_id: TabId,
    params: &Value,
    page: &Origin<'_>,
    now: Instant,
) -> Option<Decision> {
    let asked = asked_from(tab_id, params)?;
    if registry.cooling(tab_id, &asked.host, &asked.realm, now) {
        return Some(Decision::Refuse("dismissed moments ago"));
    }
    if let Some(leader) = registry.open_leader(tab_id, &asked.host, &asked.realm, asked.is_proxy) {
        return Some(Decision::Follow { leader });
    }
    let the_page_itself = params["resourceType"].as_str() == Some("Document")
        && page
            .top_frame_id
            .is_none_or(|top| params["frameId"].as_str() == Some(top));
    let may_ask = if asked.is_proxy || the_page_itself {
        true
    } else {
        let origin = params["authChallenge"]["origin"]
            .as_str()
            .unwrap_or_default();
        match (
            crate::site::of(origin),
            crate::site::of(page.top_document_url),
        ) {
            (Some(asking), Some(current)) => asking == current,
            _ => false,
        }
    };
    if !may_ask {
        return Some(Decision::Refuse("a different site's embedded request"));
    }
    if registry.count(tab_id) >= MAX_OPEN_PER_TAB {
        return Some(Decision::Refuse("too many sign-in requests at once"));
    }
    Some(Decision::Ask(asked))
}

/// A server or proxy asked who we are: decide whether to ask, and either
/// tell the chrome, join a card already up, or refuse.
///
/// An asked request stays paused inside Chromium until [`answer`] replies,
/// which is what lets the person take as long as they need.
pub async fn on_auth_required(
    app: &AppHandle<Runtime>,
    session: &CdpSession,
    tab_id: TabId,
    params: &Value,
    page: &Origin<'_>,
) {
    let registry = &app.state::<AppState>().http_auth;
    let Some(decision) = decide(registry, tab_id, params, page, Instant::now()) else {
        return;
    };
    match decision {
        Decision::Ask(asked) => {
            tracing::debug!(%tab_id, host = %asked.host, proxy = asked.is_proxy, "a server asked who we are");
            registry.add(asked.clone());
            let _ = asked.emit(app);
        }
        Decision::Follow { leader } => {
            if let Some(request_id) = params["requestId"].as_str() {
                registry.follow(tab_id, &leader, request_id);
            }
        }
        Decision::Refuse(why) => {
            tracing::debug!(%tab_id, why, "sign-in request refused without asking");
            let Some(request_id) = params["requestId"].as_str() else {
                return;
            };
            if let Err(error) = session
                .call(
                    "Fetch.continueWithAuth",
                    json!({
                        "requestId": request_id,
                        "authChallengeResponse": challenge_response(None),
                    }),
                )
                .await
            {
                tracing::debug!(%tab_id, %error, "refusing a sign-in request failed");
            }
        }
    }
}

/// What to send back for a challenge.
fn challenge_response(credentials: Option<(String, String)>) -> Value {
    match credentials {
        Some((username, password)) => json!({
            "response": "ProvideCredentials",
            "username": username,
            "password": password,
        }),
        // Not `Default`: that would let Chromium put up its own prompt, and
        // in this build there is nothing behind it.
        None => json!({"response": "CancelAuth"}),
    }
}

/// Answer challenge `request_id` on `tab_id`.
pub async fn answer(
    app: &AppHandle<Runtime>,
    tab_id: TabId,
    request_id: &str,
    credentials: Option<(String, String)>,
) -> AppResult<()> {
    let dismissed = credentials.is_none();
    let (session, asked, followers): (CdpSession, HttpAuthAsked, Vec<String>) = {
        let state = app.state::<AppState>();
        let Some((asked, followers)) = state.http_auth.remove_with_followers(tab_id, request_id)
        else {
            return Err(AppError::new("that sign-in is no longer waiting"));
        };
        let session = lock(&state.host)
            .as_ref()
            .and_then(|host| host.cdp(tab_id))
            .ok_or_else(|| AppError::new("no devtools session"))?;
        (session, asked, followers)
    };
    if dismissed {
        app.state::<AppState>().http_auth.dismiss(
            tab_id,
            &asked.host,
            &asked.realm,
            Instant::now() + DISMISS_COOLDOWN,
        );
    }
    let response = challenge_response(credentials);
    session
        .call(
            "Fetch.continueWithAuth",
            json!({
                "requestId": request_id,
                "authChallengeResponse": response,
            }),
        )
        .await
        .map_err(AppError::new)?;
    // A follower's request may already be gone; that is not the person's
    // problem.
    for follower in followers {
        if let Err(error) = session
            .call(
                "Fetch.continueWithAuth",
                json!({
                    "requestId": follower,
                    "authChallengeResponse": response,
                }),
            )
            .await
        {
            tracing::debug!(%tab_id, %error, "answering a joined sign-in request failed");
        }
    }
    let _ = HttpAuthClosed {
        tab_id,
        request_id: request_id.to_owned(),
    }
    .emit(app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn challenge(source: &str, origin: &str, realm: &str) -> Value {
        json!({
            "requestId": "interception-job-1.0",
            "authChallenge": {"source": source, "origin": origin, "scheme": "basic", "realm": realm},
        })
    }

    fn from(source: &str, origin: &str, realm: &str, resource: &str, frame: &str) -> Value {
        let mut value = challenge(source, origin, realm);
        value["resourceType"] = json!(resource);
        value["frameId"] = json!(frame);
        value
    }

    fn page<'a>(top: Option<&'a str>, url: &'a str) -> Origin<'a> {
        Origin {
            top_frame_id: top,
            top_document_url: url,
        }
    }

    fn is_refused(decision: Option<&Decision>) -> bool {
        matches!(decision, Some(Decision::Refuse(_)))
    }

    const TOP: &str = "https://tools.example.com/app";

    #[test]
    fn the_page_itself_may_ask() {
        let params = from(
            "Server",
            "https://tools.example.com",
            "R",
            "Document",
            "main",
        );
        let decision = decide(
            &Registry::default(),
            TabId::new(),
            &params,
            &page(Some("main"), TOP),
            Instant::now(),
        );
        assert!(matches!(decision, Some(Decision::Ask(_))));
    }

    #[test]
    fn a_first_navigation_with_no_known_frame_may_ask() {
        let params = from(
            "Server",
            "https://other.example.net",
            "R",
            "Document",
            "main",
        );
        let decision = decide(
            &Registry::default(),
            TabId::new(),
            &params,
            &page(None, ""),
            Instant::now(),
        );
        assert!(matches!(decision, Some(Decision::Ask(_))));
    }

    #[test]
    fn the_pages_own_site_may_ask_from_an_image() {
        let params = from(
            "Server",
            "https://cdn.tools.example.com",
            "R",
            "Image",
            "child",
        );
        let decision = decide(
            &Registry::default(),
            TabId::new(),
            &params,
            &page(Some("main"), TOP),
            Instant::now(),
        );
        assert!(matches!(decision, Some(Decision::Ask(_))));
    }

    #[test]
    fn another_sites_embed_is_refused() {
        let registry = Registry::default();
        let tab = TabId::new();
        for (resource, frame) in [("Document", "child"), ("Image", "main")] {
            let params = from("Server", "https://other.example.net", "R", resource, frame);
            assert!(is_refused(
                decide(
                    &registry,
                    tab,
                    &params,
                    &page(Some("main"), "https://tools.example.com/"),
                    Instant::now(),
                )
                .as_ref()
            ));
        }
    }

    #[test]
    fn a_proxy_always_asks() {
        let params = from("Proxy", "http://10.0.0.2:8080", "Corp", "Image", "child");
        let decision = decide(
            &Registry::default(),
            TabId::new(),
            &params,
            &page(Some("main"), TOP),
            Instant::now(),
        );
        assert!(matches!(decision, Some(Decision::Ask(_))));
    }

    #[test]
    fn a_second_challenge_for_an_open_card_follows_it() {
        let registry = Registry::default();
        let tab = TabId::new();
        let first = from(
            "Server",
            "https://tools.example.com",
            "R",
            "Document",
            "main",
        );
        registry.add(asked_from(tab, &first).unwrap());
        let mut second = from("Server", "https://tools.example.com", "R", "Image", "main");
        second["requestId"] = json!("second");
        let origin = page(Some("main"), TOP);
        assert_eq!(
            decide(&registry, tab, &second, &origin, Instant::now()),
            Some(Decision::Follow {
                leader: "interception-job-1.0".to_owned()
            })
        );
        let mut other_realm = from(
            "Server",
            "https://tools.example.com",
            "Other",
            "Image",
            "main",
        );
        other_realm["requestId"] = json!("third");
        assert!(matches!(
            decide(&registry, tab, &other_realm, &origin, Instant::now()),
            Some(Decision::Ask(_))
        ));
    }

    #[test]
    fn no_more_than_three_cards_per_tab() {
        let registry = Registry::default();
        let tab = TabId::new();
        for n in 0..3 {
            let mut params = from(
                "Server",
                "https://tools.example.com",
                &format!("r{n}"),
                "Document",
                "main",
            );
            params["requestId"] = json!(format!("req-{n}"));
            registry.add(asked_from(tab, &params).unwrap());
        }
        let fourth = from(
            "Server",
            "https://tools.example.com",
            "r3",
            "Document",
            "main",
        );
        assert!(is_refused(
            decide(
                &registry,
                tab,
                &fourth,
                &page(Some("main"), TOP),
                Instant::now(),
            )
            .as_ref()
        ));
    }

    #[test]
    fn a_dismissed_realm_is_not_asked_again_at_once() {
        let registry = Registry::default();
        let tab = TabId::new();
        let now = Instant::now();
        registry.dismiss(tab, "tools.example.com", "R", now + DISMISS_COOLDOWN);
        let params = from(
            "Server",
            "https://tools.example.com",
            "R",
            "Document",
            "main",
        );
        let origin = page(Some("main"), TOP);
        assert!(is_refused(
            decide(
                &registry,
                tab,
                &params,
                &origin,
                now + Duration::from_secs(1)
            )
            .as_ref()
        ));
        assert!(matches!(
            decide(
                &registry,
                tab,
                &params,
                &origin,
                now + Duration::from_secs(11)
            ),
            Some(Decision::Ask(_))
        ));
    }

    #[test]
    fn answering_releases_the_followers_too() {
        let registry = Registry::default();
        let tab = TabId::new();
        registry
            .add(asked_from(tab, &challenge("Server", "https://tools.example.com", "R")).unwrap());
        registry.follow(tab, "interception-job-1.0", "f1");
        registry.follow(tab, "interception-job-1.0", "f2");
        let (_, followers) = registry
            .remove_with_followers(tab, "interception-job-1.0")
            .unwrap();
        assert_eq!(followers, vec!["f1".to_owned(), "f2".to_owned()]);
        assert!(
            registry
                .remove_with_followers(tab, "interception-job-1.0")
                .is_none()
        );
    }

    #[test]
    fn unknown_page_refuses_embedded_requests() {
        let params = from("Server", "https://tools.example.com", "R", "Image", "child");
        assert!(is_refused(
            decide(
                &Registry::default(),
                TabId::new(),
                &params,
                &page(Some("main"), ""),
                Instant::now(),
            )
            .as_ref()
        ));
    }

    #[test]
    fn a_challenge_becomes_a_card_with_the_host_it_came_from() {
        let tab = TabId::new();
        let asked = asked_from(
            tab,
            &challenge("Server", "http://tools.example.com:8080", "Staging"),
        )
        .unwrap();
        assert_eq!(asked.host, "tools.example.com:8080");
        assert_eq!(asked.realm, "Staging");
        assert_eq!(asked.scheme, "basic");
        assert!(!asked.is_proxy);
        assert!(!asked.secure, "http is not encrypted");
        assert_eq!(asked.request_id, "interception-job-1.0");
    }

    #[test]
    fn the_proxy_asking_is_never_mistaken_for_the_site() {
        let asked = asked_from(
            TabId::new(),
            &challenge("Proxy", "http://10.0.0.2:8080", "Corp"),
        )
        .unwrap();
        assert!(
            asked.is_proxy,
            "a site password must never be offered to a proxy by mistake"
        );
    }

    #[test]
    fn the_usual_port_is_left_off_and_an_unusual_one_is_kept() {
        assert_eq!(
            address_of("https://tools.example.com:443"),
            "tools.example.com"
        );
        assert_eq!(
            address_of("http://tools.example.com:80"),
            "tools.example.com"
        );
        assert_eq!(
            address_of("https://tools.example.com:8443"),
            "tools.example.com:8443"
        );
        assert_eq!(address_of("https://tools.example.com"), "tools.example.com");
    }

    #[test]
    fn an_event_that_is_not_a_challenge_is_ignored() {
        assert!(asked_from(TabId::new(), &json!({})).is_none());
        assert!(asked_from(TabId::new(), &json!({"authChallenge": {}})).is_none());
    }

    #[test]
    fn cancelling_refuses_rather_than_handing_back_to_chromium() {
        // "Default" would let Chromium raise its own prompt, and in this
        // build there is nothing behind that prompt at all.
        assert_eq!(challenge_response(None)["response"], "CancelAuth");
        let given = challenge_response(Some(("ada".into(), "hunter2".into())));
        assert_eq!(given["response"], "ProvideCredentials");
        assert_eq!(given["username"], "ada");
        assert_eq!(given["password"], "hunter2");
    }

    #[test]
    fn a_challenge_waits_until_it_is_answered_or_its_tab_goes() {
        let registry = Registry::default();
        let tab = TabId::new();
        let asked = asked_from(tab, &challenge("Server", "https://tools.example.com", "")).unwrap();
        registry.add(asked.clone());
        assert_eq!(registry.for_tab(tab), vec![asked]);
        assert!(registry.remove(tab, "interception-job-1.0"));
        assert!(
            !registry.remove(tab, "interception-job-1.0"),
            "answering twice must not work"
        );

        registry.add(asked_from(tab, &challenge("Server", "https://a.example", "")).unwrap());
        registry.forget_tab(tab);
        assert!(registry.for_tab(tab).is_empty());
    }

    #[test]
    fn a_tab_moving_on_takes_only_its_own_cards_with_it() {
        let registry = Registry::default();
        let (tab, other) = (TabId::new(), TabId::new());
        registry.add(asked_from(tab, &challenge("Server", "https://a.example", "")).unwrap());
        registry.add(asked_from(other, &challenge("Server", "https://b.example", "")).unwrap());
        assert_eq!(
            registry.take_tab(tab),
            vec!["interception-job-1.0".to_owned()]
        );
        assert!(registry.for_tab(tab).is_empty());
        assert_eq!(registry.for_tab(other).len(), 1, "another tab's card stays");
        assert!(registry.take_tab(tab).is_empty());
    }
}
