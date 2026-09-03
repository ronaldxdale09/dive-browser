//! Background chores: discard idle `Today` tabs, tear down their views, and
//! put them back where they were when they wake.

use std::time::Duration;

use dive_core::{CoreEvent, Tab, TabId, TabState, Timestamp};
use tauri::{AppHandle, Manager};

use crate::Runtime;
use crate::state::{AppState, lock};

/// Idle window before a `Today` tab is discarded, unless overridden.
pub const DEFAULT_MAX_IDLE: time::Duration = time::Duration::minutes(30);
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
#[derive(Debug, Clone, Copy, Default)]
pub struct Signals {
    /// The tab currently shown, if any.
    pub showing: Option<TabId>,
    /// Whether a recording targets the tab.
    pub recording: bool,
    /// Whether any agent run is in flight.
    pub agent_busy: bool,
    /// Whether the page reports playing media.
    pub audible: bool,
}

/// The rule that keeps an idle tab alive, if any applies.
pub fn keep_reason(tab: &Tab, s: Signals) -> Option<Keep> {
    if s.showing == Some(tab.id) {
        Some(Keep::Showing)
    } else if crate::devservers::is_local_url(&tab.url) {
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

/// Discard idle tabs in every workspace, close their engine views, and
/// announce the changes. Returns how many tabs were discarded.
pub async fn sweep(app: &AppHandle<Runtime>) -> dive_core::Result<usize> {
    let state = app.state::<AppState>();
    let candidates = lock(&state.store).idle_tab_candidates(Timestamp::now(), max_idle())?;
    if candidates.is_empty() {
        return Ok(0);
    }
    // Every tab on screen in any window or pane counts as being looked at.
    let showing_all = lock(&state.host)
        .as_ref()
        .map(crate::engine::TabHost::showing)
        .unwrap_or_default();
    let agent_busy = !lock(&state.agent_runs).is_empty();

    let mut discard = Vec::new();
    for tab in candidates {
        let session = lock(&state.host).as_ref().and_then(|h| h.cdp(tab.id));
        let audible = match &session {
            Some(s) => is_audible(s).await,
            None => false,
        };
        let showing = showing_all.contains(&tab.id).then_some(tab.id);
        let signals = Signals {
            showing,
            recording: state.screencast.is_recording(tab.id) || state.buffers.is_recording(tab.id),
            agent_busy,
            audible,
        };
        match keep_reason(&tab, signals) {
            Some(Keep::Showing) => {
                // The user is looking at it: count that as activity.
                let mut keep = tab.clone();
                keep.state = TabState::Active;
                keep.last_active_at = Timestamp::now();
                lock(&state.store).upsert_tab(&keep)?;
            }
            Some(why) => tracing::debug!(id = %tab.id, ?why, "idle tab kept"),
            None => {
                if let Some(s) = &session
                    && let Some((x, y)) = read_scroll(s).await
                {
                    lock(&state.store).set_scroll(tab.id, &tab.url, x, y)?;
                }
                discard.push(tab.id);
            }
        }
    }
    if discard.is_empty() {
        return Ok(0);
    }
    let discarded = lock(&state.store).discard_tabs(&discard)?;
    for tab in discarded.iter().cloned() {
        if let Some(host) = lock(&state.host).as_mut()
            && host.has(tab.id)
            && let Err(e) = host.close(tab.id)
        {
            tracing::warn!(id = %tab.id, "failed to close discarded view: {e}");
        }
        state.buffers.drop_tab(tab.id);
        state.inspector.drop_tab(tab.id);
        state.crashes.drop_tab(tab.id);
        state.bus.publish(CoreEvent::TabUpserted(tab));
    }
    Ok(discarded.len())
}

/// Ask the page whether any media element is playing with sound.
async fn is_audible(session: &dive_cdp::CdpSession) -> bool {
    const EXPR: &str = "Array.from(document.querySelectorAll('audio,video'))\
        .some(m => !m.paused && !m.ended && !m.muted && m.volume > 0)";
    evaluate(session, EXPR)
        .await
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Where the page is scrolled, rounded to whole pixels.
async fn read_scroll(session: &dive_cdp::CdpSession) -> Option<(i32, i32)> {
    let v = evaluate(
        session,
        "[Math.round(window.scrollX), Math.round(window.scrollY)]",
    )
    .await?;
    let arr = v.as_array()?;
    let x = i32::try_from(arr.first()?.as_i64()?).ok()?;
    let y = i32::try_from(arr.get(1)?.as_i64()?).ok()?;
    Some((x, y))
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
            while let Ok(ev) = events.recv().await {
                if ev.method == "Page.loadEventFired" {
                    break;
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
    fn idle_window_defaults_to_thirty_minutes() {
        assert_eq!(DEFAULT_MAX_IDLE, time::Duration::minutes(30));
        assert_eq!(DEFAULT_EVERY, Duration::from_secs(60));
    }
}
