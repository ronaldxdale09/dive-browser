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

/// Main-frame identity and the current document request, never inferred from
/// whichever frame happens to emit an event first.
#[derive(Default)]
pub struct MainFrame {
    state: Mutex<Navigation>,
}

#[derive(Default)]
struct Navigation {
    id: Option<String>,
    url: Option<String>,
    request: Option<DocumentRequest>,
}

struct DocumentRequest {
    id: String,
    url: String,
}

impl Navigation {
    fn note(&mut self, id: &str, url: Option<&str>) {
        if self.id.as_deref() != Some(id) {
            self.request = None;
        }
        self.id = Some(id.to_owned());
        if let Some(url) = url {
            self.url = Some(url.to_owned());
        }
    }

    fn is_main(&self, id: &str) -> bool {
        self.id.as_deref() == Some(id)
    }
}

impl MainFrame {
    fn history_changed(&self, event: &CdpEvent) -> bool {
        let navigation = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match event.method.as_str() {
            "Page.frameNavigated" => event.params.get("frame").is_some_and(|frame| {
                frame.get("parentId").is_none()
                    && frame
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|id| navigation.is_main(id))
            }),
            "Page.navigatedWithinDocument" | "Page.frameStoppedLoading" => event
                .params
                .get("frameId")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|id| navigation.is_main(id)),
            _ => false,
        }
    }

    fn note(&self, id: &str, url: Option<&str>) {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .note(id, url);
    }

    fn forget_request(&self) {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .request = None;
    }
}

/// Map one `DevTools` event to a main-frame load-state change. Only the latest
/// proven main document request can produce a navigation error.
pub fn map_event(tab_id: TabId, event: &CdpEvent, main: &MainFrame) -> Option<TabLoad> {
    let p = &event.params;
    let mut navigation = main
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    match event.method.as_str() {
        "Page.frameNavigated" => {
            let frame = p.get("frame")?;
            if frame
                .get("parentId")
                .and_then(serde_json::Value::as_str)
                .is_some()
            {
                return None;
            }
            navigation.note(
                frame.get("id")?.as_str()?,
                frame.get("url").and_then(serde_json::Value::as_str),
            );
            None
        }
        "Page.navigatedWithinDocument" => {
            if navigation.is_main(p.get("frameId")?.as_str()?) {
                navigation.url = Some(p.get("url")?.as_str()?.to_owned());
            }
            None
        }
        "Page.frameStartedLoading" | "Page.frameStoppedLoading" => navigation
            .is_main(p.get("frameId")?.as_str()?)
            .then(|| TabLoad {
                tab_id,
                phase: if event.method == "Page.frameStartedLoading" {
                    LoadPhase::Started
                } else {
                    LoadPhase::Stopped
                },
                url: navigation.url.clone(),
                error: None,
            }),
        "Network.requestWillBeSent" => {
            if p.get("type")?.as_str()? != "Document"
                || !navigation.is_main(p.get("frameId")?.as_str()?)
            {
                return None;
            }
            let request = DocumentRequest {
                id: p.get("requestId")?.as_str()?.to_owned(),
                url: p.get("request")?.get("url")?.as_str()?.to_owned(),
            };
            let url = request.url.clone();
            // Redirects reuse the request ID; a superseding navigation replaces
            // it. Either way, error UI must describe the requested URL.
            navigation.request = Some(request);
            Some(TabLoad {
                tab_id,
                phase: LoadPhase::Started,
                url: Some(url),
                error: None,
            })
        }
        "Network.loadingFinished" => {
            if navigation.request.as_ref().is_some_and(|request| {
                Some(request.id.as_str()) == p.get("requestId").and_then(serde_json::Value::as_str)
            }) {
                navigation.request = None;
            }
            None
        }
        "Network.loadingFailed" => {
            if p.get("type")?.as_str()? != "Document" {
                return None;
            }
            let id = p.get("requestId")?.as_str()?;
            if navigation
                .request
                .as_ref()
                .is_none_or(|request| request.id != id)
            {
                return None;
            }
            let request = navigation.request.take()?;
            if p.get("canceled").and_then(serde_json::Value::as_bool) == Some(true) {
                return None;
            }
            let error = p.get("errorText")?.as_str()?;
            if error == "net::ERR_ABORTED" {
                return None;
            }
            Some(TabLoad {
                tab_id,
                phase: LoadPhase::Failed,
                url: Some(request.url),
                error: Some(error.to_owned()),
            })
        }
        _ => None,
    }
}

async fn refresh_main(session: &CdpSession, main: &MainFrame) {
    match session.call0("Page.getFrameTree").await {
        Ok(tree) => {
            let frame = &tree["frameTree"]["frame"];
            if let Some(id) = frame["id"].as_str() {
                main.note(id, frame["url"].as_str());
            }
        }
        Err(error) => tracing::warn!(%error, "could not establish main-frame identity"),
    }
}

/// Establish main-frame identity before the first navigation, then follow its
/// loading state. A lagged stream clears the in-flight correlation rather than
/// inventing an error from an unmatched document failure.
pub fn attach(
    app: AppHandle<Runtime>,
    tab_id: TabId,
    session: CdpSession,
) -> crate::cdp_feed::Ready {
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let main = MainFrame::default();
        let mut events = session.subscribe();
        if let Err(error) = session.call0("Page.enable").await {
            tracing::warn!(%tab_id, %error, "loading page feed setup failed");
        }
        if let Err(error) = crate::network::enable(&session).await {
            tracing::warn!(%tab_id, %error, "loading network feed setup failed");
        }
        refresh_main(&session, &main).await;
        let _ = ready_tx.send(());
        loop {
            match events.recv().await {
                Ok(event) => {
                    if let Some(load) = map_event(tab_id, &event, &main)
                        && let Err(error) = load.emit(&app)
                    {
                        tracing::warn!(%tab_id, %error, "loading event emit failed");
                    }
                    if main.history_changed(&event) {
                        let _ = crate::navigation::TabHistoryChanged { tab_id }.emit(&app);
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                    tracing::warn!(%tab_id, missed, "loading feed lagged; resetting request correlation");
                    main.forget_request();
                    refresh_main(&session, &main).await;
                    let _ = crate::navigation::TabHistoryChanged { tab_id }.emit(&app);
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    ready_rx
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn history_refreshes_include_same_url_push_state_but_not_subframes() {
        let main = MainFrame::default();
        main.note("root", Some("https://example.com"));
        assert!(main.history_changed(&ev(
            "Page.navigatedWithinDocument",
            json!({"frameId":"root", "url":"https://example.com"})
        )));
        assert!(!main.history_changed(&ev(
            "Page.navigatedWithinDocument",
            json!({"frameId":"child", "url":"https://example.com"})
        )));
        assert!(!main.history_changed(&ev(
            "Page.frameNavigated",
            json!({"frame":{"id":"child","parentId":"root"}})
        )));
        assert!(main.history_changed(&ev("Page.frameStoppedLoading", json!({"frameId":"root"}))));
    }

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
    fn root_navigation_establishes_identity_while_child_navigation_does_not() {
        let main = MainFrame::default();
        let tab = TabId::new();
        map_event(
            tab,
            &ev(
                "Page.frameNavigated",
                json!({"frame": {"id": "child", "parentId": "root", "url": "https://child.test/"}}),
            ),
            &main,
        );
        assert!(
            map_event(
                tab,
                &ev("Page.frameStartedLoading", json!({"frameId": "child"})),
                &main
            )
            .is_none()
        );
        map_event(
            tab,
            &ev(
                "Page.frameNavigated",
                json!({"frame": {"id": "root", "url": "https://root.test/"}}),
            ),
            &main,
        );
        assert!(
            map_event(
                tab,
                &ev("Page.frameStartedLoading", json!({"frameId": "root"})),
                &main
            )
            .is_some()
        );
    }

    #[test]
    fn failed_iframe_does_not_replace_the_main_page_with_an_error() {
        let main = MainFrame::default();
        let tab = TabId::new();
        main.note("main", Some("https://page.test/"));
        map_event(
            tab,
            &ev(
                "Network.requestWillBeSent",
                json!({
                    "requestId": "child-request", "frameId": "child", "type": "Document",
                    "request": {"url": "https://iframe.test/"}
                }),
            ),
            &main,
        );
        assert!(map_event(tab, &ev("Network.loadingFailed", json!({
            "requestId": "child-request", "type": "Document", "errorText": "net::ERR_CONNECTION_REFUSED"
        })), &main).is_none());
    }

    #[test]
    fn unproven_frame_is_not_assumed_to_be_the_main_frame() {
        let main = MainFrame::default();
        assert!(
            map_event(
                TabId::new(),
                &ev(
                    "Page.frameStartedLoading",
                    json!({
                        "frameId": "already-loading-child"
                    })
                ),
                &main
            )
            .is_none()
        );
    }

    #[test]
    fn only_the_current_main_request_can_fail_and_its_url_is_reported() {
        let main = MainFrame::default();
        let tab = TabId::new();
        main.note("main", Some("https://old.test/"));
        for (request, url) in [
            ("old", "https://old-request.test/"),
            ("current", "https://new.test/"),
        ] {
            map_event(
                tab,
                &ev(
                    "Network.requestWillBeSent",
                    json!({
                        "requestId": request, "frameId": "main", "type": "Document", "request": {"url": url}
                    }),
                ),
                &main,
            );
        }
        assert!(
            map_event(
                tab,
                &ev(
                    "Network.loadingFailed",
                    json!({
                        "requestId": "old", "type": "Document", "errorText": "net::ERR_FAILED"
                    })
                ),
                &main
            )
            .is_none()
        );
        let failure = map_event(tab, &ev("Network.loadingFailed", json!({
            "requestId": "current", "type": "Document", "errorText": "net::ERR_NAME_NOT_RESOLVED"
        })), &main).unwrap();
        assert_eq!(failure.url.as_deref(), Some("https://new.test/"));
        assert!(map_event(tab, &ev("Network.loadingFailed", json!({
            "requestId": "current", "type": "Document", "errorText": "net::ERR_NAME_NOT_RESOLVED"
        })), &main).is_none(), "a finished failure must not be replayed");
    }

    fn request(main: &MainFrame, tab: TabId, id: &str, url: &str) {
        map_event(
            tab,
            &ev(
                "Network.requestWillBeSent",
                json!({
                    "requestId": id, "frameId": "main", "type": "Document", "request": {"url": url}
                }),
            ),
            main,
        );
    }

    fn failure(main: &MainFrame, tab: TabId, id: &str) -> Option<TabLoad> {
        map_event(
            tab,
            &ev(
                "Network.loadingFailed",
                json!({
                    "requestId": id, "type": "Document", "errorText": "net::ERR_FAILED"
                }),
            ),
            main,
        )
    }

    #[test]
    fn redirect_failure_reports_the_last_requested_url() {
        let main = MainFrame::default();
        let tab = TabId::new();
        main.note("main", Some("https://old.test/"));
        request(&main, tab, "same-id", "https://initial.test/");
        request(&main, tab, "same-id", "https://redirect.test/");
        assert_eq!(
            failure(&main, tab, "same-id").unwrap().url.as_deref(),
            Some("https://redirect.test/")
        );
    }

    #[test]
    fn completed_or_replaced_frame_requests_cannot_emit_late_failure() {
        let main = MainFrame::default();
        let tab = TabId::new();
        main.note("main", None);
        request(&main, tab, "complete", "https://complete.test/");
        map_event(
            tab,
            &ev("Network.loadingFinished", json!({"requestId": "unrelated"})),
            &main,
        );
        assert!(main.state.lock().unwrap().request.is_some());
        map_event(
            tab,
            &ev("Network.loadingFinished", json!({"requestId": "complete"})),
            &main,
        );
        assert!(failure(&main, tab, "complete").is_none());
        request(&main, tab, "old-root", "https://old-root.test/");
        main.note("replacement-root", Some("https://new-root.test/"));
        assert!(failure(&main, tab, "old-root").is_none());
    }

    #[test]
    fn non_document_failure_does_not_consume_main_request() {
        let main = MainFrame::default();
        let tab = TabId::new();
        main.note("main", None);
        request(&main, tab, "current", "https://current.test/");
        assert!(
            map_event(
                tab,
                &ev(
                    "Network.loadingFailed",
                    json!({
                        "requestId": "current", "type": "Image", "errorText": "net::ERR_FAILED"
                    })
                ),
                &main
            )
            .is_none()
        );
        assert!(failure(&main, tab, "current").is_some());
    }

    #[test]
    fn canceled_and_aborted_current_requests_are_consumed_without_error_ui() {
        let main = MainFrame::default();
        let tab = TabId::new();
        main.note("main", None);
        for (id, error, canceled) in [
            ("abort", "net::ERR_ABORTED", false),
            ("cancel", "net::ERR_FAILED", true),
        ] {
            request(&main, tab, id, "https://current.test/");
            assert!(map_event(tab, &ev("Network.loadingFailed", json!({
                "requestId": id, "type": "Document", "errorText": error, "canceled": canceled
            })), &main).is_none());
            assert!(failure(&main, tab, id).is_none());
        }
    }
}
