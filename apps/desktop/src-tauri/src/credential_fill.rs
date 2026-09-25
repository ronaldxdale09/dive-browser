//! Saved logins in pages: a script watches login forms and talks to the host
//! through a nonce-guarded binding. The host answers "which logins do you
//! know for this site" with usernames only, fills a password into the page
//! when asked, and turns a submitted login into a prompt for the chrome.
//! A submitted password waits in memory under a token until the person
//! answers the prompt; it never crosses into the chrome.

use std::collections::HashMap;
use std::sync::Mutex;

use dive_cdp::{CdpEvent, CdpSession};
use dive_core::{ProfileId, TabId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::Runtime;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const BINDING: &str = "__diveCredentials";
const MAX_PAYLOAD: usize = 64 * 1024;
const MAX_FIELD: usize = 1024;

/// What the chrome should ask the person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct CredentialPrompt {
    pub tab_id: TabId,
    /// `save` for a new login, `update` when the site's login for this
    /// username has a different password, `missing` when a login picked in
    /// the page has lost its password from the OS store. Choosing among
    /// several logins happens in the page, in a list under the field.
    pub kind: String,
    /// `scheme://host[:port]`.
    pub origin: String,
    /// The username submitted (save, update) or picked (missing).
    pub username: String,
    /// Handle for answering a save or update; the password stays in the host.
    /// For `missing`, the id of the login to forget.
    pub token: String,
}

struct PendingSave {
    tab: TabId,
    profile: ProfileId,
    url: String,
    username: String,
    password: String,
    at: std::time::Instant,
}

/// How long a submitted password waits for an answer. The card goes when its
/// tab closes, but a prompt nobody answers must not keep a password in memory
/// until the app quits.
const PENDING_TTL: std::time::Duration = std::time::Duration::from_mins(10);

static PENDING: Mutex<Option<HashMap<String, PendingSave>>> = Mutex::new(None);
/// One nonce per tab, so a fill from the chrome can prove itself to the page.
static NONCES: Mutex<Option<HashMap<TabId, String>>> = Mutex::new(None);

fn with_pending<T>(f: impl FnOnce(&mut HashMap<String, PendingSave>) -> T) -> T {
    let mut guard = PENDING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    f(guard.get_or_insert_with(HashMap::new))
}

fn nonce_for(tab: TabId) -> Option<String> {
    let guard = NONCES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    guard.as_ref().and_then(|m| m.get(&tab).cloned())
}

fn script(nonce: &str) -> String {
    crate::pagescript::build(
        "credentials.js",
        &[
            (
                "__NONCE__",
                serde_json::to_string(nonce).unwrap_or_else(|_| "null".into()),
            ),
            ("__BINDING__", BINDING.to_owned()),
        ],
    )
}

/// The profile a tab's page belongs to right now: its workspace's, or the
/// active profile's for a tab that lives in every workspace (essential).
/// Looked up per request, since a tab can change tier after it was set up.
pub fn profile_of_tab(app: &AppHandle<Runtime>, tab_id: TabId) -> Option<ProfileId> {
    let state = app.state::<AppState>();
    let store = crate::state::lock(&state.store);
    let workspace = store
        .tab(tab_id)
        .ok()
        .and_then(|t| t.workspace_id)
        .or(*crate::state::lock(&state.active_workspace))?;
    store.workspace(workspace).ok().map(|w| w.profile_id)
}

/// Install the script and binding on a tab and serve its requests.
pub async fn attach(app: AppHandle<Runtime>, tab_id: TabId, session: CdpSession) {
    let nonce = dive_core::TabId::new().to_string().replace('-', "");
    {
        let mut guard = NONCES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard
            .get_or_insert_with(HashMap::new)
            .insert(tab_id, nonce.clone());
    }
    let source = script(&nonce);
    let mut events = session.subscribe();
    let setup = async {
        session
            .call("Runtime.addBinding", json!({"name": BINDING}))
            .await?;
        session
            .call(
                "Page.addScriptToEvaluateOnNewDocument",
                json!({"source": source}),
            )
            .await?;
        let _ = session
            .call("Runtime.evaluate", json!({"expression": source}))
            .await;
        Ok::<(), dive_cdp::CdpError>(())
    };
    if let Err(error) = setup.await {
        crate::cdp_feed::setup_failed(tab_id, "saved logins", &error);
        return;
    }
    tauri::async_runtime::spawn(async move {
        while let Some(event) =
            crate::cdp_feed::next_event(&mut events, tab_id, "saved logins").await
        {
            let Some(payload) = binding_payload(&event, &nonce) else {
                continue;
            };
            // The site is whatever document actually called, never the `url`
            // its payload names: a page that learned the nonce could
            // otherwise ask for another site's logins by claiming its URL.
            let Some(origin) = caller_origin(&session, &event).await else {
                continue;
            };
            if let Err(error) = handle(&app, tab_id, &session, &nonce, &origin, payload).await {
                tracing::debug!(%tab_id, "saved logins request failed: {error}");
            }
        }
        let mut guard = NONCES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // A replacement view may already have set up its own nonce.
        if let Some(m) = guard.as_mut()
            && m.get(&tab_id) == Some(&nonce)
        {
            m.remove(&tab_id);
        }
        drop(guard);
        // Its submitted logins can no longer be answered from this tab.
        with_pending(|m| m.retain(|_, p| p.tab != tab_id));
    });
}

/// The parsed payload of a call to our binding carrying the right nonce.
pub fn binding_payload(event: &CdpEvent, nonce: &str) -> Option<Value> {
    if event.method != "Runtime.bindingCalled" || event.params["name"] != BINDING {
        return None;
    }
    let encoded = event.params["payload"].as_str()?;
    if encoded.len() > MAX_PAYLOAD {
        return None;
    }
    let payload: Value = serde_json::from_str(encoded).ok()?;
    (payload["nonce"].as_str() == Some(nonce)).then_some(payload)
}

/// The origin of the document that called the binding, asked of that very
/// execution context. `location` is unforgeable, so a page cannot answer for
/// another site; a context already gone (the page navigated) answers nothing.
async fn caller_origin(session: &CdpSession, event: &CdpEvent) -> Option<String> {
    let context = event.params["executionContextId"].as_i64()?;
    let result = session
        .call(
            "Runtime.evaluate",
            json!({"expression": "location.origin", "contextId": context, "returnByValue": true}),
        )
        .await
        .ok()?;
    crate::passwords::origin_of(result["result"]["value"].as_str()?).ok()
}

fn field(payload: &Value, key: &str) -> String {
    payload[key]
        .as_str()
        .unwrap_or_default()
        .chars()
        .take(MAX_FIELD)
        .collect()
}

async fn handle(
    app: &AppHandle<Runtime>,
    tab_id: TabId,
    session: &CdpSession,
    nonce: &str,
    origin: &str,
    payload: Value,
) -> AppResult<()> {
    let Some(profile) = profile_of_tab(app, tab_id) else {
        return Ok(());
    };
    let state = app.state::<AppState>();
    match payload["kind"].as_str().unwrap_or_default() {
        "query" => {
            let logins = crate::passwords::for_url(&state, profile, origin).unwrap_or_default();
            let list: Vec<Value> = logins
                .iter()
                .map(|c| json!({"id": c.id, "username": c.username}))
                .collect();
            offer(session, nonce, &list).await;
        }
        "fill" => {
            let id = field(&payload, "id");
            match fill(&state, session, nonce, profile, &id, Some(origin)).await {
                // Only forgetting it helps, and the page cannot say so:
                // ask the chrome to offer that.
                Err(error) if crate::passwords::is_missing_password(&error) => {
                    let login = crate::passwords::list(&state, profile)?
                        .into_iter()
                        .find(|c| c.id == id);
                    if let Some(login) = login {
                        let _ = CredentialPrompt {
                            tab_id,
                            kind: "missing".into(),
                            origin: origin.to_owned(),
                            username: login.username,
                            token: login.id,
                        }
                        .emit(app);
                    }
                }
                other => other?,
            }
        }
        "filled" => {
            let id = field(&payload, "id");
            let _ = crate::passwords::touch(&state, &id);
        }
        // A private window fills what it knows but never offers to keep a
        // login: its store is in memory and the Keychain is not.
        "submitted" if !crate::private_session::is_private() => {
            submitted(app, tab_id, profile, origin, &payload);
        }
        _ => {}
    }
    Ok(())
}

/// A login was submitted: note the use, or ask the chrome to save or
/// update it. The password waits in the host under a token.
fn submitted(
    app: &AppHandle<Runtime>,
    tab_id: TabId,
    profile: ProfileId,
    origin: &str,
    payload: &Value,
) {
    let state = app.state::<AppState>();

    // Saved usernames are trimmed, so an untrimmed one never matched its own
    // login and asked to save it again on every sign-in.
    let username = field(payload, "username").trim().to_owned();
    let password = field(payload, "password");
    // Without a username the save can only fail ("a login needs a
    // username"), after the password was already let go; a two-step sign-in
    // shows no username field on its password page.
    if password.is_empty() || username.is_empty() {
        return;
    }
    let url = origin.to_owned();
    let origin = url.clone();
    if crate::passwords::never_list(&state, profile)
        .unwrap_or_default()
        .contains(&origin)
    {
        return;
    }
    let known = crate::passwords::for_url(&state, profile, &url).unwrap_or_default();
    let same_user = known.iter().find(|c| c.username == username);
    let kind = match same_user {
        Some(c) => match crate::passwords::reveal(&state, profile, &c.id) {
            // Unchanged: nothing to ask, just note the use.
            Ok(saved) if saved == password => {
                let _ = crate::passwords::touch(&state, &c.id);
                return;
            }
            Ok(_) => "update",
            // The saved password is gone from the OS store: saving again
            // puts it back.
            Err(e) if crate::passwords::is_missing_password(&e) => "update",
            // A locked or refused Keychain says nothing about whether the
            // password changed; offering "Update" on every sign-in would
            // invite overwriting a good password.
            Err(_) => return,
        },
        None => "save",
    };
    let token = dive_core::TabId::new().to_string();
    with_pending(|m| {
        m.retain(|_, p| (p.url != url || p.username != username) && p.at.elapsed() < PENDING_TTL);
        m.insert(
            token.clone(),
            PendingSave {
                tab: tab_id,
                profile,
                url,
                username: username.clone(),
                password,
                at: std::time::Instant::now(),
            },
        );
    });
    let _ = CredentialPrompt {
        tab_id,
        kind: kind.into(),
        origin,
        username,
        token,
    }
    .emit(app);
}

async fn offer(session: &CdpSession, nonce: &str, list: &[Value]) {
    let expression = format!(
        "window.__diveCredentialsOffer && window.__diveCredentialsOffer({}, {})",
        serde_json::to_string(nonce).unwrap_or_default(),
        serde_json::to_string(list).unwrap_or_default()
    );
    let _ = session
        .call("Runtime.evaluate", json!({"expression": expression}))
        .await;
}

/// Put a saved login into the page, but only into a document of the site it
/// was saved for. `asked_by` is the origin of the document that asked, when
/// the page asked; a login for any other site is refused outright. The origin
/// is checked again inside the same evaluation that fills, so a page that
/// navigated in between never receives it.
async fn fill(
    state: &AppState,
    session: &CdpSession,
    nonce: &str,
    profile: ProfileId,
    id: &str,
    asked_by: Option<&str>,
) -> AppResult<()> {
    let login = crate::passwords::list(state, profile)?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| AppError::new("no such login"))?;
    if asked_by.is_some_and(|origin| origin != login.origin) {
        return Err(AppError::new("that login belongs to another site"));
    }
    let password = crate::passwords::reveal(state, profile, id)?;
    let expression = format!(
        "location.origin === {} && window.__diveCredentialsFill && window.__diveCredentialsFill({}, {})",
        serde_json::to_string(&login.origin).unwrap_or_default(),
        serde_json::to_string(nonce).unwrap_or_default(),
        json!({"id": login.id, "username": login.username, "password": password})
    );
    session
        .call("Runtime.evaluate", json!({"expression": expression}))
        .await
        .map_err(AppError::new)?;
    Ok(())
}

/// The chrome's answer to a save or update prompt.
pub fn answer(
    state: &AppState,
    token: &str,
    save: bool,
) -> AppResult<Option<dive_core::Credential>> {
    let Some(pending) = with_pending(|m| m.remove(token)) else {
        return Err(AppError::new("that prompt has already been answered"));
    };
    if pending.at.elapsed() >= PENDING_TTL {
        return Err(AppError::new(
            "that prompt has expired; sign in again to save the login",
        ));
    }
    if !save {
        return Ok(None);
    }
    crate::passwords::save(
        state,
        pending.profile,
        &pending.url,
        &pending.username,
        &pending.password,
    )
    .map(Some)
}

/// Let the submitted login go and stop asking for its site in this profile.
pub fn never(state: &AppState, token: &str) -> AppResult<String> {
    let Some(pending) = with_pending(|m| m.remove(token)) else {
        return Err(AppError::new("that prompt has already been answered"));
    };
    crate::passwords::never_add(state, pending.profile, &pending.url)
}

/// Fill a saved login into `tab` on the chrome's behalf. The page must be on
/// the login's own site; the check runs inside the evaluation that fills.
pub async fn fill_into(app: AppHandle<Runtime>, tab_id: TabId, id: String) -> AppResult<()> {
    let state = app.state::<AppState>();
    let session = crate::state::lock(&state.host)
        .as_ref()
        .and_then(|host| host.cdp(tab_id))
        .ok_or_else(|| AppError::new("that tab is gone"))?;
    let nonce = nonce_for(tab_id)
        .ok_or_else(|| AppError::new("saved logins are not set up on that tab"))?;
    let profile =
        profile_of_tab(&app, tab_id).ok_or_else(|| AppError::new("that tab has no profile"))?;
    fill(&state, &session, &nonce, profile, &id, None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(name: &str, payload: &str) -> CdpEvent {
        CdpEvent {
            navigation_epoch: 0,
            method: "Runtime.bindingCalled".into(),
            params: json!({"name": name, "payload": payload}),
        }
    }

    #[test]
    fn only_our_binding_with_the_right_nonce_gets_through() {
        let ok = event(
            BINDING,
            r#"{"nonce":"n1","kind":"query","url":"https://a.test/login"}"#,
        );
        assert_eq!(binding_payload(&ok, "n1").unwrap()["kind"], "query");
        assert!(binding_payload(&ok, "other").is_none());
        assert!(binding_payload(&event("__diveRecord", r#"{"nonce":"n1"}"#), "n1").is_none());
        assert!(binding_payload(&event(BINDING, "not json"), "n1").is_none());
        let big = format!(
            r#"{{"nonce":"n1","kind":"x","pad":"{}"}}"#,
            "a".repeat(MAX_PAYLOAD)
        );
        assert!(binding_payload(&event(BINDING, &big), "n1").is_none());
    }

    #[test]
    fn a_dismissed_prompt_forgets_the_password_and_cannot_be_answered_twice() {
        with_pending(|m| {
            m.insert(
                "t1".into(),
                PendingSave {
                    tab: TabId::new(),
                    profile: ProfileId::new(),
                    url: "https://a.test/".into(),
                    username: "u".into(),
                    password: "p".into(),
                    at: std::time::Instant::now(),
                },
            );
        });
        assert!(with_pending(|m| m.remove("t1")).is_some());
        assert!(with_pending(|m| m.remove("t1")).is_none());
    }
}
