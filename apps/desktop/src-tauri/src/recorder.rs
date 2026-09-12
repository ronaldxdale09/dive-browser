//! Record the person's own clicks and typing in a tab as steps with
//! accessibility-style locators, so a manual flow can become a Playwright
//! test or a macro. A small script in the page reports events through a
//! CDP binding; this module turns them into steps.

use dive_cdp::{CdpEvent, CdpSession};
use dive_core::TabId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::Runtime;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Name of the binding the page script calls.
const BINDING: &str = "__diveRecord";
const MAX_FIELD: usize = 4 * 1024;
const MAX_BINDING_PAYLOAD: usize = 1024 * 1024;

/// One recorded interaction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct RecordedStep {
    /// `click` | `type` | `navigate`.
    pub kind: String,
    /// ARIA role of the target.
    pub role: String,
    /// Accessible name of the target.
    pub name: String,
    /// Typed text for `type`; URL for `navigate`.
    pub value: String,
    /// Milliseconds since the epoch.
    pub at: f64,
    /// The value was a secret (password, card, one-time code) and was not recorded.
    #[serde(default)]
    pub masked: bool,
}

/// Emitted to the chrome for each recorded step.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct RecorderEvent {
    /// Tab being recorded.
    pub tab_id: TabId,
    /// The step.
    pub step: RecordedStep,
}

/// Build the page-side recorder from `inject/recorder.js`.
///
/// The nonce is embedded as a JSON string literal: it is the only thing
/// stopping a page from calling the binding itself and forging steps into
/// someone's recording.
fn script(nonce: &str) -> String {
    crate::pagescript::build(
        "recorder.js",
        &[
            (
                "__NONCE__",
                serde_json::to_string(nonce).unwrap_or_else(|_| "null".into()),
            ),
            ("__BINDING__", BINDING.to_owned()),
            ("__MAX_FIELD__", MAX_FIELD.to_string()),
        ],
    )
}

/// Install the binding and script, and forward events while recording.
pub async fn start(app: AppHandle<Runtime>, tab_id: TabId, session: CdpSession) -> AppResult<()> {
    let state = app.state::<AppState>();
    let _pending = state.activity.pending(tab_id);
    if state.buffers.is_recording(tab_id) {
        return Err(AppError::new("already recording this tab"));
    }
    let nonce = dive_core::TabId::new().to_string().replace('-', "");
    let script = script(&nonce);
    // Subscribe before setup calls: a fast navigation or interaction between
    // injection and task startup must not disappear from the recording.
    let mut events = session.subscribe();
    session
        .call("Runtime.addBinding", json!({"name": BINDING}))
        .await
        .map_err(AppError::new)?;
    session
        .call("Page.enable", json!({}))
        .await
        .map_err(AppError::new)?;
    let registered = session
        .call(
            "Page.addScriptToEvaluateOnNewDocument",
            json!({"source": script}),
        )
        .await
        .map_err(AppError::new)?;
    let script_id = registered["identifier"]
        .as_str()
        .ok_or_else(|| AppError::new("CDP did not return a recorder script identifier"))?
        .to_owned();
    if let Err(error) = session
        .call("Runtime.evaluate", json!({"expression": script}))
        .await
    {
        let _ = session
            .call(
                "Page.removeScriptToEvaluateOnNewDocument",
                json!({"identifier": script_id}),
            )
            .await;
        return Err(AppError::new(error));
    }
    state.buffers.set_recording(tab_id, Some(Vec::new()));
    state
        .buffers
        .set_recording_nonce(tab_id, Some(nonce.clone()));
    state
        .buffers
        .set_recording_script_id(tab_id, Some(script_id));

    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => {
                    let state = app.state::<AppState>();
                    if !state.buffers.is_recording(tab_id) {
                        break;
                    }
                    if let Some(step) = map_event(&event, &nonce) {
                        state.buffers.push_recorded(tab_id, step.clone());
                        let _ = RecorderEvent { tab_id, step }.emit(&app);
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(%tab_id, n, "recorder missed CDP events");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    Ok(())
}

/// Stop page-side recording and remove the bootstrap registered for later
/// documents. Cleanup is best effort because the tab may already be closing.
pub async fn stop(session: CdpSession, script_id: Option<String>) {
    let _ = session
        .call(
            "Runtime.evaluate",
            json!({"expression": "window.__diveRecorderNonce = null"}),
        )
        .await;
    if let Some(identifier) = script_id {
        let _ = session
            .call(
                "Page.removeScriptToEvaluateOnNewDocument",
                json!({"identifier": identifier}),
            )
            .await;
    }
}

/// A `Runtime.bindingCalled` for our binding carrying the right nonce, or a
/// main-frame navigation.
pub fn map_event(event: &CdpEvent, nonce: &str) -> Option<RecordedStep> {
    match event.method.as_str() {
        "Runtime.bindingCalled" if event.params["name"] == BINDING => {
            let encoded = event.params["payload"].as_str()?;
            if encoded.len() > MAX_BINDING_PAYLOAD {
                return None;
            }
            let payload: Value = serde_json::from_str(encoded).ok()?;
            if payload["nonce"].as_str() != Some(nonce) {
                return None;
            }
            let kind = payload["kind"].as_str()?;
            if !matches!(kind, "click" | "type") {
                return None;
            }
            Some(RecordedStep {
                kind: kind.to_owned(),
                role: payload["role"]
                    .as_str()
                    .unwrap_or_default()
                    .chars()
                    .take(64)
                    .collect(),
                name: payload["name"]
                    .as_str()
                    .unwrap_or_default()
                    .chars()
                    .take(256)
                    .collect(),
                value: payload["value"]
                    .as_str()
                    .unwrap_or_default()
                    .chars()
                    .take(MAX_FIELD)
                    .collect(),
                at: payload["at"].as_f64().unwrap_or_default(),
                masked: payload["masked"].as_bool().unwrap_or(false),
            })
        }
        "Page.frameNavigated" if event.params["frame"]["parentId"].is_null() => {
            Some(RecordedStep {
                kind: "navigate".into(),
                role: String::new(),
                name: String::new(),
                value: event.params["frame"]["url"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                at: 0.0,
                masked: false,
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_binding_and_navigation_events() {
        let click = json!({"name": BINDING, "payload": "{\"kind\":\"click\",\"role\":\"button\",\"name\":\"Save\",\"value\":\"\",\"at\":5,\"nonce\":\"n1\"}"});
        let ev = CdpEvent {
            navigation_epoch: 0,
            method: "Runtime.bindingCalled".into(),
            params: click,
        };
        let s = map_event(&ev, "n1").unwrap();
        assert_eq!(
            (s.kind.as_str(), s.role.as_str(), s.name.as_str()),
            ("click", "button", "Save")
        );
        assert!(
            map_event(&ev, "other").is_none(),
            "forged payloads without the nonce are ignored"
        );
        let other = CdpEvent {
            navigation_epoch: 0,
            method: "Runtime.bindingCalled".into(),
            params: json!({"name": "other", "payload": "{}"}),
        };
        assert!(map_event(&other, "n1").is_none());
        let nav = CdpEvent {
            navigation_epoch: 0,
            method: "Page.frameNavigated".into(),
            params: json!({"frame": {"id": "1", "url": "https://a.dev/x"}}),
        };
        assert_eq!(map_event(&nav, "n1").unwrap().value, "https://a.dev/x");
        let child = CdpEvent {
            navigation_epoch: 0,
            method: "Page.frameNavigated".into(),
            params: json!({"frame": {"id": "2", "parentId": "1", "url": "https://ad.example"}}),
        };
        assert!(map_event(&child, "n1").is_none());
        let masked = json!({"name": BINDING, "payload": "{\"kind\":\"type\",\"role\":\"textbox\",\"name\":\"Password\",\"value\":\"\",\"masked\":true,\"at\":5,\"nonce\":\"n1\"}"});
        let step = map_event(
            &CdpEvent {
                navigation_epoch: 0,
                method: "Runtime.bindingCalled".into(),
                params: masked,
            },
            "n1",
        )
        .unwrap();
        assert!(step.masked && step.value.is_empty());
        let huge = json!({"name": BINDING, "payload": format!("{{\"kind\":\"type\",\"value\":\"{}\",\"nonce\":\"n1\"}}", "x".repeat(MAX_FIELD + 10))});
        let step = map_event(
            &CdpEvent {
                navigation_epoch: 0,
                method: "Runtime.bindingCalled".into(),
                params: huge,
            },
            "n1",
        )
        .unwrap();
        assert_eq!(step.value.len(), MAX_FIELD);

        let oversized = CdpEvent {
            navigation_epoch: 0,
            method: "Runtime.bindingCalled".into(),
            params: json!({"name": BINDING, "payload": "x".repeat(MAX_BINDING_PAYLOAD + 1)}),
        };
        assert!(map_event(&oversized, "n1").is_none());
    }

    #[test]
    fn recorder_script_can_be_restarted_and_disabled() {
        let script = script("n1");
        let nonce_assignment = script
            .find("window.__diveRecorderNonce = NONCE")
            .expect("script assigns the new nonce");
        let installed_guard = script
            .find("if (window.__diveRecorderInstalled) return")
            .expect("script installs listeners once");
        assert!(nonce_assignment < installed_guard);
        assert!(script.contains("if (!nonce) return"));
    }

    #[test]
    fn recorder_script_shares_the_locator_role_rules() {
        // Recorded steps are replayed as role/name locators, so both sides
        // have to compute the role the same way.
        let script = script("n1");
        assert!(
            script.contains("const roleOf ="),
            "role helper not composed in"
        );
        assert!(
            script.contains("const nameOf ="),
            "name helper not composed in"
        );
        assert!(
            script.contains("INTERACTIVE.has(roleOf(el))"),
            "landmarks and list items must not be recorded as clicks"
        );
    }

    #[test]
    fn recorder_script_embeds_the_nonce_as_a_json_string() {
        // The nonce reaches the page through a JS literal; anything that
        // escapes the quotes would let a page forge steps.
        let script = script("ab\"cd");
        assert!(script.contains(r#"const NONCE = "ab\"cd";"#), "{script}");
    }
}
