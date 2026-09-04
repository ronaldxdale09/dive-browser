//! Site permissions: camera, microphone, location, notifications, clipboard
//! reading and screen capture.
//!
//! The engine asks synchronously, so an origin with no remembered decision
//! is refused for now and the chrome is told to ask the person. Their
//! answer is stored per origin and kind, and the page gets it on its next
//! request (the prompt offers a reload).

use dive_cdp::CdpSession;
use dive_core::TabId;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use tauri::Manager;
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri_specta::Event;

use crate::Runtime;
use crate::state::{AppState, lock};

const PREFIX: &str = "perm:";
const BINDING: &str = "__divePermissionRequest";
const KINDS: &[&str] = &[
    "camera",
    "microphone",
    "geolocation",
    "notifications",
    "clipboard_read",
    "display_capture",
];

/// What the person decided for one origin and kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    /// Granted.
    Allow,
    /// Refused.
    Deny,
    /// Not decided; the engine refuses and the chrome asks.
    Ask,
}

impl Decision {
    fn parse(s: &str) -> Self {
        match s {
            "allow" => Self::Allow,
            "deny" => Self::Deny,
            _ => Self::Ask,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Deny => "deny",
            Self::Ask => "ask",
        }
    }
}

/// A remembered decision, for the settings UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SitePermission {
    /// Scheme and host the decision applies to.
    pub origin: String,
    /// `camera`, `microphone`, `geolocation`, `notifications`,
    /// `clipboard_read` or `display_capture`.
    pub kind: String,
    /// The decision.
    pub decision: Decision,
}

/// A page asked for something no decision covers yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct PermissionAsked {
    /// The tab whose page asked.
    pub tab_id: TabId,
    /// The page's origin.
    pub origin: String,
    /// What it asked for, as in [`SitePermission::kind`].
    pub kind: String,
}

/// The stable name of a permission kind, as stored and shown.
pub fn kind_name(kind: PermissionKind) -> &'static str {
    match kind {
        PermissionKind::Camera => "camera",
        PermissionKind::Microphone => "microphone",
        PermissionKind::Geolocation => "geolocation",
        PermissionKind::Notifications => "notifications",
        PermissionKind::ClipboardRead => "clipboard_read",
        PermissionKind::DisplayCapture => "display_capture",
        _ => "other",
    }
}

fn key(origin: &str, kind: &str) -> String {
    format!("{PREFIX}{origin}:{kind}")
}

/// Look up the decision for `origin` and `kind`.
pub fn decision(state: &AppState, origin: &str, kind: &str) -> Decision {
    lock(&state.store)
        .setting(&key(origin, kind))
        .ok()
        .flatten()
        .map_or(Decision::Ask, |v| Decision::parse(&v))
}

/// Remember (or, with `Ask`, forget) a decision.
pub fn set(
    state: &AppState,
    origin: &str,
    kind: &str,
    decision: Decision,
) -> dive_core::Result<()> {
    let store = lock(&state.store);
    match decision {
        Decision::Ask => store.remove_setting(&key(origin, kind)).map(|_| ()),
        d => store.set_setting(&key(origin, kind), d.as_str()),
    }
}

/// Every remembered decision.
pub fn all(state: &AppState) -> dive_core::Result<Vec<SitePermission>> {
    Ok(lock(&state.store)
        .settings_with_prefix(PREFIX)?
        .into_iter()
        .filter_map(|(k, v)| {
            let rest = k.strip_prefix(PREFIX)?;
            let (origin, kind) = rest.rsplit_once(':')?;
            Some(SitePermission {
                origin: origin.to_owned(),
                kind: kind.to_owned(),
                decision: Decision::parse(&v),
            })
        })
        .collect())
}

/// The engine's question for one webview: answer from memory, or refuse
/// and have the chrome ask.
pub fn decide(webview: &tauri::Webview<Runtime>, kind: PermissionKind) -> PermissionResponse {
    let Some(tab_id) = crate::engine::tab_from_label(webview.label()) else {
        // The chrome itself (clipboard reads for paste, for instance).
        return PermissionResponse::Allow;
    };
    let app = webview.app_handle();
    let state = app.state::<AppState>();
    let origin = {
        let store = lock(&state.store);
        store
            .tab(tab_id)
            .ok()
            .and_then(|t| dive_core::origin_of(&t.url))
    };
    let Some(origin) = origin else {
        return PermissionResponse::Deny;
    };
    let name = kind_name(kind);
    match decision(&state, &origin, name) {
        Decision::Allow => PermissionResponse::Allow,
        Decision::Deny => PermissionResponse::Deny,
        Decision::Ask => {
            let _ = PermissionAsked {
                tab_id,
                origin,
                kind: name.to_owned(),
            }
            .emit(app);
            PermissionResponse::Deny
        }
    }
}

fn cdp_name(kind: &str) -> Option<&'static str> {
    match kind {
        "camera" => Some("camera"),
        "microphone" => Some("microphone"),
        "geolocation" => Some("geolocation"),
        "notifications" => Some("notifications"),
        "clipboard_read" => Some("clipboard-read"),
        "display_capture" => Some("display-capture"),
        _ => None,
    }
}

fn cdp_setting(decision: Decision) -> &'static str {
    match decision {
        Decision::Allow => "granted",
        Decision::Deny | Decision::Ask => "denied",
    }
}

fn cdp_params(origin: &str, kind: &str, choice: Decision) -> Option<serde_json::Value> {
    Some(json!({
        "permission": {"name": cdp_name(kind)?},
        "setting": cdp_setting(choice),
        "origin": origin,
    }))
}

/// Apply all remembered decisions for one origin through Chromium's native
/// permission policy. Undecided capabilities fail closed until the user acts.
pub async fn apply_origin(state: &AppState, session: &CdpSession, origin: &str) {
    for kind in KINDS {
        let Some(params) = cdp_params(origin, kind, decision(state, origin, kind)) else {
            continue;
        };
        if let Err(error) = session.call("Browser.setPermission", params).await {
            tracing::debug!(%origin, %kind, %error, "applying browser permission failed");
        }
    }
}

#[derive(Deserialize)]
struct BindingRequest {
    nonce: String,
    id: u64,
    kind: String,
}

fn binding_request(event: &dive_cdp::CdpEvent, nonce: &str) -> Option<(BindingRequest, i64)> {
    if event.method != "Runtime.bindingCalled" || event.params["name"].as_str() != Some(BINDING) {
        return None;
    }
    let request: BindingRequest = serde_json::from_str(event.params["payload"].as_str()?).ok()?;
    if request.nonce != nonce || !KINDS.contains(&request.kind.as_str()) {
        return None;
    }
    Some((request, event.params["executionContextId"].as_i64()?))
}

/// Install the media-attempt reporter and keep permission policy synchronized
/// as the main frame moves between origins.
pub async fn attach_page(app: tauri::AppHandle<Runtime>, tab_id: TabId, session: CdpSession) {
    let mut events = session.subscribe();
    let nonce = TabId::new().to_string().replace('-', "");
    let script = crate::pagescript::build(
        "media-guard.js",
        &[
            (
                "__NONCE__",
                serde_json::to_string(&nonce).unwrap_or_else(|_| "null".into()),
            ),
            ("__BINDING__", BINDING.to_owned()),
        ],
    );
    for (method, params) in [
        ("Runtime.enable", json!({})),
        ("Page.enable", json!({})),
        ("Runtime.addBinding", json!({"name": BINDING})),
        (
            "Page.addScriptToEvaluateOnNewDocument",
            json!({"source": script}),
        ),
        ("Runtime.evaluate", json!({"expression": script})),
    ] {
        match session.call(method, params).await {
            Ok(_) => tracing::debug!(%tab_id, %method, "permission page setup step complete"),
            Err(error) => {
                tracing::warn!(%tab_id, %method, %error, "permission page setup step failed");
            }
        }
    }
    tracing::debug!(%tab_id, "permission page setup complete");

    tauri::async_runtime::spawn(async move {
        while let Ok(event) = events.recv().await {
            if let Some((request, context_id)) = binding_request(&event, &nonce) {
                let origin = session.call("Runtime.evaluate", json!({"expression": "location.origin", "contextId": context_id, "returnByValue": true})).await
                    .ok().and_then(|result| result["result"]["value"].as_str().map(str::to_owned));
                let allowed = if let Some(origin) = origin {
                    let state = app.state::<AppState>();
                    let choice = decision(&state, &origin, &request.kind);
                    if choice == Decision::Ask {
                        let _ = PermissionAsked {
                            tab_id,
                            origin: origin.clone(),
                            kind: request.kind.clone(),
                        }
                        .emit(&app);
                    }
                    apply_origin(&state, &session, &origin).await;
                    choice == Decision::Allow
                } else {
                    false
                };
                let expression = format!(
                    "window.__divePermissionResolve({}, {})",
                    request.id,
                    if allowed { "true" } else { "false" }
                );
                let _ = session
                    .call(
                        "Runtime.evaluate",
                        json!({"expression": expression, "contextId": context_id}),
                    )
                    .await;
            }
            if event.method == "Page.frameNavigated"
                && event.params["frame"]["parentId"].is_null()
                && let Some(url) = event.params["frame"]["url"].as_str()
                && let Some(origin) = dive_core::origin_of(url)
            {
                apply_origin(&app.state::<AppState>(), &session, &origin).await;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decisions_round_trip_through_their_text_form() {
        for d in [Decision::Allow, Decision::Deny, Decision::Ask] {
            assert_eq!(Decision::parse(d.as_str()), d);
        }
        assert_eq!(Decision::parse("nonsense"), Decision::Ask);
    }

    #[test]
    fn keys_keep_origin_and_kind_apart() {
        let k = key("https://a.dev:8080", "camera");
        assert_eq!(k, "perm:https://a.dev:8080:camera");
        let rest = k.strip_prefix(PREFIX).unwrap();
        let (origin, kind) = rest.rsplit_once(':').unwrap();
        assert_eq!((origin, kind), ("https://a.dev:8080", "camera"));
    }

    #[test]
    fn every_kind_has_a_name() {
        assert_eq!(kind_name(PermissionKind::Camera), "camera");
        assert_eq!(kind_name(PermissionKind::DisplayCapture), "display_capture");
    }

    #[test]
    fn undecided_permissions_fail_closed_in_chromium() {
        assert_eq!(cdp_setting(Decision::Ask), "denied");
        assert_eq!(cdp_setting(Decision::Deny), "denied");
        assert_eq!(cdp_setting(Decision::Allow), "granted");
        assert_eq!(cdp_name("camera"), Some("camera"));
        assert_eq!(cdp_name("microphone"), Some("microphone"));
        assert_eq!(cdp_name("unknown"), None);
        assert_eq!(
            cdp_params("https://example.com", "camera", Decision::Allow).unwrap(),
            json!({"permission": {"name": "camera"}, "setting": "granted", "origin": "https://example.com"})
        );
    }

    #[test]
    fn recognizes_only_authenticated_media_binding_messages() {
        let event = dive_cdp::CdpEvent {
            method: "Runtime.bindingCalled".into(),
            params: json!({"name": BINDING, "payload":"{\"nonce\":\"n\",\"id\":7,\"kind\":\"camera\"}", "executionContextId": 3}),
        };
        let (request, context) = binding_request(&event, "n").unwrap();
        assert_eq!(
            (request.id, request.kind.as_str(), context),
            (7, "camera", 3)
        );
        assert!(binding_request(&event, "wrong").is_none());
        let forged = dive_cdp::CdpEvent {
            method: event.method.clone(),
            params: json!({"name": BINDING, "payload":"{\"nonce\":\"n\",\"id\":7,\"kind\":\"filesystem\"}", "executionContextId": 3}),
        };
        assert!(binding_request(&forged, "n").is_none());
    }
}
