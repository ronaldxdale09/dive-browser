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
    /// username has a different password, `pick` when several logins fit.
    pub kind: String,
    /// `scheme://host[:port]`.
    pub origin: String,
    /// The username submitted (save, update).
    pub username: String,
    /// Names the person can choose from (pick).
    pub usernames: Vec<String>,
    /// Handle for answering a save or update; the password stays in the host.
    pub token: String,
}

struct PendingSave {
    profile: ProfileId,
    url: String,
    username: String,
    password: String,
}

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
        tracing::warn!(%tab_id, "saved logins unavailable on this tab: {error}");
        return;
    }
    tauri::async_runtime::spawn(async move {
        while let Ok(event) = events.recv().await {
            let Some(payload) = binding_payload(&event, &nonce) else {
                continue;
            };
            if let Err(error) = handle(&app, tab_id, &session, &nonce, payload).await {
                tracing::debug!(%tab_id, "saved logins request failed: {error}");
            }
        }
        let mut guard = NONCES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(m) = guard.as_mut() {
            m.remove(&tab_id);
        }
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
    payload: Value,
) -> AppResult<()> {
    let Some(profile) = profile_of_tab(app, tab_id) else {
        return Ok(());
    };
    let state = app.state::<AppState>();
    match payload["kind"].as_str().unwrap_or_default() {
        "query" => {
            let url = field(&payload, "url");
            let logins = crate::passwords::for_url(&state, profile, &url).unwrap_or_default();
            let list: Vec<Value> = logins
                .iter()
                .map(|c| json!({"id": c.id, "username": c.username}))
                .collect();
            offer(session, nonce, &list).await;
        }
        "fill" => {
            let id = field(&payload, "id");
            fill(&state, session, nonce, profile, &id).await?;
        }
        "filled" => {
            let id = field(&payload, "id");
            let _ = crate::passwords::touch(&state, &id);
        }
        "pick" => {
            let usernames: Vec<String> = payload["usernames"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str())
                        .map(|s| s.chars().take(MAX_FIELD).collect())
                        .take(20)
                        .collect()
                })
                .unwrap_or_default();
            // Without a site the chrome could not look the logins up again.
            let Ok(origin) = crate::passwords::origin_of(&field(&payload, "url")) else {
                return Ok(());
            };
            let _ = CredentialPrompt {
                tab_id,
                kind: "pick".into(),
                origin,
                username: String::new(),
                usernames,
                token: String::new(),
            }
            .emit(app);
        }
        // A private window fills what it knows but never offers to keep a
        // login: its store is in memory and the Keychain is not.
        "submitted" if !crate::private_session::is_private() => {
            let url = field(&payload, "url");
            let username = field(&payload, "username");
            let password = field(&payload, "password");
            if password.is_empty() {
                return Ok(());
            }
            let origin = crate::passwords::origin_of(&url)?;
            let known = crate::passwords::for_url(&state, profile, &url).unwrap_or_default();
            let same_user = known.iter().find(|c| c.username == username);
            let kind = match same_user {
                Some(c) => {
                    // Unchanged: nothing to ask, just note the use.
                    if crate::passwords::reveal(&state, profile, &c.id)
                        .ok()
                        .as_deref()
                        == Some(password.as_str())
                    {
                        let _ = crate::passwords::touch(&state, &c.id);
                        return Ok(());
                    }
                    "update"
                }
                None => "save",
            };
            let token = dive_core::TabId::new().to_string();
            with_pending(|m| {
                m.retain(|_, p| p.url != url || p.username != username);
                m.insert(
                    token.clone(),
                    PendingSave {
                        profile,
                        url,
                        username: username.clone(),
                        password,
                    },
                );
            });
            let _ = CredentialPrompt {
                tab_id,
                kind: kind.into(),
                origin,
                username,
                usernames: Vec::new(),
                token,
            }
            .emit(app);
        }
        _ => {}
    }
    Ok(())
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

async fn fill(
    state: &AppState,
    session: &CdpSession,
    nonce: &str,
    profile: ProfileId,
    id: &str,
) -> AppResult<()> {
    let login = crate::passwords::list(state, profile)?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| AppError::new("no such login"))?;
    let password = crate::passwords::reveal(state, profile, id)?;
    let expression = format!(
        "window.__diveCredentialsFill && window.__diveCredentialsFill({}, {})",
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

/// Fill a chosen login into `tab`, for the pick prompt.
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
    fill(&state, &session, &nonce, profile, &id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(name: &str, payload: &str) -> CdpEvent {
        CdpEvent {
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
                    profile: ProfileId::new(),
                    url: "https://a.test/".into(),
                    username: "u".into(),
                    password: "p".into(),
                },
            );
        });
        assert!(with_pending(|m| m.remove("t1")).is_some());
        assert!(with_pending(|m| m.remove("t1")).is_none());
    }
}
