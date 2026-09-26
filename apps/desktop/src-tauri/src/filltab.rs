//! Fill the tab with a video without leaving the window: the hover control
//! and the fixed-position layout come from `inject/fill-tab.js`; this side
//! installs it and offers the chrome a toggle.
//!
//! The control runs in Dive's isolated world (see `page_world`). It only
//! moves DOM nodes and styles them, which that world shares with the page;
//! the page no longer gets to stand in for `__diveFillTab` and answer the
//! chrome's toggle with whatever it likes.

use dive_cdp::CdpSession;
use dive_core::TabId;
use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::page_world;

use crate::Runtime;
use crate::state::AppState;

/// Install the control in every document of the tab, when the preference
/// allows it. Idempotent in the page: the script checks its own marker.
/// Resolves once the new-document script is registered, so the caller can
/// hold the first navigation until then.
///
/// Registration is all it takes. The tab's view is new and still on its
/// blank document, which the first navigation replaces, so evaluating the
/// script there as well only cost a round trip.
pub async fn attach(app: AppHandle<Runtime>, tab_id: TabId, session: CdpSession) {
    let enabled = {
        let state = app.state::<AppState>();
        state.prefs.get(&state).video_fill_tab
    };
    if !enabled {
        return;
    }
    let script = crate::pagescript::build("fill-tab.js", &[]);
    match page_world::add_script(&session, &script).await {
        Ok(_) => tracing::debug!(%tab_id, "fill-tab control installed"),
        Err(e) => tracing::debug!(%tab_id, "fill-tab install failed: {e}"),
    }
}

/// Toggle the filled state of the tab's most likely video. Returns what the
/// page did: `filled`, `exited`, `no-video`, or `unavailable` when the
/// control is not installed (preference off, or a page with no script).
pub async fn toggle(session: &CdpSession) -> String {
    let reply = page_world::evaluate(
        session,
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
