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
/// Two reports of the same tab this close together are one crash seen by
/// both signals: CEF's process hook and the `DevTools` `targetCrashed` event.
pub const SAME_EVENT: Duration = Duration::from_secs(1);

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

struct Admitted {
    planned: Option<Plan>,
}

/// Crash history per tab.
#[derive(Default)]
pub struct Registry {
    /// Serializes view replacement with admission, without taking the tab host
    /// lock from a reentrant native callback. Always lock this before history.
    views: Mutex<HashMap<TabId, String>>,
    inner: Mutex<HashMap<TabId, Attempts>>,
    /// When each tab's crash was last reported, to fold duplicate signals.
    seen: Mutex<HashMap<TabId, Instant>>,
}

impl Registry {
    pub fn bind_view(&self, tab: TabId, label: &str) {
        let mut views = lock(&self.views);
        if views.get(&tab).is_some_and(|current| current == label) {
            return;
        }
        views.insert(tab, label.to_owned());
        lock(&self.inner).remove(&tab);
        lock(&self.seen).remove(&tab);
    }

    fn current_view(&self, tab: TabId, label: &str) -> bool {
        lock(&self.views)
            .get(&tab)
            .is_some_and(|current| current == label)
    }

    fn admit(&self, tab: TabId, label: &str, now: Instant) -> Option<Admitted> {
        let views = lock(&self.views);
        if views.get(&tab).is_none_or(|current| current != label) {
            return None;
        }
        (!self.duplicate(tab, now)).then(|| Admitted {
            planned: self.on_crash(tab, now),
        })
    }

    fn begin_current_reload(&self, tab: TabId, label: &str) -> bool {
        let views = lock(&self.views);
        if views.get(&tab).is_none_or(|current| current != label) {
            return false;
        }
        self.begin_reload(tab);
        true
    }

    /// Note a report and say whether it repeats one just handled.
    pub fn duplicate(&self, tab: TabId, now: Instant) -> bool {
        let mut seen = lock(&self.seen);
        matches!(seen.insert(tab, now), Some(prev) if now.duration_since(prev) < SAME_EVENT)
    }

    /// Mark the boundary between this crash and a possible crash-on-reload.
    pub fn begin_reload(&self, tab: TabId) {
        // Once reload starts the renderer can crash again immediately. Time
        // alone cannot distinguish that new crash from the previous signals.
        lock(&self.seen).remove(&tab);
    }

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
        let mut views = lock(&self.views);
        views.remove(&tab);
        lock(&self.inner).remove(&tab);
        lock(&self.seen).remove(&tab);
    }
}

/// CEF's report that a tab's web content process went away. The `DevTools`
/// session usually notices too; whichever signal lands second is dropped.
pub fn on_native_terminate(webview: &tauri::Webview<Runtime>) {
    let Some(tab_id) = crate::engine::tab_from_label(webview.label()) else {
        return;
    };
    let app = webview.app_handle().clone();
    schedule_recovery(&app, tab_id, webview.label().to_owned(), None);
}

/// Watch a tab's session for renderer crashes and reload within budget.
pub fn watch(app: AppHandle<Runtime>, tab_id: TabId, view_label: String, session: CdpSession) {
    let mut events = session.subscribe();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = session.call0("Inspector.enable").await {
            tracing::warn!(%tab_id, "could not enable renderer crash events: {error}");
        }
        loop {
            match events.recv().await {
                Ok(event) => {
                    if event.method == "Inspector.targetCrashed" {
                        schedule_recovery(&app, tab_id, view_label.clone(), Some(session.clone()));
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

/// Admit the report now, before its returned worker can be delayed by scheduling.
fn recovery_task<F, Fut>(
    crashes: &Registry,
    tab_id: TabId,
    view_label: &str,
    now: Instant,
    run: F,
) -> impl std::future::Future<Output = ()> + use<F, Fut>
where
    F: FnOnce(Option<Plan>) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let admitted = crashes.admit(tab_id, view_label, now);
    async move {
        if let Some(planned) = admitted {
            run(planned.planned).await;
        }
    }
}

fn schedule_recovery(
    app: &AppHandle<Runtime>,
    tab_id: TabId,
    view_label: String,
    session: Option<CdpSession>,
) {
    let worker_app = app.clone();
    let source_label = view_label.clone();
    let task = recovery_task(
        &app.state::<AppState>().crashes,
        tab_id,
        &source_label,
        Instant::now(),
        move |planned| async move {
            // Native callbacks can be reentrant. Fetch their session in the
            // worker, after admission, without locking the host in the callback.
            let session = session.or_else(|| {
                lock(&worker_app.state::<AppState>().host)
                    .as_ref()
                    .and_then(|host| {
                        let matches = host
                            .with_view(tab_id, |view| Ok(view.label() == view_label))
                            .ok()?;
                        matches.then(|| host.cdp(tab_id)).flatten()
                    })
            });
            if let Some(session) = session {
                recover(&worker_app, tab_id, &view_label, &session, planned).await;
            }
        },
    );
    // The watcher remains free to drain reports while this attempt backs off.
    tauri::async_runtime::spawn(task);
}

/// Called within one main-thread dispatch, where native view replacement cannot
/// interleave. Do not hold the registry lock across event/CEF publication.
fn publish_current<T>(
    crashes: &Registry,
    tab: TabId,
    label: &str,
    emit: impl FnOnce() -> T,
) -> Option<T> {
    crashes.current_view(tab, label).then(emit)
}

async fn emit_current(app: &AppHandle<Runtime>, label: &str, notice: TabCrashed) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let publish_app = app.clone();
    let label = label.to_owned();
    if app
        .run_on_main_thread(move || {
            let state = publish_app.state::<AppState>();
            let published = publish_current(&state.crashes, notice.tab_id, &label, || {
                notice.emit(&publish_app).is_ok()
            })
            .unwrap_or(false);
            let _ = tx.send(published);
        })
        .is_err()
    {
        return false;
    }
    rx.await.unwrap_or(false)
}

async fn recover(
    app: &AppHandle<Runtime>,
    tab_id: TabId,
    view_label: &str,
    session: &CdpSession,
    planned: Option<Plan>,
) {
    if session.is_closed()
        || !app
            .state::<AppState>()
            .crashes
            .current_view(tab_id, view_label)
    {
        return;
    }
    let state = app.state::<AppState>();
    let crashes = &state.crashes;
    let Some(plan) = planned else {
        tracing::warn!(
            %tab_id,
            "renderer crashed {MAX_ATTEMPTS} times in {}s; leaving the tab as it is",
            WINDOW.as_secs()
        );
        emit_current(
            app,
            view_label,
            TabCrashed {
                tab_id,
                attempt: MAX_ATTEMPTS,
                recovering: false,
            },
        )
        .await;
        return;
    };
    tracing::warn!(
        %tab_id,
        attempt = plan.attempt,
        "renderer crashed; reloading in {}ms",
        plan.delay.as_millis()
    );
    if !emit_current(
        app,
        view_label,
        TabCrashed {
            tab_id,
            attempt: plan.attempt,
            recovering: true,
        },
    )
    .await
    {
        return;
    }
    tokio::time::sleep(plan.delay).await;
    if session.is_closed() {
        return;
    }
    if !crashes.begin_current_reload(tab_id, view_label) {
        return;
    }
    if let Err(e) = session.call0("Page.reload").await {
        tracing::warn!(%tab_id, "reload after a crash failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_same_crash_seen_twice_is_handled_once() {
        let registry = Registry::default();
        let tab = TabId::new();
        let t0 = Instant::now();
        assert!(!registry.duplicate(tab, t0));
        assert!(registry.duplicate(tab, t0 + Duration::from_millis(50)));
        assert!(!registry.duplicate(tab, t0 + SAME_EVENT + Duration::from_secs(1)));
        registry.drop_tab(tab);
        assert!(!registry.duplicate(tab, t0 + SAME_EVENT + Duration::from_secs(1)));
    }

    #[test]
    fn a_new_crash_after_reload_gets_its_own_bounded_attempt() {
        let registry = Registry::default();
        let tab = TabId::new();
        let t0 = Instant::now();
        for attempt in 1..=MAX_ATTEMPTS {
            let now = t0 + Duration::from_millis(u64::from(attempt) * 100);
            assert!(
                !registry.duplicate(tab, now),
                "a reload can crash inside the dedup window"
            );
            assert_eq!(registry.on_crash(tab, now).unwrap().attempt, attempt);
            assert!(registry.duplicate(tab, now + Duration::from_millis(1)));
            registry.begin_reload(tab);
        }
        assert!(!registry.duplicate(tab, t0 + Duration::from_millis(500)));
        assert!(
            registry
                .on_crash(tab, t0 + Duration::from_millis(500))
                .is_none()
        );
    }

    #[tokio::test]
    async fn admission_happens_before_a_deferred_recovery_worker_runs() {
        let registry = Registry::default();
        let tab = TabId::new();
        let now = Instant::now();
        let handled = &Mutex::new(Vec::new());
        registry.bind_view(tab, "view-1");
        recovery_task(&registry, tab, "view-1", now, |plan| async move {
            assert_eq!(plan.unwrap().attempt, 1);
            handled.lock().unwrap().push("first");
        })
        .await;
        // Both signal receipt and worker execution are controlled separately:
        // this duplicate arrives before reload, but its worker is delayed.
        let duplicate = recovery_task(
            &registry,
            tab,
            "view-1",
            now + Duration::from_millis(50),
            |plan| async move {
                if plan.is_some() {
                    handled.lock().unwrap().push("duplicate");
                }
            },
        );
        registry.begin_reload(tab);
        let new_crash = recovery_task(
            &registry,
            tab,
            "view-1",
            now + Duration::from_millis(300),
            |plan| async move {
                if plan.is_some() {
                    handled.lock().unwrap().push("new");
                }
            },
        );
        duplicate.await;
        new_crash.await;
        assert_eq!(*handled.lock().unwrap(), vec!["first", "new"]);
    }

    #[tokio::test]
    async fn a_delayed_old_view_report_never_runs_or_spends_the_replacements_budget() {
        let registry = Registry::default();
        let tab = TabId::new();
        let now = Instant::now();
        registry.bind_view(tab, "old");
        assert_eq!(
            registry
                .admit(tab, "old", now)
                .unwrap()
                .planned
                .unwrap()
                .attempt,
            1
        );
        registry.bind_view(tab, "replacement");
        for _ in 0..10 {
            recovery_task(&registry, tab, "old", now, |_| async {
                panic!("old native or CDP report reached a recovery worker");
            })
            .await;
        }
        assert_eq!(
            registry
                .admit(tab, "replacement", now)
                .unwrap()
                .planned
                .unwrap()
                .attempt,
            1
        );
        // A pending old worker cannot clear the new view's deduplication state.
        assert!(!registry.begin_current_reload(tab, "old"));
        assert!(registry.admit(tab, "replacement", now).is_none());
        registry.bind_view(tab, "replacement");
        assert!(registry.begin_current_reload(tab, "replacement"));
        assert_eq!(
            registry
                .admit(tab, "replacement", now)
                .unwrap()
                .planned
                .unwrap()
                .attempt,
            2
        );
    }

    #[test]
    fn a_closed_views_report_does_not_recreate_retired_history() {
        let registry = Registry::default();
        let tab = TabId::new();
        registry.bind_view(tab, "closed");
        registry.drop_tab(tab);
        assert!(registry.admit(tab, "closed", Instant::now()).is_none());
        assert!(!registry.current_view(tab, "closed"));
        assert!(!registry.begin_current_reload(tab, "closed"));
        assert!(lock(&registry.inner).is_empty());
        assert!(lock(&registry.seen).is_empty());
    }

    #[test]
    fn queued_crash_publication_checks_the_view_when_main_thread_executes_it() {
        let registry = Registry::default();
        let tab = TabId::new();
        registry.bind_view(tab, "old");
        let notices = std::cell::RefCell::new(Vec::new());
        let queued = || publish_current(&registry, tab, "old", || notices.borrow_mut().push("old"));
        registry.bind_view(tab, "replacement");
        assert!(queued().is_none());
        publish_current(&registry, tab, "replacement", || {
            notices.borrow_mut().push("new");
        });
        assert_eq!(*notices.borrow(), vec!["new"]);
    }

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
