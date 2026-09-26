//! Bringing a tab back after its renderer dies, with a budget.
//!
//! A crashed renderer leaves a blank view that still looks like a loaded tab:
//! the URL bar is right, the page is gone, and nothing says why. Reloading is
//! almost always the right move, so Dive does it.
//!
//! The budget is the important half. A page that reliably crashes on load —
//! a WebGL context the driver refuses, an out-of-memory loop — would
//! otherwise be reloaded forever, each attempt taking a renderer process with
//! it. After a few tries without a quiet spell in between Dive stops and
//! leaves the crash visible, which is the honest outcome and the one a
//! developer can act on.
//!
//! Not every death is worth a reload. A renderer the system killed for
//! memory, or one the person ended because it hung, would only be killed
//! again; those tabs keep the banner and wait for someone to press Reload.
//! A tab nobody is looking at is not reloaded either: it is marked, and comes
//! back when it is next shown, so a background crash costs nothing until then.
//!
//! The chrome itself is a page too. Its renderer can die like any other,
//! and then the window has no tabs, no address bar and no way out; it is
//! reloaded on the same kind of budget, with whatever cover it had left over
//! the pages taken down first.

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

/// Attempts allowed before a quiet spell resets the count.
pub const MAX_ATTEMPTS: u32 = 3;
/// How long a page has to go without crashing before its budget is whole
/// again. Measured from the latest crash, not the first: a page that crashes
/// every ten seconds never earns a fresh budget, where a window measured from
/// the first crash handed it one every half minute and reloaded it forever.
pub const QUIET: Duration = Duration::from_mins(5);
/// First backoff; each further attempt doubles it.
pub const BASE_DELAY: Duration = Duration::from_millis(250);
/// Two reports of the same tab this close together are one crash seen by
/// both signals: CEF's process hook and the `DevTools` `targetCrashed` event.
pub const SAME_EVENT: Duration = Duration::from_secs(1);
/// How long the `DevTools` report waits for CEF's, which says why the
/// renderer died. Whichever is admitted first is the one acted on, and only
/// the native one can tell a crash from an out-of-memory kill.
const REASON_GRACE: Duration = Duration::from_millis(400);

/// Why a renderer went away, as far as the engine could tell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CrashReason {
    /// It crashed, or exited abnormally.
    Crashed,
    /// It ran out of memory.
    OutOfMemory,
    /// It was killed: by the system, or by someone ending a page that hung.
    Killed,
    /// Only the `DevTools` session noticed, and it does not say.
    Unknown,
}

impl CrashReason {
    /// Whether reloading on our own is worth it. A process killed for memory
    /// or on purpose would be killed again, so the person decides.
    pub fn reloads(self) -> bool {
        matches!(self, Self::Crashed | Self::Unknown)
    }
}

#[cfg(feature = "cef")]
impl From<tauri_runtime_cef::RendererExit> for CrashReason {
    fn from(exit: tauri_runtime_cef::RendererExit) -> Self {
        use tauri_runtime_cef::RendererExit;
        match exit {
            RendererExit::Crashed | RendererExit::Abnormal | RendererExit::LaunchFailed => {
                Self::Crashed
            }
            RendererExit::OutOfMemory => Self::OutOfMemory,
            RendererExit::Killed => Self::Killed,
            RendererExit::Other => Self::Unknown,
        }
    }
}

/// Emitted when a tab's renderer dies, whether or not it is being recovered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, Event)]
pub struct TabCrashed {
    /// The tab that lost its renderer.
    pub tab_id: TabId,
    /// Which attempt this is, since the page last went quiet.
    pub attempt: u32,
    /// Whether Dive is reloading it, now or when it is next shown.
    pub recovering: bool,
    /// Why the renderer went away.
    pub reason: CrashReason,
    /// The tab was in the background: it reloads when it is next shown.
    pub deferred: bool,
}

/// A tab's page stopped responding to input. The engine waits for an answer
/// through `tab_unresponsive_answer`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, Event)]
pub struct TabUnresponsive {
    /// The tab whose page hangs.
    pub tab_id: TabId,
}

/// A page that was reported as not responding answers again, or its hang
/// was otherwise settled (it was ended, or the tab closed).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, Event)]
pub struct TabResponsive {
    /// The tab whose page recovered.
    pub tab_id: TabId,
}

/// How many crashes a tab has had, and when the latest was.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Attempts {
    /// Crashes since the page last went quiet.
    pub count: u32,
    /// When the latest crash was.
    pub last: Option<Instant>,
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
/// Returns `None` once the budget is spent, and the refused crash still
/// counts as the latest: a page that keeps crashing stays refused until it
/// has been quiet for [`QUIET`]. Pure so the backoff and the quiet spell can
/// be tested without crashing a renderer.
pub fn plan(state: Attempts, now: Instant) -> (Option<Plan>, Attempts) {
    // A crash long after the last one is a new episode, not a continuation:
    // a page that broke once this morning gets a fresh budget this afternoon.
    let fresh = state
        .last
        .is_none_or(|last| now.saturating_duration_since(last) >= QUIET);
    let count = if fresh { 0 } else { state.count };
    if count >= MAX_ATTEMPTS {
        return (
            None,
            Attempts {
                count,
                last: Some(now),
            },
        );
    }
    let next = Attempts {
        count: count + 1,
        last: Some(now),
    };
    (
        Some(Plan {
            delay: BASE_DELAY * 2_u32.pow(count),
            attempt: count + 1,
            next,
        }),
        next,
    )
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
    /// Background tabs that crashed, by the view that did: reloaded when the
    /// tab is next shown, rather than spending a renderer on a page nobody
    /// is looking at.
    deferred: Mutex<HashMap<TabId, String>>,
    /// Pages that stopped responding, by the view that hangs, with the
    /// engine's hold on the wait.
    #[cfg(feature = "cef")]
    hung: Mutex<HashMap<TabId, (String, tauri_runtime_cef::UnresponsiveRenderer)>>,
    /// Chrome documents' own crash history, by webview label.
    chrome: Mutex<HashMap<String, Attempts>>,
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
        // A new view is a new page: nothing of the old one's is owed.
        lock(&self.deferred).remove(&tab);
        #[cfg(feature = "cef")]
        lock(&self.hung).remove(&tab);
    }

    /// Remember that `tab`'s view `label` crashed out of sight.
    fn defer(&self, tab: TabId, label: &str) {
        let views = lock(&self.views);
        if views.get(&tab).is_some_and(|current| current == label) {
            lock(&self.deferred).insert(tab, label.to_owned());
        }
    }

    /// Whether `tab` is owed a reload now that it is shown; forgets it.
    /// Only for the view that crashed: one rebuilt since starts fresh.
    pub fn take_deferred(&self, tab: TabId, label: &str) -> bool {
        let mut deferred = lock(&self.deferred);
        if deferred.get(&tab).is_some_and(|crashed| crashed == label) {
            deferred.remove(&tab);
            return true;
        }
        false
    }

    /// Budget a crash of the chrome document `label`.
    fn chrome_crash(&self, label: &str, now: Instant) -> Option<Plan> {
        let mut history = lock(&self.chrome);
        let current = history.get(label).copied().unwrap_or_default();
        let (plan, next) = plan(current, now);
        // Popout chrome labels are numbered and never reused, so a closed
        // window's entry is a few bytes nobody asks for again.
        history.insert(label.to_owned(), next);
        plan
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
        let (plan, next) = plan(current, now);
        history.insert(tab, next);
        plan
    }

    /// Forget a closed tab's history.
    pub fn drop_tab(&self, tab: TabId) {
        let mut views = lock(&self.views);
        views.remove(&tab);
        lock(&self.inner).remove(&tab);
        lock(&self.seen).remove(&tab);
        lock(&self.deferred).remove(&tab);
        #[cfg(feature = "cef")]
        lock(&self.hung).remove(&tab);
    }

    /// Hold the engine's wait for `tab`'s hung view `label`. False when the
    /// view is not the tab's current one, and the report is stale.
    #[cfg(feature = "cef")]
    fn hang(&self, tab: TabId, label: &str, wait: tauri_runtime_cef::UnresponsiveRenderer) -> bool {
        let views = lock(&self.views);
        if views.get(&tab).is_none_or(|current| current != label) {
            return false;
        }
        lock(&self.hung).insert(tab, (label.to_owned(), wait));
        true
    }

    /// The page answers again; true when it had been reported hung.
    #[cfg(feature = "cef")]
    fn unhang(&self, tab: TabId, label: &str) -> bool {
        let mut hung = lock(&self.hung);
        if hung.get(&tab).is_some_and(|(hanging, _)| hanging == label) {
            hung.remove(&tab);
            return true;
        }
        false
    }

    /// Take the engine's wait for `tab`, to answer it.
    #[cfg(feature = "cef")]
    fn take_hang(&self, tab: TabId) -> Option<tauri_runtime_cef::UnresponsiveRenderer> {
        lock(&self.hung).remove(&tab).map(|(_, wait)| wait)
    }

    /// Whether `tab`'s page is waiting on an answer about its hang.
    #[cfg(feature = "cef")]
    pub fn is_hung(&self, tab: TabId) -> bool {
        lock(&self.hung).contains_key(&tab)
    }
}

/// Listen to a tab view's renderer: its death, with the reason, and its
/// hangs. CEF reports these inside its own callbacks on the main thread, so
/// everything that touches the runtime or the chrome is handed to a task.
#[cfg(feature = "cef")]
pub fn attach(app: &AppHandle<Runtime>, tab_id: TabId, view: &tauri::Webview<Runtime>) {
    use tauri_runtime_cef::RendererEvent;
    let app = app.clone();
    let label = view.label().to_owned();
    let _ = view.with_webview(move |native| {
        native.set_renderer_handler(move |event| match event {
            RendererEvent::Terminated { exit, error_code } => {
                tracing::warn!(%tab_id, ?exit, error_code, "tab renderer terminated");
                // A dead renderer answers no hang question.
                if app.state::<AppState>().crashes.unhang(tab_id, &label) {
                    emit_soon(&app, TabResponsive { tab_id });
                }
                schedule_recovery(&app, tab_id, label.clone(), None, exit.into());
            }
            RendererEvent::Unresponsive(wait) => {
                if app.state::<AppState>().crashes.hang(tab_id, &label, wait) {
                    tracing::warn!(%tab_id, "page stopped responding");
                    emit_soon(&app, TabUnresponsive { tab_id });
                }
            }
            RendererEvent::Responsive => {
                if app.state::<AppState>().crashes.unhang(tab_id, &label) {
                    emit_soon(&app, TabResponsive { tab_id });
                }
            }
        });
    });
}

/// Answer a hung page: keep waiting, or end its renderer. Ending it reports
/// a kill, which is never reloaded on its own; the crash banner offers the
/// reload instead. Must run on the main thread.
#[cfg(feature = "cef")]
pub fn answer_hang(app: &AppHandle<Runtime>, tab_id: TabId, end: bool) -> bool {
    let Some(wait) = app.state::<AppState>().crashes.take_hang(tab_id) else {
        return false;
    };
    if end {
        wait.terminate();
    } else {
        wait.wait();
    }
    // Either way the question is settled; if the page is still stuck when
    // the engine's timer runs out again, it asks again.
    emit_soon(app, TabResponsive { tab_id });
    true
}

/// Listen to a chrome document's renderer. When it dies the window has no
/// tabs, no address bar and no menus, so it is reloaded on a budget, after
/// the cover and overlay masks it left over the pages are taken down.
#[cfg(feature = "cef")]
pub fn attach_chrome(view: &tauri::Webview<Runtime>) {
    use tauri_runtime_cef::RendererEvent;
    let app = view.app_handle().clone();
    let label = view.label().to_owned();
    let _ = view.with_webview(move |native| {
        native.set_renderer_handler(move |event| match event {
            RendererEvent::Terminated { exit, error_code } => {
                tracing::error!(chrome = %label, ?exit, error_code, "chrome renderer terminated");
                let app = app.clone();
                let label = label.clone();
                tauri::async_runtime::spawn(async move {
                    recover_chrome(&app, &label).await;
                });
            }
            RendererEvent::Unresponsive(_) => {
                // Nothing else can draw a question in this window. The engine
                // keeps waiting, which is what the person would pick anyway.
                tracing::warn!(chrome = %label, "chrome stopped responding");
            }
            RendererEvent::Responsive => {
                tracing::info!(chrome = %label, "chrome responds again");
            }
        });
    });
}

#[cfg(feature = "cef")]
async fn recover_chrome(app: &AppHandle<Runtime>, label: &str) {
    let state = app.state::<AppState>();
    let Some(plan) = state.crashes.chrome_crash(label, Instant::now()) else {
        tracing::error!(
            chrome = %label,
            "chrome crashed {MAX_ATTEMPTS} times without a quiet spell; leaving it"
        );
        return;
    };
    // Its overlays and cover belonged to a document that is gone. A page
    // left hidden under a dialog nobody can close would stay hidden for good.
    reset_chrome_cover(app, label);
    tokio::time::sleep(plan.delay).await;
    let reload_app = app.clone();
    let label = label.to_owned();
    let _ = app.run_on_main_thread(move || {
        let Some(view) = reload_app.get_webview(&label) else {
            return;
        };
        tracing::warn!(chrome = %label, attempt = plan.attempt, "reloading the chrome");
        if let Err(error) = view.reload() {
            tracing::error!(chrome = %label, %error, "reloading the chrome failed");
        }
    });
}

/// Take down every overlay and cover `label`'s chrome had up, on the main
/// thread. For a chrome whose document is new: reloaded after a crash, or
/// booting and saying so.
pub fn reset_chrome_cover(app: &AppHandle<Runtime>, label: &str) {
    let task_app = app.clone();
    let label = label.to_owned();
    let _ = app.run_on_main_thread(move || {
        let state = task_app.state::<AppState>();
        if let Some(host) = lock(&state.host).as_mut()
            && let Err(error) = host.reset_chrome_cover(&label)
        {
            tracing::warn!(chrome = %label, %error, "clearing the chrome's cover failed");
        }
    });
}

/// Emit from a task: the renderer callbacks run inside CEF on the main
/// thread, where the event would be dispatched from within the engine.
fn emit_soon<E: Event + Serialize + Clone + Send + 'static>(app: &AppHandle<Runtime>, event: E) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = event.emit(&app);
    });
}

/// Watch a tab's session for renderer crashes and reload within budget.
pub fn watch(app: AppHandle<Runtime>, tab_id: TabId, view_label: String, session: CdpSession) {
    let mut events = session.subscribe_to(&["Inspector.targetCrashed"]);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = session.call0("Inspector.enable").await {
            crate::cdp_feed::setup_failed(tab_id, "renderer crash events", &error);
        }
        loop {
            match events.recv().await {
                Ok(event) => {
                    if event.method == "Inspector.targetCrashed" {
                        // The engine's own report says why; this one does
                        // not. Give it a moment to land first, so an
                        // out-of-memory kill is not reloaded as a crash.
                        let app = app.clone();
                        let label = view_label.clone();
                        let session = session.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(REASON_GRACE).await;
                            schedule_recovery(
                                &app,
                                tab_id,
                                label,
                                Some(session),
                                CrashReason::Unknown,
                            );
                        });
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
    reason: CrashReason,
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
                recover(&worker_app, tab_id, &view_label, &session, planned, reason).await;
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

/// Whether anyone can see `tab_id` right now, in any window. Taken briefly
/// and never across an await.
fn on_screen(app: &AppHandle<Runtime>, tab_id: TabId) -> bool {
    lock(&app.state::<AppState>().host)
        .as_ref()
        .is_some_and(|host| host.showing().contains(&tab_id))
}

/// What to do about one admitted crash, given its budget and whether the
/// tab is on screen. Pure, so the policy can be tested without a renderer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    /// Reload after this long.
    Reload(Plan),
    /// Mark it; reload when the tab is next shown.
    Defer(Plan),
    /// Leave the crash on screen for the person to act on.
    Leave,
}

fn decide(planned: Option<Plan>, reason: CrashReason, visible: bool) -> Action {
    match planned {
        Some(plan) if reason.reloads() && visible => Action::Reload(plan),
        Some(plan) if reason.reloads() => Action::Defer(plan),
        _ => Action::Leave,
    }
}

async fn recover(
    app: &AppHandle<Runtime>,
    tab_id: TabId,
    view_label: &str,
    session: &CdpSession,
    planned: Option<Plan>,
    reason: CrashReason,
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
    let attempt = planned.map_or(MAX_ATTEMPTS, |plan| plan.attempt);
    let plan = match decide(planned, reason, on_screen(app, tab_id)) {
        Action::Leave => {
            if reason.reloads() {
                tracing::warn!(
                    %tab_id,
                    "renderer crashed {MAX_ATTEMPTS} times without {}s of quiet; leaving the tab as it is",
                    QUIET.as_secs()
                );
            } else {
                tracing::warn!(%tab_id, ?reason, "renderer was stopped; not reloading it on its own");
            }
            let notice = TabCrashed {
                tab_id,
                attempt,
                recovering: false,
                reason,
                deferred: false,
            };
            emit_current(app, view_label, notice).await;
            return;
        }
        Action::Defer(plan) => {
            tracing::warn!(%tab_id, "background tab's renderer crashed; reloading it when shown");
            crashes.defer(tab_id, view_label);
            let notice = TabCrashed {
                tab_id,
                attempt: plan.attempt,
                recovering: true,
                reason,
                deferred: true,
            };
            emit_current(app, view_label, notice).await;
            // It may have been brought forward while this was decided;
            // the activation that looked for the mark then did not find it.
            if on_screen(app, tab_id) && crashes.take_deferred(tab_id, view_label) {
                reload_now(app, tab_id, view_label, session).await;
            }
            return;
        }
        Action::Reload(plan) => plan,
    };
    tracing::warn!(
        %tab_id,
        attempt = plan.attempt,
        "renderer crashed; reloading in {}ms",
        plan.delay.as_millis()
    );
    let notice = TabCrashed {
        tab_id,
        attempt: plan.attempt,
        recovering: true,
        reason,
        deferred: false,
    };
    if !emit_current(app, view_label, notice).await {
        return;
    }
    tokio::time::sleep(plan.delay).await;
    reload_now(app, tab_id, view_label, session).await;
}

async fn reload_now(
    app: &AppHandle<Runtime>,
    tab_id: TabId,
    view_label: &str,
    session: &CdpSession,
) {
    if session.is_closed() {
        return;
    }
    if !app
        .state::<AppState>()
        .crashes
        .begin_current_reload(tab_id, view_label)
    {
        return;
    }
    if let Err(e) = session.call0("Page.reload").await {
        tracing::warn!(%tab_id, "reload after a crash failed: {e}");
    }
}

/// A tab is being shown: reload it if its renderer crashed while it was in
/// the background. Called on the main thread with the host held, after the
/// tab's view is in place; the reload itself is the view's own.
pub fn reload_if_deferred(
    crashes: &Registry,
    tab_id: TabId,
    view: &tauri::Webview<Runtime>,
) -> tauri::Result<()> {
    if crashes.take_deferred(tab_id, view.label()) {
        tracing::info!(%tab_id, "reloading a tab that crashed in the background");
        crashes.begin_reload(tab_id);
        view.reload()?;
    }
    Ok(())
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
        let plan = plan(Attempts::default(), now)
            .0
            .expect("a first crash is worth a reload");
        assert_eq!(plan.attempt, 1);
        assert_eq!(plan.delay, BASE_DELAY);
        assert_eq!(plan.next.count, 1);
        assert_eq!(plan.next.last, Some(now));
    }

    #[test]
    fn each_attempt_waits_longer() {
        let now = Instant::now();
        let mut state = Attempts::default();
        let mut delays = Vec::new();
        for _ in 0..MAX_ATTEMPTS {
            let plan = plan(state, now).0.expect("within budget");
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
            last: Some(now),
        };
        assert!(
            plan(spent, now).0.is_none(),
            "a reliably crashing page has to be left alone eventually"
        );
    }

    #[test]
    fn a_crash_after_a_quiet_spell_starts_a_fresh_episode() {
        let morning = Instant::now();
        let spent = Attempts {
            count: MAX_ATTEMPTS,
            last: Some(morning),
        };
        let later = morning + QUIET + Duration::from_secs(1);
        let plan = plan(spent, later)
            .0
            .expect("an unrelated crash gets its own budget");
        assert_eq!(plan.attempt, 1);
        assert_eq!(plan.delay, BASE_DELAY);
        assert_eq!(plan.next.last, Some(later));
    }

    #[test]
    fn a_page_crashing_every_few_seconds_runs_out_and_stays_out() {
        // Measured from the first crash, a thirty-second window handed a page
        // that crashes every twelve seconds a fresh budget every other crash,
        // and it was reloaded forever.
        let mut state = Attempts::default();
        let start = Instant::now();
        let mut reloads = 0;
        for n in 0..50u32 {
            let now = start + Duration::from_secs(12) * n;
            let (planned, next) = plan(state, now);
            reloads += u32::from(planned.is_some());
            state = next;
        }
        assert_eq!(reloads, MAX_ATTEMPTS);
    }

    #[test]
    fn quiet_is_measured_from_the_latest_crash() {
        let start = Instant::now();
        let (_, state) = plan(Attempts::default(), start);
        let (_, state) = plan(state, start + QUIET.saturating_sub(Duration::from_secs(1)));
        let (second, state) = plan(state, start + QUIET + Duration::from_secs(1));
        assert_eq!(
            second.expect("still within budget").attempt,
            3,
            "the second crash was recent, so the third continues the episode"
        );
        assert_eq!(state.count, 3);
    }

    #[test]
    fn only_a_crash_is_reloaded_on_its_own_and_only_where_it_is_seen() {
        let (Some(plan), _) = plan(Attempts::default(), Instant::now()) else {
            panic!("a first crash is within budget");
        };
        assert_eq!(
            decide(Some(plan), CrashReason::Crashed, true),
            Action::Reload(plan)
        );
        assert_eq!(
            decide(Some(plan), CrashReason::Unknown, true),
            Action::Reload(plan)
        );
        assert_eq!(
            decide(Some(plan), CrashReason::Crashed, false),
            Action::Defer(plan),
            "a background tab waits until it is shown"
        );
        for reason in [CrashReason::OutOfMemory, CrashReason::Killed] {
            assert_eq!(decide(Some(plan), reason, true), Action::Leave);
            assert_eq!(decide(Some(plan), reason, false), Action::Leave);
        }
        assert_eq!(decide(None, CrashReason::Crashed, true), Action::Leave);
    }

    #[test]
    fn a_deferred_reload_belongs_to_the_view_that_crashed() {
        let registry = Registry::default();
        let tab = TabId::new();
        registry.bind_view(tab, "view-1");
        registry.defer(tab, "stale");
        assert!(!registry.take_deferred(tab, "stale"));
        registry.defer(tab, "view-1");
        assert!(!registry.take_deferred(tab, "view-2"));
        assert!(registry.take_deferred(tab, "view-1"));
        assert!(!registry.take_deferred(tab, "view-1"), "owed once");
        registry.defer(tab, "view-1");
        registry.bind_view(tab, "view-2");
        assert!(
            !registry.take_deferred(tab, "view-1"),
            "a rebuilt view starts fresh"
        );
    }

    #[test]
    fn a_chrome_has_its_own_budget() {
        let registry = Registry::default();
        let now = Instant::now();
        for _ in 0..MAX_ATTEMPTS {
            assert!(registry.chrome_crash("chrome", now).is_some());
        }
        assert!(registry.chrome_crash("chrome", now).is_none());
        assert!(
            registry.chrome_crash("chrome-pop-1", now).is_some(),
            "one window's chrome does not spend another's"
        );
        assert!(
            registry.chrome_crash("chrome", now + QUIET).is_some(),
            "a quiet spell restores it"
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
