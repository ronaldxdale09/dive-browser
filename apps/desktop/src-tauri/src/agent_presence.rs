//! Who is driving, and where.
//!
//! Anything acting on a page for an agent -- the sidecar's own tools or an
//! MCP client on the other end of the server -- goes through one place, so
//! that is where presence is decided. The chrome marks the tab in its list
//! and the page itself is given an edge glow, which together answer the
//! question a person actually has: something is moving on its own, is it
//! mine, and where.
//!
//! Actions arrive in bursts with gaps between them, so presence lingers past
//! the last one. Without that the glow strobes once per click and reads as a
//! rendering fault rather than as a state.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use dive_core::TabId;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;

use crate::Runtime;
use crate::state::lock;

/// How long a tab keeps looking driven after its last action finishes.
/// Long enough to bridge a model's thinking time between two tool calls,
/// short enough that a finished run stops looking live.
const LINGER: std::time::Duration = std::time::Duration::from_millis(2500);

/// A tab an agent started or stopped driving.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct AgentPresence {
    /// The tab being driven.
    pub tab_id: TabId,
    /// Whether an agent is working in it right now.
    pub driving: bool,
}

#[derive(Default)]
struct Entry {
    /// Actions in flight on this tab.
    running: usize,
    /// Bumped whenever presence changes, so a linger that has been overtaken
    /// by a new action knows to do nothing.
    generation: u64,
    /// Whether the chrome and the page currently believe it is driven.
    lit: bool,
}

/// Which tabs are being driven, and by how many actions at once.
#[derive(Default)]
pub struct Registry {
    tabs: Mutex<HashMap<TabId, Entry>>,
}

impl Registry {
    /// Note that an action has started on `tab`. Lights it if it was dark.
    pub fn begin(self: &Arc<Self>, app: &AppHandle<Runtime>, tab: TabId) {
        let light = {
            let mut tabs = lock(&self.tabs);
            let entry = tabs.entry(tab).or_default();
            entry.running += 1;
            entry.generation += 1;
            if entry.lit {
                false
            } else {
                entry.lit = true;
                true
            }
        };
        if light {
            announce(app, tab, true);
        }
    }

    /// Note that an action has finished. The tab stays lit for [`LINGER`] in
    /// case another action follows, which is the usual case mid-run.
    pub fn end(self: &Arc<Self>, app: &AppHandle<Runtime>, tab: TabId) {
        let generation = {
            let mut tabs = lock(&self.tabs);
            let Some(entry) = tabs.get_mut(&tab) else {
                return;
            };
            entry.running = entry.running.saturating_sub(1);
            if entry.running > 0 {
                return;
            }
            entry.generation += 1;
            entry.generation
        };
        let registry = Arc::clone(self);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(LINGER).await;
            let darken = {
                let mut tabs = lock(&registry.tabs);
                let Some(entry) = tabs.get_mut(&tab) else {
                    return;
                };
                // A newer action came and went, or is still running: whoever
                // owns that generation decides when the light goes out.
                if entry.generation != generation || entry.running > 0 {
                    return;
                }
                let was = entry.lit;
                entry.lit = false;
                was
            };
            if darken {
                announce(&app, tab, false);
            }
        });
    }

    /// Forget a tab that has gone away, so its entry cannot outlive it.
    pub fn forget(&self, tab: TabId) {
        lock(&self.tabs).remove(&tab);
    }

    /// Whether an agent is driving `tab` right now.
    #[must_use]
    pub fn driving(&self, tab: TabId) -> bool {
        lock(&self.tabs).get(&tab).is_some_and(|e| e.lit)
    }
}

/// Tell the chrome, and paint or clear the page's own glow.
fn announce(app: &AppHandle<Runtime>, tab: TabId, driving: bool) {
    let _ = AgentPresence {
        tab_id: tab,
        driving,
    }
    .emit(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = paint(&app, tab, driving).await {
            // A page that has navigated away, or a tab that has closed, has
            // no glow to clear; the chrome's own mark is the part that must
            // not be missed.
            tracing::debug!(
                "could not {} the agent glow: {e}",
                if driving { "paint" } else { "clear" }
            );
        }
    });
}

async fn paint(app: &AppHandle<Runtime>, tab: TabId, driving: bool) -> crate::error::AppResult<()> {
    use tauri::Manager;
    let state = app.state::<crate::state::AppState>();
    let session = crate::commands::cdp_for(&state, tab)?;
    let script = crate::pagescript::build(
        "agent_glow.js",
        &[("__ON__", if driving { "true" } else { "false" }.into())],
    );
    session
        .call(
            "Runtime.evaluate",
            serde_json::json!({"expression": script, "returnByValue": true}),
        )
        .await
        .map_err(crate::error::AppError::new)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_burst_of_actions_lights_the_tab_once_and_stays_lit() {
        let registry = Registry::default();
        let tab = TabId::new();
        {
            let mut tabs = lock(&registry.tabs);
            let entry = tabs.entry(tab).or_default();
            entry.running = 2;
            entry.lit = true;
        }
        assert!(registry.driving(tab));
        // One of the two finishing leaves the other running, so it stays lit.
        {
            let mut tabs = lock(&registry.tabs);
            let entry = tabs.get_mut(&tab).expect("entry");
            entry.running -= 1;
        }
        assert!(registry.driving(tab));
    }

    #[test]
    fn a_closed_tab_is_forgotten_rather_than_left_lit() {
        let registry = Registry::default();
        let tab = TabId::new();
        lock(&registry.tabs).insert(
            tab,
            Entry {
                running: 1,
                generation: 1,
                lit: true,
            },
        );
        registry.forget(tab);
        assert!(!registry.driving(tab));
    }
}
