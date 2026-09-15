//! What each tab is costing.
//!
//! Chrome's task manager reads per-process counters the browser keeps; Alloy
//! keeps none an embedder can ask for, so this reads each live renderer's own
//! metrics over CDP: the JavaScript heap it is holding and the processor time
//! its main thread has used since it started. Both are per tab, which is the
//! unit a person acts on.
//!
//! Processor time is cumulative, so a rate needs two readings. The host
//! reports the total and the chrome subtracts, which keeps the sampling
//! interval in the place that decides how often to look.

use dive_core::TabId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;

use crate::error::AppResult;
use crate::state::{AppState, lock};

/// One tab, as the task manager lists it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct TaskRow {
    pub tab_id: TabId,
    /// The tab's title, or its address when it has none yet.
    pub title: String,
    pub url: String,
    /// Bytes of JavaScript heap the renderer is holding. `None` for a tab
    /// with no live renderer to ask.
    pub memory_bytes: Option<f64>,
    /// Processor seconds this renderer's main thread has used since it
    /// started. Cumulative; the chrome turns two readings into a rate.
    pub cpu_seconds: Option<f64>,
    /// Live DOM nodes, and documents, as a sense of what the page is holding.
    pub nodes: Option<f64>,
    pub documents: Option<f64>,
    /// Registered event listeners, which is where a leaking page shows first.
    pub listeners: Option<f64>,
    /// The tab is asleep: no renderer, and nothing to measure.
    pub sleeping: bool,
    /// The tab is making a sound.
    pub audible: bool,
}

/// Pull one metric out of the array `Performance.getMetrics` answers with.
pub fn metric(metrics: &Value, name: &str) -> Option<f64> {
    metrics
        .as_array()?
        .iter()
        .find(|entry| entry["name"].as_str() == Some(name))?["value"]
        .as_f64()
}

/// Measure every tab that has a live renderer, and list the sleeping ones
/// alongside so the table accounts for every tab.
pub async fn list(state: &AppState) -> AppResult<Vec<TaskRow>> {
    let sessions: Vec<(TabId, dive_cdp::CdpSession)> = {
        let host = lock(&state.host);
        host.as_ref()
            .map_or_else(Vec::new, crate::engine::TabHost::sessions)
    };
    // Every tab in every workspace, essentials included. `tabs_for_workspace`
    // returns the essentials alongside each workspace's own, so a tab that
    // lives in all of them is listed once.
    let tabs = {
        let store = lock(&state.store);
        let mut seen = std::collections::HashSet::new();
        let mut tabs = Vec::new();
        for workspace in store.workspaces()? {
            for tab in store.tabs_for_workspace(workspace.id)? {
                if seen.insert(tab.id) {
                    tabs.push(tab);
                }
            }
        }
        tabs
    };
    let mut rows = Vec::with_capacity(tabs.len());
    for tab in tabs {
        let session = sessions
            .iter()
            .find_map(|(id, session)| (*id == tab.id).then(|| session.clone()));
        let title = if tab.title.trim().is_empty() {
            tab.url.clone()
        } else {
            tab.title.clone()
        };
        let mut row = TaskRow {
            tab_id: tab.id,
            title,
            url: tab.url.clone(),
            memory_bytes: None,
            cpu_seconds: None,
            nodes: None,
            documents: None,
            listeners: None,
            sleeping: session.is_none(),
            audible: crate::tab_audio::is_audible(tab.id),
        };
        if let Some(session) = session {
            // Enabling is idempotent and cheap; a tab measured once stays
            // enabled, and a fresh renderer needs it again.
            let _ = session.call("Performance.enable", json!({})).await;
            if let Ok(result) = session.call("Performance.getMetrics", json!({})).await {
                let metrics = &result["metrics"];
                row.memory_bytes = metric(metrics, "JSHeapUsedSize");
                row.cpu_seconds = metric(metrics, "TaskDuration");
                row.nodes = metric(metrics, "Nodes");
                row.documents = metric(metrics, "Documents");
                row.listeners = metric(metrics, "JSEventListeners");
            }
        }
        rows.push(row);
    }
    // Heaviest first: the reason anyone opens this is to find that tab.
    rows.sort_by(|a, b| {
        b.memory_bytes
            .unwrap_or(-1.0)
            .partial_cmp(&a.memory_bytes.unwrap_or(-1.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_metric_array_chromium_answers_with() {
        let metrics = json!([
            {"name": "JSHeapUsedSize", "value": 12_345_678.0},
            {"name": "TaskDuration", "value": 1.5},
            {"name": "Nodes", "value": 900.0},
        ]);
        assert_eq!(metric(&metrics, "JSHeapUsedSize"), Some(12_345_678.0));
        assert_eq!(metric(&metrics, "TaskDuration"), Some(1.5));
        // A metric this Chromium does not report is absent, not zero: a tab
        // that cannot be measured must not look idle.
        assert_eq!(metric(&metrics, "ProcessTime"), None);
        assert_eq!(metric(&json!({}), "Nodes"), None);
        assert_eq!(metric(&json!("nonsense"), "Nodes"), None);
    }
}
