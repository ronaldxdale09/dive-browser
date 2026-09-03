//! Bringing a tab back after its renderer dies, with a budget.
//!
//! A crashed renderer leaves a blank view that still looks like a loaded tab:
//! the URL bar is right, the page is gone, and nothing says why. Reloading is
//! almost always the right move, so Dive does it.
//!
//! The budget is the important half. A page that reliably crashes on load —
//! a WebGL context the driver refuses, an out-of-memory loop — would
//! otherwise be reloaded forever, each attempt taking a renderer process with
//! it. After a few tries in a short window Dive stops and leaves the crash
//! visible, which is the honest outcome and the one a developer can act on.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use dive_cdp::CdpSession;
use dive_core::TabId;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::Runtime;
use crate::state::{AppState, lock};

/// Attempts allowed inside one window.
pub const MAX_ATTEMPTS: u32 = 3;
/// How long a run of crashes counts as the same episode.
pub const WINDOW: Duration = Duration::from_secs(30);
/// First backoff; each further attempt doubles it.
pub const BASE_DELAY: Duration = Duration::from_millis(250);

/// Emitted when a tab's renderer dies, whether or not it is being recovered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, Event)]
pub struct TabCrashed {
    /// The tab that lost its renderer.
    pub tab_id: TabId,
    /// Which attempt this is, within the current window.
    pub attempt: u32,
    /// Whether Dive is reloading it.
    pub recovering: bool,
}

/// How many crashes a tab has had, and when the run started.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Attempts {
    /// Crashes so far in this window.
    pub count: u32,
    /// When the window opened.
    pub started: Option<Instant>,
}

/// What to do about a crash.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    /// Wait this long before reloading, so a crash-on-load does not spin.
    pub delay: Duration,
    /// The attempt number this reload is.
    pub attempt: u32,
    /// State to carry into the next crash.
    pub next: Attempts,
}

/// Decide whether to reload, or to give up and leave the crash visible.
///
/// Returns `None` once the budget is spent. Pure so the backoff and the
/// window can be tested without crashing a renderer.
pub fn plan(state: Attempts, now: Instant) -> Option<Plan> {
    // A crash long after the last one is a new episode, not a continuation:
    // a page that broke once this morning gets a fresh budget this afternoon.
    let fresh = state
        .started
        .is_none_or(|started| now.duration_since(started) >= WINDOW);
    let count = if fresh { 0 } else { state.count };
    if count >= MAX_ATTEMPTS {
        return None;
    }
    Some(Plan {
        delay: BASE_DELAY * 2_u32.pow(count),
        attempt: count + 1,
        next: Attempts {
            count: count + 1,
            started: Some(if fresh {
                now
            } else {
                state.started.unwrap_or(now)
            }),
        },
    })
}

/// Crash history per tab.
#[derive(Default)]
pub struct Registry {
    inner: Mutex<HashMap<TabId, Attempts>>,
}

impl Registry {
    /// Record a crash and say what to do about it.
    pub fn on_crash(&self, tab: TabId, now: Instant) -> Option<Plan> {
        let mut history = lock(&self.inner);
        let current = history.get(&tab).copied().unwrap_or_default();
        let plan = plan(current, now)?;
        history.insert(tab, plan.next);
        Some(plan)
    }

    /// Forget a closed tab's history.
    pub fn drop_tab(&self, tab: TabId) {
        lock(&self.inner).remove(&tab);
    }
}

/// Watch a tab's session for renderer crashes and reload within budget.
pub fn watch(app: AppHandle<Runtime>, tab_id: TabId, session: CdpSession) {
    let mut events = session.subscribe();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = session.call0("Inspector.enable").await {
            tracing::warn!(%tab_id, "could not enable renderer crash events: {error}");
        }
        loop {
            match events.recv().await {
                Ok(event) => {
                    if event.method == "Inspector.targetCrashed" {
                        recover(&app, tab_id, &session).await;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(%tab_id, n, "crash monitor missed CDP events");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

async fn recover(app: &AppHandle<Runtime>, tab_id: TabId, session: &CdpSession) {
    let planned = app
        .state::<AppState>()
        .crashes
        .on_crash(tab_id, Instant::now());
    let Some(plan) = planned else {
        tracing::warn!(
            %tab_id,
            "renderer crashed {MAX_ATTEMPTS} times in {}s; leaving the tab as it is",
            WINDOW.as_secs()
        );
        let _ = TabCrashed {
            tab_id,
            attempt: MAX_ATTEMPTS,
            recovering: false,
        }
        .emit(app);
        return;
    };
    tracing::warn!(
        %tab_id,
        attempt = plan.attempt,
        "renderer crashed; reloading in {}ms",
        plan.delay.as_millis()
    );
    let _ = TabCrashed {
        tab_id,
        attempt: plan.attempt,
        recovering: true,
    }
    .emit(app);
    tokio::time::sleep(plan.delay).await;
    if let Err(e) = session.call0("Page.reload").await {
        tracing::warn!(%tab_id, "reload after a crash failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_crash_reloads_promptly() {
        let now = Instant::now();
        let plan = plan(Attempts::default(), now).expect("a first crash is worth a reload");
        assert_eq!(plan.attempt, 1);
        assert_eq!(plan.delay, BASE_DELAY);
        assert_eq!(plan.next.count, 1);
        assert_eq!(plan.next.started, Some(now));
    }

    #[test]
    fn each_attempt_waits_longer() {
        let now = Instant::now();
        let mut state = Attempts::default();
        let mut delays = Vec::new();
        for _ in 0..MAX_ATTEMPTS {
            let plan = plan(state, now).expect("within budget");
            delays.push(plan.delay);
            state = plan.next;
        }
        assert_eq!(
            delays,
            vec![BASE_DELAY, BASE_DELAY * 2, BASE_DELAY * 4],
            "a page that crashes on load must not be reloaded in a tight loop"
        );
    }

    #[test]
    fn the_budget_runs_out_and_the_crash_stays_visible() {
        let now = Instant::now();
        let spent = Attempts {
            count: MAX_ATTEMPTS,
            started: Some(now),
        };
        assert!(
            plan(spent, now).is_none(),
            "a reliably crashing page has to be left alone eventually"
        );
    }

    #[test]
    fn a_crash_after_the_window_starts_a_fresh_episode() {
        let morning = Instant::now();
        let spent = Attempts {
            count: MAX_ATTEMPTS,
            started: Some(morning),
        };
        let later = morning + WINDOW + Duration::from_secs(1);
        let plan = plan(spent, later).expect("an unrelated crash gets its own budget");
        assert_eq!(plan.attempt, 1);
        assert_eq!(plan.delay, BASE_DELAY);
        assert_eq!(plan.next.started, Some(later));
    }

    #[test]
    fn crashes_inside_the_window_keep_the_original_start() {
        let start = Instant::now();
        let first = plan(Attempts::default(), start).unwrap();
        let soon = start + Duration::from_secs(1);
        let second = plan(first.next, soon).unwrap();
        assert_eq!(second.attempt, 2);
        assert_eq!(
            second.next.started,
            Some(start),
            "the window is measured from the first crash, not the latest"
        );
    }

    #[test]
    fn a_registry_tracks_tabs_separately_and_forgets_closed_tabs() {
        let registry = Registry::default();
        let (a, b) = (TabId::new(), TabId::new());
        let now = Instant::now();

        assert_eq!(registry.on_crash(a, now).unwrap().attempt, 1);
        assert_eq!(registry.on_crash(a, now).unwrap().attempt, 2);
        assert_eq!(
            registry.on_crash(b, now).unwrap().attempt,
            1,
            "one bad tab does not spend another tab's budget"
        );

        registry.drop_tab(a);
        assert_eq!(registry.on_crash(a, now).unwrap().attempt, 1);
    }

    #[test]
    fn a_registry_stops_after_the_budget_and_stays_stopped() {
        let registry = Registry::default();
        let tab = TabId::new();
        let now = Instant::now();
        for expected in 1..=MAX_ATTEMPTS {
            assert_eq!(registry.on_crash(tab, now).unwrap().attempt, expected);
        }
        assert!(registry.on_crash(tab, now).is_none());
        assert!(
            registry.on_crash(tab, now).is_none(),
            "a refused attempt must not itself reset the count"
        );
    }
}
