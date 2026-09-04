//! Site permissions: camera, microphone, location, notifications, clipboard
//! reading and screen capture.
//!
//! The engine asks synchronously, so an origin with no remembered decision
//! is refused for now and the chrome is told to ask the person. Their
//! answer is stored per origin and kind, and the page gets it on its next
//! request (the prompt offers a reload).

use dive_core::TabId;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Manager;
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri_specta::Event;

use crate::Runtime;
use crate::state::{AppState, lock};

const PREFIX: &str = "perm:";

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
}
