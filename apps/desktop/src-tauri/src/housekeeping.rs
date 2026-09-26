//! Background chores: discard idle `Today` tabs, tear down their views, and
//! put them back where they were when they wake.

use std::time::Duration;

use dive_core::{CoreEvent, Tab, TabId, Timestamp};
use tauri::{AppHandle, Manager};

use crate::Runtime;
use crate::state::{AppState, lock};

/// Idle window before a `Today` tab is discarded, unless overridden.
pub const DEFAULT_MAX_IDLE: time::Duration = time::Duration::hours(1);
/// How often the sweep runs, unless overridden.
pub const DEFAULT_EVERY: Duration = Duration::from_secs(60);
/// How long one page may take to answer a sweep-time question.
const PAGE_QUESTION: Duration = Duration::from_millis(400);
/// How long a waking page may take to load before its scroll is restored anyway.
const WAKE_LOAD: Duration = Duration::from_secs(20);
/// How long a scroll restore waits for a fresh view's devtools session.
const SESSION_WAIT_STEP: Duration = Duration::from_millis(100);
const SESSION_WAIT_TRIES: u32 = 50;
/// How long a `Today` tab may sit unfocused once the system says memory is
/// getting short: minutes rather than the usual hour.
pub const WARN_IDLE: time::Duration = time::Duration::minutes(5);
/// Live page views kept at most. Each is a renderer, and past a few dozen
/// the machine is paging for tabs nobody is looking at; the oldest hidden
/// `Today` tabs beyond this are put to sleep whatever their idle time.
pub const LIVE_CAP: usize = 30;
/// Sweeps in a row a hidden page may fail to answer the activity question
/// before it is put to sleep without an answer. A renderer that hangs never
/// says it is idle, and used to be kept alive, hung, for good.
pub const UNANSWERED_BEFORE_FORCE: u32 = 3;

/// How hard a sweep reaches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    /// The regular sweep: `Today` tabs idle past [`max_idle`].
    Idle,
    /// The system warned that memory is short: `Today` tabs idle past
    /// [`WARN_IDLE`].
    Warn,
    /// The system is about to kill processes: every hidden tab that nothing
    /// protects, of any tier, however recently it was used.
    Critical,
    /// More live views than [`LIVE_CAP`]: the oldest hidden `Today` tabs,
    /// however recently they were used, until the count is back under it.
    OverCap,
}

impl Reach {
    /// How long a candidate must have sat unfocused.
    pub fn idle(self) -> time::Duration {
        match self {
            Self::Idle => max_idle(),
            Self::Warn => WARN_IDLE,
            Self::Critical | Self::OverCap => time::Duration::ZERO,
        }
    }

    /// Which tiers it may take.
    pub fn scope(self) -> dive_core::DiscardScope {
        if self == Self::Critical {
            dive_core::DiscardScope::AnyTier
        } else {
            dive_core::DiscardScope::Today
        }
    }
}

/// Hidden tabs whose page has not answered the activity question, and how
/// many sweeps in a row it has not.
fn unanswered() -> &'static std::sync::Mutex<std::collections::HashMap<TabId, u32>> {
    static UNANSWERED: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<TabId, u32>>,
    > = std::sync::OnceLock::new();
    UNANSWERED.get_or_init(Default::default)
}

/// Count one more unanswered question for `tab`; true once it has gone
/// unanswered often enough to be put to sleep anyway.
fn note_unanswered(tab: TabId) -> bool {
    let mut misses = lock(unanswered());
    let count = misses.entry(tab).or_default();
    *count += 1;
    *count >= UNANSWERED_BEFORE_FORCE
}

/// `tab` answered, or is gone: start its count over.
pub fn forget_unanswered(tab: TabId) {
    lock(unanswered()).remove(&tab);
}

/// How long a `Today` tab may sit unfocused before it is discarded.
/// `DIVE_MAX_IDLE_SECS` overrides it so a harness can force a sweep.
pub fn max_idle() -> time::Duration {
    env_secs("DIVE_MAX_IDLE_SECS").map_or(DEFAULT_MAX_IDLE, time::Duration::seconds)
}

fn every() -> Duration {
    env_secs("DIVE_SWEEP_SECS")
        .filter(|s| *s > 0)
        .map_or(DEFAULT_EVERY, |s| Duration::from_secs(s.unsigned_abs()))
}

fn env_secs(key: &str) -> Option<i64> {
    std::env::var(key).ok()?.trim().parse().ok()
}

/// Sweeps between history prunes: hourly at the default one-minute sweep.
const PRUNE_EVERY_SWEEPS: u32 = 60;

/// Start the periodic sweep.
pub fn start(app: AppHandle<Runtime>) {
    // The system's own word that memory is short sweeps at once, and harder.
    crate::memory_pressure::watch(app.clone());
    // Once per launch: frames a crashed recording left behind.
    tauri::async_runtime::spawn_blocking(crate::screencast::sweep_stale_work_dirs);
    tauri::async_runtime::spawn(async move {
        let mut sweeps: u32 = 0;
        loop {
            tokio::time::sleep(every()).await;
            match sweep(&app).await {
                Ok(0) => {}
                Ok(n) => tracing::info!(n, "discarded idle tabs"),
                Err(e) => tracing::warn!("discard sweep failed: {e}"),
            }
            // History retention is measured in days; pruning it on every
            // one-minute sweep was a SQLite transaction a minute for the life
            // of the process. Once an hour is plenty -- but the first time
            // comes with the first sweep, a minute after launch, rather than
            // an hour in: a session shorter than that never pruned at all.
            sweeps = sweeps.wrapping_add(1);
            if sweeps != 1 && !sweeps.is_multiple_of(PRUNE_EVERY_SWEEPS) {
                continue;
            }
            let app = app.clone();
            // A blocking thread, not this task's worker: a first prune under
            // a newly shortened retention can be a large delete.
            if let Err(e) = tauri::async_runtime::spawn_blocking(move || prune(&app)).await {
                tracing::warn!("history prune did not finish: {e}");
            }
        }
    });
}

/// The periodic clean-up of what is kept past its time: visits beyond the
/// retention window, conversations whose tab is gone, and icons nothing
/// wears any more.
fn prune(app: &AppHandle<Runtime>) {
    let state = app.state::<AppState>();
    match crate::prefs::prune_history(&state) {
        Ok(0) => {}
        Ok(n) => tracing::info!(n, "pruned history past the retention window"),
        Err(e) => tracing::warn!("history prune failed: {e}"),
    }
    crate::agent::prune_threads(&state);
    match lock(&state.store).prune_favicon_images() {
        Ok(0) => {}
        Ok(n) => tracing::debug!(n, "dropped icons nothing wears"),
        Err(e) => tracing::warn!("icon prune failed: {e}"),
    }
}

/// Why an idle tab is still kept alive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Keep {
    /// It is the tab on screen.
    Showing,
    /// It shows a server on this machine, which a developer is iterating on.
    LocalDevServer,
    /// A screen recording or step recording is running on it.
    Recording,
    /// An agent run in flight has worked on it, and may again.
    AgentBusy,
    /// Something on the page is playing sound.
    Audible,
}

/// What the sweep knows about one candidate when it decides.
#[derive(Debug, Clone, Copy)]
#[allow(clippy::struct_excessive_bools)] // independent safety signals, not one state machine
pub struct Signals {
    /// The tab currently shown, if any.
    pub showing: Option<TabId>,
    /// Whether a recording targets the tab.
    pub recording: bool,
    /// Whether an agent run in flight has worked on this tab.
    pub agent_busy: bool,
    /// Whether the page reports playing media.
    pub audible: bool,
    /// Whether local dev-server pages are exempt. Always on for users;
    /// `DIVE_DISCARD_LOCAL_TABS=1` lets a harness on loopback exercise
    /// the sweep.
    pub protect_local: bool,
}

impl Default for Signals {
    fn default() -> Self {
        Self {
            showing: None,
            recording: false,
            agent_busy: false,
            audible: false,
            protect_local: true,
        }
    }
}

/// The rule that keeps an idle tab alive, if any applies.
pub fn keep_reason(tab: &Tab, s: Signals) -> Option<Keep> {
    if s.showing == Some(tab.id) {
        Some(Keep::Showing)
    } else if s.protect_local && crate::devservers::is_local_url(&tab.url) {
        Some(Keep::LocalDevServer)
    } else if s.recording {
        Some(Keep::Recording)
    } else if s.agent_busy {
        Some(Keep::AgentBusy)
    } else if s.audible {
        Some(Keep::Audible)
    } else {
        None
    }
}

/// Discard only fully observed idle tabs. Native close is requested under the
/// host -> store lock order on the main thread; native destruction is awaited
/// without either lock. A fresh renderer/activation invalidates finalization.
pub async fn sweep(app: &AppHandle<Runtime>) -> dive_core::Result<usize> {
    let mut count = sweep_with(app, Reach::Idle, usize::MAX).await?;
    // Idle time alone lets a burst of fresh tabs pile up views without end.
    let live = lock(&app.state::<AppState>().host)
        .as_ref()
        .map_or(0, crate::engine::TabHost::live_views);
    if live > LIVE_CAP {
        count += sweep_with(app, Reach::OverCap, live - LIVE_CAP).await?;
    }
    Ok(count)
}

/// Discard up to `limit` tabs within `reach`, oldest first.
pub async fn sweep_with(
    app: &AppHandle<Runtime>,
    reach: Reach,
    limit: usize,
) -> dive_core::Result<usize> {
    let candidates = lock(&app.state::<AppState>().store).discard_candidates(
        Timestamp::now(),
        reach.idle(),
        reach.scope(),
    )?;
    let mut count = 0;
    for tab in candidates {
        if count >= limit {
            break;
        }
        #[cfg(feature = "cef")]
        if discard_one(app, tab, reach).await? {
            count += 1;
        }
        #[cfg(not(feature = "cef"))]
        let _ = tab; // Unknown native activity/close confirmation: keep alive.
    }
    Ok(count)
}

fn protected(state: &AppState, host: &crate::engine::TabHost, tab: &Tab) -> bool {
    let signals = Signals {
        showing: host.showing().contains(&tab.id).then_some(tab.id),
        recording: state.screencast.is_recording(tab.id) || state.buffers.is_recording(tab.id),
        agent_busy: lock(&state.agent_runs)
            .values()
            .any(|run| run.scope.touches(tab.id)),
        // The page's own report, which the tab strip's speaker also comes from;
        // the renderer snapshot and native audio are checked separately.
        audible: crate::tab_audio::is_audible(tab.id),
        protect_local: std::env::var("DIVE_DISCARD_LOCAL_TABS").as_deref() != Ok("1"),
    };
    keep_reason(tab, signals).is_some() || state.inspector.active(tab.id)
}

/// Marshal a short transaction to the runtime's guarded main-task callback.
/// Cancelled work is never started after a caller has stopped waiting.
#[cfg(feature = "cef")]
async fn on_main<T: Send + 'static>(
    app: &AppHandle<Runtime>,
    f: impl FnOnce(&AppState) -> dive_core::Result<T> + Send + 'static,
) -> dive_core::Result<T> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if tx.is_closed() {
            return;
        }
        let result = if crate::engine::MainThread::here().is_some() {
            f(&handle.state::<AppState>())
        } else {
            Err(dive_core::CoreError::Invalid(
                "discard reached wrong thread".into(),
            ))
        };
        let _ = tx.send(result);
    })
    .map_err(|e| dive_core::CoreError::Invalid(e.to_string()))?;
    rx.await
        .map_err(|e| dive_core::CoreError::Invalid(e.to_string()))?
}

#[cfg(feature = "cef")]
async fn discard_one(app: &AppHandle<Runtime>, tab: Tab, reach: Reach) -> dive_core::Result<bool> {
    use cef::ImplBrowser;
    let state = app.state::<AppState>();
    let Some((session, ticket, view)) = ({
        let host = lock(&state.host);
        host.as_ref().and_then(|host| {
            if host.showing().contains(&tab.id) {
                // Touch just this column; never upsert an old Tab snapshot.
                let _ = lock(&state.store).touch_tab_activity(tab.id, Timestamp::now());
            }
            if protected(&state, host, &tab) {
                return None;
            }
            Some((
                host.cdp(tab.id)?,
                state.activity.ticket(tab.id)?,
                host.with_view(tab.id, |view| Ok(view.clone())).ok()?,
            ))
        })
    }) else {
        return Ok(false);
    };
    let Some(scroll) = idle_scroll(&state, &session, &tab).await else {
        return Ok(false);
    };
    let observed = std::time::Instant::now();
    // Obtain the native handle through the supported runtime bridge. The
    // callback is asynchronous here; never synchronously wait under host/store.
    let (native_tx, native_rx) = tokio::sync::oneshot::channel();
    if view
        .with_webview(move |view| {
            let _ = native_tx.send(view.browser());
        })
        .is_err()
    {
        return Ok(false);
    }
    let Ok(Ok(native)) = tokio::time::timeout(PAGE_QUESTION, native_rx).await else {
        return Ok(false);
    };
    let close_native = native.clone();
    let close_tab = tab.clone();
    let close_ticket = ticket.clone();
    let started = tokio::time::timeout(
        PAGE_QUESTION,
        on_main(app, move |state| {
            if observed.elapsed() > PAGE_QUESTION {
                return Ok(false);
            }
            request_discard(
                state,
                reach,
                &close_tab,
                &close_ticket,
                scroll,
                &close_native,
                observed,
            )
        }),
    )
    .await;
    let Ok(started) = started else {
        return Ok(false);
    };
    let started = started?;
    if !started {
        return Ok(false);
    }
    // CEF acknowledges the close to the runtime, not to the app, so the
    // receipt is still polled -- but backing off. A close usually lands
    // within a few tens of milliseconds; one that does not is a busy
    // renderer, and asking every 50 ms for five seconds put a hundred hops
    // on the main thread while it was already struggling.
    let receipt = tokio::time::timeout(Duration::from_secs(5), async {
        let mut pause = Duration::from_millis(20);
        loop {
            let native = native.clone();
            if on_main(app, move |_| Ok(native.is_valid() == 0)).await? {
                return Ok::<_, dive_core::CoreError>(());
            }
            tokio::time::sleep(pause).await;
            pause = next_receipt_pause(pause);
        }
    })
    .await;
    if !matches!(receipt, Ok(Ok(()))) {
        tracing::warn!(id = %tab.id, "native discard close not confirmed; persisted tab remains active");
        // The native browser was already told to close; release the Tauri
        // webview entry too so its label and listeners do not outlive it.
        let unconfirmed = view.clone();
        let _ = on_main(app, move |_| {
            let _ = unconfirmed.close();
            Ok(())
        })
        .await;
        return Ok(false);
    }
    on_main(app, move |state| {
        finish_discard(state, reach, &tab, &ticket, scroll, &view)
    })
    .await
}

/// Where an idle page is scrolled, or `None` when it is not idle (or cannot
/// say yet). A hidden page that does not answer at all is hung: it is asked
/// again next sweep, and put to sleep once it has stayed silent long
/// enough, where it used to be kept alive forever. Its last known scroll is
/// what it wakes to.
#[cfg(feature = "cef")]
async fn idle_scroll(
    state: &AppState,
    session: &dive_cdp::CdpSession,
    tab: &Tab,
) -> Option<(i32, i32)> {
    match crate::activity::probe_answer(session).await {
        Ok(Some(page)) if page.idle_for(&tab.url) => {
            forget_unanswered(tab.id);
            Some((page.scroll[0], page.scroll[1]))
        }
        Ok(_) => {
            forget_unanswered(tab.id);
            None
        }
        Err(()) => {
            if !note_unanswered(tab.id) {
                return None;
            }
            tracing::warn!(id = %tab.id, "hidden page stopped answering; putting it to sleep");
            Some(
                lock(&state.store)
                    .scroll(tab.id, &tab.url)
                    .ok()
                    .flatten()
                    .unwrap_or((0, 0)),
            )
        }
    }
}

/// The wait before asking again whether a discarded browser has closed:
/// doubling, up to half a second.
#[cfg(feature = "cef")]
fn next_receipt_pause(pause: Duration) -> Duration {
    (pause * 2).min(Duration::from_millis(500))
}

/// Finalize only after native receipt, always unregistering the old label.
#[cfg(feature = "cef")]
fn finish_discard(
    state: &AppState,
    reach: Reach,
    tab: &Tab,
    ticket: &crate::activity::Ticket,
    scroll: (i32, i32),
    view: &tauri::Webview<Runtime>,
) -> dive_core::Result<bool> {
    // Direct CEF close does not unregister Tauri's webview manager entry.
    // Now that native destruction is confirmed, the redundant close also
    // removes that entry. Always clean the old label, even after a reopen.
    view.close()
        .map_err(|e| dive_core::CoreError::Invalid(e.to_string()))?;
    let host = lock(&state.host);
    if !state.activity.is_closing(tab.id, ticket)
        || host.as_ref().is_some_and(|host| host.has(tab.id))
    {
        return Ok(false);
    }
    let store = lock(&state.store);
    let discarded = store.discard_candidate_in(
        reach.scope(),
        tab,
        Timestamp::now() - reach.idle(),
        scroll,
        || Ok(()),
    )?;
    drop(store);
    if let Some(tab) = discarded {
        state.activity.drop_tab(tab.id);
        state.buffers.drop_tab(tab.id);
        state.inspector.drop_tab(tab.id);
        state.crashes.drop_tab(tab.id);
        forget_unanswered(tab.id);
        state.bus.publish(CoreEvent::TabUpserted(tab));
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Last safety check and native request run together on the main thread.
#[cfg(feature = "cef")]
fn request_discard(
    state: &AppState,
    reach: Reach,
    tab: &Tab,
    ticket: &crate::activity::Ticket,
    scroll: (i32, i32),
    native: &cef::Browser,
    observed: std::time::Instant,
) -> dive_core::Result<bool> {
    use cef::{ImplBrowser, ImplBrowserHost};
    let mut host = lock(&state.host);
    let Some(host) = host.as_mut() else {
        return Ok(false);
    };
    let store = lock(&state.store);
    if protected(state, host, tab)
        || !host.has(tab.id)
        || !state.activity.current(tab.id, ticket)
        || crate::activity::exempt(&store, tab)?
        || native.is_valid() == 0
        || native.is_loading() != 0
    {
        return Ok(false);
    }
    let Some(native_host) = native.host() else {
        return Ok(false);
    };
    if native_host.has_dev_tools() != 0 {
        return Ok(false);
    }
    let mut native_requested = false;
    let cutoff = Timestamp::now() - reach.idle();
    let prepared = store.prepare_discard_in(reach.scope(), tab, cutoff, scroll, || {
        if observed.elapsed() > PAGE_QUESTION || !state.activity.begin_close(tab.id, ticket) {
            return Err(dive_core::CoreError::Invalid(
                "activity changed before native discard".into(),
            ));
        }
        // CEF force_close bypasses beforeunload veto; the guard already
        // protects forms/unload handlers. This is a request, not a receipt.
        native_requested = true;
        native_host.close_browser(1);
        Ok(())
    });
    if native_requested {
        // Activation now sees a missing view and opens a new session. Its
        // new token prevents this old close from discarding that session.
        host.forget_closed(tab.id);
    }
    prepared
}

/// Evaluate `expr` in the page, giving up quietly if it does not answer in time.
async fn evaluate(session: &dive_cdp::CdpSession, expr: &str) -> Option<serde_json::Value> {
    let call = session.call(
        "Runtime.evaluate",
        serde_json::json!({ "expression": expr, "returnByValue": true }),
    );
    let reply = tokio::time::timeout(PAGE_QUESTION, call).await.ok()?.ok()?;
    reply.get("result")?.get("value").cloned()
}

/// Where the page is scrolled right now, or `None` when it does not answer
/// within the usual page-question budget (a hung or closing page).
pub async fn page_scroll(session: &dive_cdp::CdpSession) -> Option<(i32, i32)> {
    let value = evaluate(
        session,
        "[Math.round(window.scrollX), Math.round(window.scrollY)]",
    )
    .await?;
    let xy = value.as_array()?;
    let at = |i: usize| {
        xy.get(i)?
            .as_i64()
            .map(|n| i32::try_from(n).unwrap_or(i32::MAX))
    };
    Some((at(0)?, at(1)?))
}

/// After `tab` wakes from a discard (or comes back from the closed-tab
/// stack), scroll it back to where it was once its page has loaded. A page
/// that has already finished loading is scrolled at once.
pub fn restore_scroll(app: AppHandle<Runtime>, tab: TabId) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let target = {
            let store = lock(&state.store);
            store.tab(tab).ok().and_then(|t| {
                store
                    .scroll(t.id, &t.url)
                    .ok()
                    .flatten()
                    .map(|xy| (t.url, xy))
            })
        };
        let Some((url, (x, y))) = target else {
            return;
        };
        // The view was just created; its devtools session comes a moment
        // later. Giving up at once here is how a restore quietly did nothing.
        let mut session = None;
        for _ in 0..SESSION_WAIT_TRIES {
            session = lock(&state.host).as_ref().and_then(|h| h.cdp(tab));
            if session.is_some() {
                break;
            }
            tokio::time::sleep(SESSION_WAIT_STEP).await;
        }
        let Some(session) = session else {
            tracing::debug!(%tab, "no devtools session for scroll restore");
            return;
        };
        tracing::debug!(%tab, x, y, "scroll restore: session ready");
        if (x, y) == (0, 0) {
            return;
        }
        let mut events = session.subscribe();
        if let Err(e) = session.call0("Page.enable").await {
            tracing::debug!(%tab, "Page.enable before scroll restore failed: {e}");
        }
        // The load may already be over (a fast local page, or a reopen that
        // ran ahead of this task); then the wait would only add a delay. The
        // document must be the tab's page, though: a fresh view answers
        // "complete" for its initial blank document, and scrolling that is
        // undone the moment the real page arrives.
        let ready = evaluate(
            &session,
            "document.readyState === 'complete' ? location.href : ''",
        )
        .await;
        tracing::debug!(%tab, ?ready, %url, "scroll restore: readiness");
        if ready.as_ref().and_then(|v| v.as_str()) == Some(url.as_str()) {
            let done = scroll_until_it_holds(&session, x, y).await;
            tracing::debug!(%tab, done, "scroll restore: scrolled at once");
            return;
        }
        // Wait for the load of the tab's page, not the initial blank
        // document's: a fresh view fires a load event for about:blank first,
        // and scrolling that is undone when the real page arrives.
        let loaded = async {
            loop {
                match events.recv().await {
                    Ok(ev) if ev.method == "Page.loadEventFired" => {
                        // The page, or wherever it redirected to; not the blank start.
                        let here = evaluate(&session, "location.href").await;
                        match here.as_ref().and_then(|v| v.as_str()) {
                            Some("about:blank") | None => {}
                            Some(_) => break,
                        }
                    }
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        };
        let waited = tokio::time::timeout(WAKE_LOAD, loaded).await;
        let done = scroll_until_it_holds(&session, x, y).await;
        tracing::debug!(%tab, timed_out = waited.is_err(), done, "scroll restore: scrolled after load");
    });
}

/// How long a restore keeps trying while the page grows to its full height.
const SCROLL_SETTLE: Duration = Duration::from_millis(250);
const SCROLL_TRIES: u32 = 12;

/// Scroll to `(x, y)` and check it took. A page whose content arrives after
/// load (lazy sections, client-side rendering) is too short to scroll at
/// first, so this tries again for a few seconds, like Chrome's own restore.
async fn scroll_until_it_holds(session: &dive_cdp::CdpSession, x: i32, y: i32) -> bool {
    for _ in 0..SCROLL_TRIES {
        let landed = evaluate(
            session,
            &format!("window.scrollTo({x}, {y}); [Math.round(window.scrollX), Math.round(window.scrollY)]"),
        )
        .await;
        let at = |i: usize| landed.as_ref()?.as_array()?.get(i)?.as_i64();
        if at(0).is_some_and(|sx| (sx - i64::from(x)).abs() <= 1)
            && at(1).is_some_and(|sy| (sy - i64::from(y)).abs() <= 1)
        {
            return true;
        }
        tokio::time::sleep(SCROLL_SETTLE).await;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use dive_core::WorkspaceId;

    #[test]
    fn a_silent_hidden_page_is_put_to_sleep_only_after_staying_silent() {
        let tab = TabId::new();
        for _ in 1..UNANSWERED_BEFORE_FORCE {
            assert!(!note_unanswered(tab));
        }
        assert!(note_unanswered(tab));
        // One answer is enough to start the count over.
        forget_unanswered(tab);
        assert!(!note_unanswered(tab));
        forget_unanswered(tab);
    }

    #[test]
    fn the_regular_sweep_keeps_its_hour() {
        assert_eq!(Reach::Idle.idle(), max_idle());
        assert_eq!(Reach::OverCap.idle(), time::Duration::ZERO);
    }

    fn tab(url: &str) -> Tab {
        Tab::new(WorkspaceId::new(), url, 0)
    }

    #[cfg(feature = "cef")]
    #[test]
    fn a_slow_close_is_asked_about_less_and_less_often() {
        let mut pause = Duration::from_millis(20);
        let mut waited = Duration::ZERO;
        let mut asked = 0;
        while waited < Duration::from_secs(5) {
            asked += 1;
            waited += pause;
            pause = next_receipt_pause(pause);
        }
        assert_eq!(pause, Duration::from_millis(500), "the pause is capped");
        assert!(asked <= 16, "{asked} hops in five seconds, not a hundred");
    }

    #[test]
    fn plain_idle_tab_is_discarded() {
        assert_eq!(
            keep_reason(&tab("https://example.com"), Signals::default()),
            None
        );
    }

    #[test]
    fn showing_tab_wins_over_every_other_reason() {
        let t = tab("http://localhost:3000");
        let s = Signals {
            showing: Some(t.id),
            recording: true,
            agent_busy: true,
            audible: true,
            protect_local: true,
        };
        assert_eq!(keep_reason(&t, s), Some(Keep::Showing));
    }

    #[test]
    fn each_safety_rule_keeps_the_tab() {
        let t = tab("https://example.com");
        assert_eq!(
            keep_reason(&tab("http://127.0.0.1:5173/"), Signals::default()),
            Some(Keep::LocalDevServer)
        );
        assert_eq!(
            keep_reason(
                &t,
                Signals {
                    recording: true,
                    ..Signals::default()
                }
            ),
            Some(Keep::Recording)
        );
        assert_eq!(
            keep_reason(
                &t,
                Signals {
                    agent_busy: true,
                    ..Signals::default()
                }
            ),
            Some(Keep::AgentBusy)
        );
        assert_eq!(
            keep_reason(
                &t,
                Signals {
                    audible: true,
                    ..Signals::default()
                }
            ),
            Some(Keep::Audible)
        );
    }

    #[test]
    fn a_harness_may_switch_the_local_exemption_off() {
        let t = tab("http://127.0.0.1:5173/");
        let s = Signals {
            protect_local: false,
            ..Signals::default()
        };
        assert_eq!(keep_reason(&t, s), None);
    }

    #[test]
    fn idle_window_defaults_to_one_hour() {
        assert_eq!(DEFAULT_MAX_IDLE, time::Duration::hours(1));
        assert_eq!(DEFAULT_EVERY, Duration::from_secs(60));
    }
}
