//! Noticing that Dive did not quit cleanly, and not repeating a crash.
//!
//! A tab that crashes the browser used to crash it again at every launch:
//! startup always re-activated the tab it ended on, so the same page loaded
//! and the same thing happened, with no way out short of deleting the
//! profile. A marker file now sits in the data folder while Dive runs and is
//! removed on a clean exit. Finding it at launch means the last run ended
//! some other way; it counts how many runs in a row did. After two, the
//! session comes back with every tab asleep and the chrome asks whether to
//! restore them. A run that stays up for [`STABLE_AFTER`] clears the count,
//! so one crash an hour into a session is not held against the next launch.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;

use crate::Runtime;
use crate::error::AppResult;
use crate::state::lock;

/// The marker's name in the data folder.
const MARKER: &str = "running";

/// How long a run must stay up to count as stable.
pub(crate) const STABLE_AFTER: std::time::Duration = std::time::Duration::from_secs(30);

/// Unclean exits in a row before a launch holds back the session.
const SAFE_START_AFTER: u32 = 2;

/// Unclean exits in a row before this launch; zero when the last run quit
/// cleanly or this is the first.
static STREAK: AtomicU32 = AtomicU32::new(0);

/// What startup would have opened, held back until the person decides.
static DEFERRED: Mutex<Option<Deferred>> = Mutex::new(None);

/// What a held-back startup would have done.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Deferred {
    /// Activate the tab the session ended on.
    Tab(dive_core::TabId),
    /// Open, or return to, the home page.
    Home(String),
    /// Nothing to bring back, but the person should still hear why.
    Nothing,
}

/// What the chrome shows after repeated unclean exits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SessionRecovery {
    /// How many runs in a row ended without a clean quit.
    pub crashes: u32,
    /// Whether there is a tab or page to bring back.
    pub can_restore: bool,
}

fn marker(root: &Path) -> PathBuf {
    root.join(MARKER)
}

/// The streak a marker left by the previous run implies for this one.
fn streak_after(previous: Option<&str>) -> u32 {
    match previous {
        None => 0,
        Some(text) => text
            .split_whitespace()
            .nth(1)
            .and_then(|n| n.parse::<u32>().ok())
            .unwrap_or(0)
            .saturating_add(1),
    }
}

fn write_marker(root: &Path, streak: u32) {
    let body = format!("{} {streak}\n", std::process::id());
    if let Err(error) = std::fs::write(marker(root), body) {
        tracing::warn!(%error, "could not write the running marker");
    }
}

/// Read what the last run left and mark this one as running. Call once,
/// early, for a normal (not private) launch.
pub(crate) fn begin(root: &Path) {
    let previous = std::fs::read_to_string(marker(root)).ok();
    let streak = streak_after(previous.as_deref());
    STREAK.store(streak, Ordering::SeqCst);
    if streak > 0 {
        tracing::warn!(streak, "the previous run did not quit cleanly");
    }
    write_marker(root, streak);
}

/// Whether the previous run ended without a clean quit.
pub(crate) fn previous_exit_unclean() -> bool {
    STREAK.load(Ordering::SeqCst) > 0
}

/// Whether this launch should hold the session back. Never for a harness
/// run: those are ended from outside as a matter of course, and a probe that
/// found its tab held back would fail for a reason that is not its own.
pub(crate) fn safe_start() -> bool {
    STREAK.load(Ordering::SeqCst) >= SAFE_START_AFTER && !automated_run()
}

/// Launches driven by a harness: nobody is there to answer a dialog, and
/// the harness ends runs from outside as a matter of course.
pub(crate) fn automated_run() -> bool {
    std::env::vars_os().any(|(key, _)| {
        let key = key.to_string_lossy();
        key.starts_with("DIVE_")
            && (key.contains("_PROBE")
                || key.starts_with("DIVE_SUBTITLE_TEST_")
                || matches!(
                    key.as_ref(),
                    "DIVE_SMOKE"
                        | "DIVE_STRESS_TABS"
                        | "DIVE_WINDOW_HIDDEN"
                        | "DIVE_CDP_BENCH"
                        | "DIVE_AGENT_EVAL"
                        | "DIVE_STARTUP_BENCHMARK"
                        | "DIVE_DISPOSABLE_PROFILE"
                ))
    })
}

/// Remember what startup would have opened, for the chrome to offer.
pub(crate) fn defer(what: Deferred) {
    tracing::warn!(
        ?what,
        "repeated unclean exits: the session starts with its tabs asleep"
    );
    *lock(&DEFERRED) = Some(what);
}

/// A clean exit: the next launch starts normally.
pub(crate) fn end(root: &Path) {
    match std::fs::remove_file(marker(root)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => tracing::warn!(%error, "could not remove the running marker"),
    }
}

/// Clear the streak once this run has stayed up long enough to trust.
pub(crate) fn settle(root: PathBuf) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STABLE_AFTER).await;
        // Only while the marker is still ours: a quit that already removed
        // it must not bring it back.
        if marker(&root).exists() {
            write_marker(&root, 0);
        }
    });
}

/// The pending question, if startup held the session back.
#[tauri::command]
#[specta::specta]
pub(crate) fn session_recovery_status() -> Option<SessionRecovery> {
    lock(&DEFERRED).as_ref().map(|what| SessionRecovery {
        crashes: STREAK.load(Ordering::SeqCst),
        can_restore: *what != Deferred::Nothing,
    })
}

/// Answer the question: `restore` brings back what startup held back;
/// otherwise the tabs stay listed and asleep.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri command extraction takes owned arguments.
pub(crate) fn session_recovery_resolve(app: AppHandle<Runtime>, restore: bool) -> AppResult<()> {
    let Some(what) = lock(&DEFERRED).take() else {
        return Ok(());
    };
    if !restore {
        return Ok(());
    }
    crate::commands::on_main(&app, move |main, app, state| match what {
        Deferred::Tab(tab) => crate::commands::activate_tab(main, app, state, tab),
        Deferred::Home(url) => crate::open_home(main, app, state, &url),
        Deferred::Nothing => Ok(()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_streak_counts_runs_that_left_their_marker_behind() {
        assert_eq!(streak_after(None), 0);
        assert_eq!(streak_after(Some("123 0\n")), 1);
        assert_eq!(streak_after(Some("123 1\n")), 2);
        // A marker from an older build, or a damaged one, still counts once.
        assert_eq!(streak_after(Some("garbage")), 1);
    }

    #[test]
    fn a_clean_exit_removes_the_marker_and_the_next_launch_starts_normally() {
        let dir = tempfile::tempdir().unwrap();
        begin(dir.path());
        assert!(marker(dir.path()).exists());
        end(dir.path());
        assert!(!marker(dir.path()).exists());
        assert_eq!(
            streak_after(std::fs::read_to_string(marker(dir.path())).ok().as_deref()),
            0
        );
        // Two runs that never reached `end` hold the third back.
        write_marker(dir.path(), 1);
        assert_eq!(
            streak_after(std::fs::read_to_string(marker(dir.path())).ok().as_deref()),
            SAFE_START_AFTER
        );
    }
}
