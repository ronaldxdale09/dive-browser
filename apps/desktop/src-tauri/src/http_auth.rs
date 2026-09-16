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

use std::collections::HashMap;
use std::sync::Mutex;

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

/// The challenges waiting for an answer, by tab.
#[derive(Default)]
pub struct Registry {
    open: Mutex<HashMap<(TabId, String), HttpAuthAsked>>,
}

impl Registry {
    /// Record a challenge the chrome is about to be told about.
    pub fn add(&self, asked: HttpAuthAsked) {
        lock(&self.open).insert((asked.tab_id, asked.request_id.clone()), asked);
    }

    /// Forget one. False when it had already gone.
    pub fn remove(&self, tab_id: TabId, request_id: &str) -> bool {
        lock(&self.open)
            .remove(&(tab_id, request_id.to_owned()))
            .is_some()
    }

    /// Every challenge still waiting in `tab`.
    pub fn for_tab(&self, tab_id: TabId) -> Vec<HttpAuthAsked> {
        lock(&self.open)
            .values()
            .filter(|asked| asked.tab_id == tab_id)
            .cloned()
            .collect()
    }

    /// Drop a tab's challenges: it closed, or it navigated away.
    pub fn forget_tab(&self, tab_id: TabId) {
        lock(&self.open).retain(|(tab, _), _| *tab != tab_id);
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

/// A server or proxy asked who we are: record it and tell the chrome.
///
/// The request stays paused inside Chromium until [`answer`] replies, which
/// is what lets the person take as long as they need.
pub fn on_auth_required(app: &AppHandle<Runtime>, tab_id: TabId, params: &Value) {
    let Some(asked) = asked_from(tab_id, params) else {
        return;
    };
    tracing::debug!(%tab_id, host = %asked.host, proxy = asked.is_proxy, "a server asked who we are");
    app.state::<AppState>().http_auth.add(asked.clone());
    let _ = asked.emit(app);
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
    let session: CdpSession = {
        let state = app.state::<AppState>();
        if !state.http_auth.remove(tab_id, request_id) {
            return Err(AppError::new("that sign-in is no longer waiting"));
        }
        lock(&state.host)
            .as_ref()
            .and_then(|host| host.cdp(tab_id))
            .ok_or_else(|| AppError::new("no devtools session"))?
    };
    session
        .call(
            "Fetch.continueWithAuth",
            json!({
                "requestId": request_id,
                "authChallengeResponse": challenge_response(credentials),
            }),
        )
        .await
        .map_err(AppError::new)?;
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
}
