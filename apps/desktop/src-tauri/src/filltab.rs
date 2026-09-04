//! Fill the tab with a video without leaving the window: the hover control
//! and the fixed-position layout come from `inject/fill-tab.js`; this side
//! installs it and offers the chrome a toggle.

use dive_cdp::CdpSession;
use dive_core::TabId;
use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::Runtime;
use crate::state::AppState;

/// Install the control in every document of the tab, when the preference
/// allows it. Idempotent in the page: the script checks its own marker.
/// The returned receiver resolves once the new-document script is
/// registered, so the caller can hold the first navigation until then.
pub fn attach(
    app: AppHandle<Runtime>,
    tab_id: TabId,
    session: CdpSession,
) -> crate::cdp_feed::Ready {
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let enabled = {
            let state = app.state::<AppState>();
            state.prefs.get(&state).video_fill_tab
        };
        if !enabled {
            let _ = ready_tx.send(());
            return;
        }
        let script = crate::pagescript::build("fill-tab.js", &[]);
        let _ = session.call0("Page.enable").await;
        if let Err(e) = session
            .call(
                "Page.addScriptToEvaluateOnNewDocument",
                json!({"source": script, "runImmediately": true}),
            )
            .await
        {
            tracing::debug!(%tab_id, "fill-tab install failed: {e}");
        }
        let _ = ready_tx.send(());
        // The current document, if the tab already has one.
        match session
            .call("Runtime.evaluate", json!({"expression": script}))
            .await
        {
            Ok(_) => tracing::debug!(%tab_id, "fill-tab control installed"),
            Err(e) => tracing::debug!(%tab_id, "fill-tab evaluate failed: {e}"),
        }
    });
    ready_rx
}

/// Toggle the filled state of the tab's most likely video. Returns what the
/// page did: `filled`, `exited`, `no-video`, or `unavailable` when the
/// control is not installed (preference off, or a page with no script).
pub async fn toggle(session: &CdpSession) -> String {
    let reply = session
        .call(
            "Runtime.evaluate",
            json!({
                "expression": "window.__diveFillTab ? window.__diveFillTab.toggle() : 'unavailable'",
                "returnByValue": true
            }),
        )
        .await;
    reply
        .ok()
        .and_then(|v| v["result"]["value"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "unavailable".to_owned())
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_script_is_self_guarding_and_exposes_the_toggle() {
        let script = crate::pagescript::build("fill-tab.js", &[]);
        assert!(script.contains("if (window.__diveFillTab) return;"));
        assert!(script.contains("window.__diveFillTab = Object.freeze("));
        assert!(script.contains("dive-fill-target"));
        // Escape leaves the filled state before the page sees the key.
        assert!(script.contains("e.key === \"Escape\" && target"));
    }
}
