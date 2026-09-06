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

/// Start the periodic sweep.
pub fn start(app: AppHandle<Runtime>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(every()).await;
            match sweep(&app).await {
                Ok(0) => {}
                Ok(n) => tracing::info!(n, "discarded idle tabs"),
                Err(e) => tracing::warn!("discard sweep failed: {e}"),
            }
            let state = app.state::<AppState>();
            match crate::prefs::prune_history(&state) {
                Ok(0) => {}
                Ok(n) => tracing::info!(n, "pruned history past the retention window"),
                Err(e) => tracing::warn!("history prune failed: {e}"),
            }
        }
    });
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
    /// An agent run is in flight and may be driving it.
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
    /// Whether any agent run is in flight.
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
    let candidates =
        lock(&app.state::<AppState>().store).idle_tab_candidates(Timestamp::now(), max_idle())?;
    let mut count = 0;
    for tab in candidates {
        #[cfg(feature = "cef")]
        if discard_one(app, tab).await? {
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
        agent_busy: !lock(&state.agent_runs).is_empty(),
        audible: false, // Renderer snapshot and native audio are checked separately.
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
async fn discard_one(app: &AppHandle<Runtime>, tab: Tab) -> dive_core::Result<bool> {
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
    let Some(page) = crate::activity::probe(&session)
        .await
        .filter(|page| page.idle_for(&tab.url))
    else {
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
    let scroll = (page.scroll[0], page.scroll[1]);
    let started = tokio::time::timeout(
        PAGE_QUESTION,
        on_main(app, move |state| {
            if observed.elapsed() > PAGE_QUESTION {
                return Ok(false);
            }
            request_discard(
                state,
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
    let receipt = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let native = native.clone();
            if on_main(app, move |_| Ok(native.is_valid() == 0)).await? {
                return Ok::<_, dive_core::CoreError>(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
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
        finish_discard(state, &tab, &ticket, scroll, &view)
    })
    .await
}

/// Finalize only after native receipt, always unregistering the old label.
#[cfg(feature = "cef")]
fn finish_discard(
    state: &AppState,
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
    let discarded =
        store.discard_candidate(tab, Timestamp::now() - max_idle(), scroll, || Ok(()))?;
    drop(store);
    if let Some(tab) = discarded {
        state.activity.drop_tab(tab.id);
        state.buffers.drop_tab(tab.id);
        state.inspector.drop_tab(tab.id);
        state.crashes.drop_tab(tab.id);
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
    let prepared = store.prepare_discard(tab, Timestamp::now() - max_idle(), scroll, || {
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

/// After `tab` wakes from a discard, scroll it back to where it was once its
/// page has loaded. Spawned right after the view is recreated, so the wait
/// starts before the first navigation goes out.
pub fn restore_scroll(app: AppHandle<Runtime>, tab: TabId) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let (session, target) = {
            let session = lock(&state.host).as_ref().and_then(|h| h.cdp(tab));
            let store = lock(&state.store);
            let target = store
                .tab(tab)
                .ok()
                .and_then(|t| store.scroll(t.id, &t.url).ok().flatten());
            (session, target)
        };
        let (Some(session), Some((x, y))) = (session, target) else {
            return;
        };
        if (x, y) == (0, 0) {
            return;
        }
        let mut events = session.subscribe();
        if let Err(e) = session.call0("Page.enable").await {
            tracing::debug!(%tab, "Page.enable before scroll restore failed: {e}");
        }
        let loaded = async {
            loop {
                match events.recv().await {
                    Ok(ev) if ev.method == "Page.loadEventFired" => break,
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        };
        let _ = tokio::time::timeout(WAKE_LOAD, loaded).await;
        let _ = evaluate(&session, &format!("window.scrollTo({x}, {y}); true")).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use dive_core::WorkspaceId;

    fn tab(url: &str) -> Tab {
        Tab::new(WorkspaceId::new(), url, 0)
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
