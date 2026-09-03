//! Whether a tab's main frame is loading, and why a navigation failed.
//!
//! The chrome shows a progress line while a page loads and a friendly error
//! page when the document itself could not be fetched; both come from here.

use std::sync::Mutex;

use dive_cdp::{CdpEvent, CdpSession};
use dive_core::TabId;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;

use crate::Runtime;

/// Where a tab's main-frame navigation stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum LoadPhase {
    /// The main frame started loading a document.
    Started,
    /// The main frame finished, successfully or not.
    Stopped,
    /// The document request itself failed (DNS, refused, offline).
    Failed,
}

/// A change in a tab's loading state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct TabLoad {
    /// The tab.
    pub tab_id: TabId,
    /// What happened.
    pub phase: LoadPhase,
    /// The URL involved, when the engine reported one.
    pub url: Option<String>,
    /// Chromium's error text for `Failed`, e.g. `net::ERR_NAME_NOT_RESOLVED`.
    pub error: Option<String>,
}

/// Which frame is the main one, learned from the first navigation.
#[derive(Default)]
pub struct MainFrame {
    id: Mutex<Option<String>>,
    url: Mutex<Option<String>>,
}

impl MainFrame {
    fn is_main(&self, frame_id: &str) -> bool {
        let mut id = self
            .id
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(known) = id.as_deref() {
            known == frame_id
        } else {
            // The first frame we hear about is the main frame; subframes
            // cannot start before it exists.
            *id = Some(frame_id.to_owned());
            true
        }
    }

    fn note(&self, frame_id: &str, url: Option<&str>) {
        *self
            .id
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(frame_id.to_owned());
        if let Some(url) = url {
            *self
                .url
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(url.to_owned());
        }
    }

    fn url(&self) -> Option<String> {
        self.url
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

/// Map one `DevTools` event to a load-state change, tracking the main frame.
pub fn map_event(tab_id: TabId, event: &CdpEvent, main: &MainFrame) -> Option<TabLoad> {
    let p = &event.params;
    match event.method.as_str() {
        "Page.frameNavigated" => {
            let frame = p.get("frame")?;
            if frame.get("parentId").and_then(|v| v.as_str()).is_some() {
                return None;
            }
            main.note(
                frame.get("id")?.as_str()?,
                frame.get("url").and_then(|u| u.as_str()),
            );
            None
        }
        "Page.frameStartedLoading" => {
            let frame = p.get("frameId")?.as_str()?;
            main.is_main(frame).then(|| TabLoad {
                tab_id,
                phase: LoadPhase::Started,
                url: main.url(),
                error: None,
            })
        }
        "Page.frameStoppedLoading" => {
            let frame = p.get("frameId")?.as_str()?;
            main.is_main(frame).then(|| TabLoad {
                tab_id,
                phase: LoadPhase::Stopped,
                url: main.url(),
                error: None,
            })
        }
        "Network.loadingFailed" => {
            if p.get("type").and_then(|t| t.as_str()) != Some("Document") {
                return None;
            }
            if p.get("canceled").and_then(serde_json::Value::as_bool) == Some(true) {
                return None;
            }
            let error = p.get("errorText")?.as_str()?;
            // Aborted navigations (a new one superseded this) are not errors.
            if error == "net::ERR_ABORTED" {
                return None;
            }
            Some(TabLoad {
                tab_id,
                phase: LoadPhase::Failed,
                url: main.url(),
                error: Some(error.to_owned()),
            })
        }
        _ => None,
    }
}

/// Follow the tab's main-frame loading state and tell the chrome.
pub fn attach(
    app: AppHandle<Runtime>,
    tab_id: TabId,
    session: CdpSession,
) -> crate::cdp_feed::Ready {
    let main = MainFrame::default();
    crate::cdp_feed::attach(
        app,
        tab_id,
        session,
        &["Page.enable"],
        move |tab, event| map_event(tab, event, &main),
        |_, _| {},
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(method: &str, params: serde_json::Value) -> CdpEvent {
        CdpEvent {
            method: method.into(),
            params,
        }
    }

    #[test]
    fn main_frame_loading_is_reported_and_subframes_are_ignored() {
        let main = MainFrame::default();
        let tab = TabId::new();
        main.note("F1", Some("https://a.dev/"));
        let started = map_event(
            tab,
            &ev("Page.frameStartedLoading", json!({"frameId": "F1"})),
            &main,
        )
        .unwrap();
        assert_eq!(started.phase, LoadPhase::Started);
        assert_eq!(started.url.as_deref(), Some("https://a.dev/"));
        assert!(
            map_event(
                tab,
                &ev("Page.frameStartedLoading", json!({"frameId": "iframe-9"})),
                &main
            )
            .is_none()
        );
        let stopped = map_event(
            tab,
            &ev("Page.frameStoppedLoading", json!({"frameId": "F1"})),
            &main,
        )
        .unwrap();
        assert_eq!(stopped.phase, LoadPhase::Stopped);
    }

    #[test]
    fn the_first_frame_seen_becomes_the_main_frame() {
        let main = MainFrame::default();
        let tab = TabId::new();
        assert!(
            map_event(
                tab,
                &ev("Page.frameStartedLoading", json!({"frameId": "X"})),
                &main
            )
            .is_some()
        );
        assert!(
            map_event(
                tab,
                &ev("Page.frameStartedLoading", json!({"frameId": "Y"})),
                &main
            )
            .is_none()
        );
    }

    #[test]
    fn only_document_failures_count_and_aborts_do_not() {
        let main = MainFrame::default();
        let tab = TabId::new();
        let failed = map_event(
            tab,
            &ev("Network.loadingFailed", json!({"requestId": "1", "type": "Document", "errorText": "net::ERR_NAME_NOT_RESOLVED"})),
            &main,
        )
        .unwrap();
        assert_eq!(failed.phase, LoadPhase::Failed);
        assert_eq!(failed.error.as_deref(), Some("net::ERR_NAME_NOT_RESOLVED"));
        assert!(
            map_event(
                tab,
                &ev(
                    "Network.loadingFailed",
                    json!({"type": "Image", "errorText": "net::ERR_FAILED"})
                ),
                &main
            )
            .is_none()
        );
        assert!(
            map_event(
                tab,
                &ev(
                    "Network.loadingFailed",
                    json!({"type": "Document", "errorText": "net::ERR_ABORTED"})
                ),
                &main
            )
            .is_none()
        );
        assert!(
            map_event(
                tab,
                &ev(
                    "Network.loadingFailed",
                    json!({"type": "Document", "errorText": "x", "canceled": true})
                ),
                &main
            )
            .is_none()
        );
    }
}
