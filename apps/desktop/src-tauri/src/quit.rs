//! What a quit asks first, and the restart that follows an update.
//!
//! Quitting used to take everything with it unasked: a download halfway
//! through, an agent in the middle of a task, a form someone had spent ten
//! minutes on. A quit the person asked for now looks for those first and,
//! when there is something to lose, asks once. The look is bounded -- a page
//! that does not answer counts as having nothing to lose -- so a quit is
//! never held up by the very tab that is misbehaving, and a second Quit
//! while it looks goes ahead at once.
//!
//! Installing an update used to restart Dive straight from the command,
//! skipping the exit path: open recordings were not saved, exports were not
//! stopped, and the window frame was not kept. Now the update asks for an
//! ordinary exit and the restart happens after it has finished.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager as _};

use crate::Runtime;
use crate::state::{AppState, lock};

/// Set by the updater: once the exit finishes, start the new build.
static RESTART_AFTER_UPDATE: AtomicBool = AtomicBool::new(false);

/// How long the look at open pages may take in all.
const PAGE_LOOK: Duration = Duration::from_millis(1500);

/// A "Quit Anyway" answers for the exit it was given for, and the guards
/// after it that may send the exit round again, but not for a quit much
/// later.
const CONFIRMATION_LASTS: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Confirm {
    /// Nothing asked yet.
    Idle,
    /// Looking at downloads, the agent and open pages.
    Checking,
    /// The person said to quit, or there was nothing to ask about.
    Confirmed(Instant),
}

static CONFIRM: Mutex<Confirm> = Mutex::new(Confirm::Idle);

/// Quit once the exit has run, then start the build that was just installed.
pub(crate) fn exit_for_update(app: &AppHandle<Runtime>) {
    RESTART_AFTER_UPDATE.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// Whether the exit that just finished was for an update.
pub(crate) fn restart_after_update() -> bool {
    RESTART_AFTER_UPDATE.load(Ordering::SeqCst)
}

/// What there is to lose by quitting now.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AtStake {
    pub downloads: usize,
    pub agent_busy: bool,
    pub unsaved_pages: usize,
}

impl AtStake {
    fn is_empty(self) -> bool {
        self.downloads == 0 && !self.agent_busy && self.unsaved_pages == 0
    }

    /// The dialog's text: one line per thing that would be lost.
    pub(crate) fn describe(self) -> String {
        let plural = |n: usize, one: &str, many: &str| {
            if n == 1 {
                one.to_owned()
            } else {
                format!("{n} {many}")
            }
        };
        let mut lines = Vec::new();
        if self.downloads > 0 {
            lines.push(format!(
                "{} still in progress and will stop.",
                plural(self.downloads, "A download is", "downloads are")
            ));
        }
        if self.agent_busy {
            lines.push("The agent is still working on a task and will be stopped.".to_owned());
        }
        if self.unsaved_pages > 0 {
            lines.push(format!(
                "{} unsaved changes.",
                plural(self.unsaved_pages, "A page has", "pages have")
            ));
        }
        lines.join("\n")
    }
}

/// Called from `ExitRequested`, on the main thread. `true` lets the exit go
/// ahead; `false` means it was held back while Dive looks for anything that
/// would be lost, and the exit is asked for again once it may go.
///
/// Only a quit with the main window still on screen is asked about: an exit
/// that follows the last window closing has already taken the pages with
/// it, and holding it would leave Dive running with nothing to show.
pub(crate) fn may_exit(app: &AppHandle<Runtime>, code: Option<i32>) -> bool {
    let Some(code) = code else {
        return true;
    };
    if crate::recovery::automated_run() || crate::private_session::is_private() {
        return true;
    }
    let main_shown = app
        .get_window(crate::MAIN_WINDOW)
        .is_some_and(|window| window.is_visible().unwrap_or(false));
    if !main_shown {
        return true;
    }
    let mut confirm = lock(&CONFIRM);
    match *confirm {
        Confirm::Confirmed(at) if at.elapsed() < CONFIRMATION_LASTS => true,
        // A second Quit while the first is still looking: go now.
        Confirm::Checking => {
            *confirm = Confirm::Confirmed(Instant::now());
            true
        }
        _ => {
            *confirm = Confirm::Checking;
            drop(confirm);
            tauri::async_runtime::spawn(check_then_exit(app.clone(), code));
            false
        }
    }
}

/// Downloads the engine has started and not yet finished.
fn downloads_in_flight(state: &AppState) -> usize {
    state
        .downloads
        .recent(usize::MAX)
        .iter()
        .filter(|d| d.status == "started")
        .count()
}

/// Pages that registered a `beforeunload` handler and have been typed
/// into. A handler alone is too common to mean anything -- analytics and
/// frameworks register one on nearly every page -- but together with edited
/// fields it is how an editor says it holds unsaved work. The activity guard
/// already tracks both for safe discard; this reads its snapshot.
async fn unsaved_pages(state: &AppState) -> usize {
    let sessions = lock(&state.host)
        .as_ref()
        .map(crate::engine::TabHost::sessions)
        .unwrap_or_default();
    let looks = sessions
        .into_iter()
        .map(|(_, session)| async move { crate::activity::probe(&session).await });
    let found = futures_util::future::join_all(looks).await;
    found
        .into_iter()
        .flatten()
        .filter(|page| {
            page.reasons.iter().any(|r| r == "beforeunload")
                && page.reasons.iter().any(|r| r == "unsaved_form")
        })
        .count()
}

async fn check_then_exit(app: AppHandle<Runtime>, code: i32) {
    const QUIT: &str = "Quit Anyway";
    const STAY: &str = "Cancel";
    let at_stake = {
        let state = app.state::<AppState>();
        let unsaved = tokio::time::timeout(PAGE_LOOK, unsaved_pages(&state))
            .await
            .unwrap_or(0);
        AtStake {
            downloads: downloads_in_flight(&state),
            agent_busy: !lock(&state.agent_runs).is_empty(),
            unsaved_pages: unsaved,
        }
    };
    // A second Quit while looking already let the exit go.
    if *lock(&CONFIRM) != Confirm::Checking {
        return;
    }
    let go = at_stake.is_empty() || {
        tracing::info!(?at_stake, "asking before quitting");
        let answer = rfd::AsyncMessageDialog::new()
            .set_title("Quit Dive?")
            .set_description(at_stake.describe())
            .set_level(rfd::MessageLevel::Warning)
            .set_buttons(rfd::MessageButtons::OkCancelCustom(
                QUIT.into(),
                STAY.into(),
            ))
            .show()
            .await;
        matches!(answer, rfd::MessageDialogResult::Custom(ref label) if label == QUIT)
    };
    if go {
        *lock(&CONFIRM) = Confirm::Confirmed(Instant::now());
        app.exit(code);
    } else {
        tracing::info!("quit cancelled");
        *lock(&CONFIRM) = Confirm::Idle;
        // The update is on disk either way; it starts at the next launch
        // rather than at some later quit the person did not connect with it.
        RESTART_AFTER_UPDATE.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_quit_question_lists_only_what_would_be_lost() {
        assert!(AtStake::default().is_empty());
        let one = AtStake {
            downloads: 1,
            agent_busy: false,
            unsaved_pages: 0,
        };
        assert_eq!(
            one.describe(),
            "A download is still in progress and will stop."
        );
        let many = AtStake {
            downloads: 2,
            agent_busy: true,
            unsaved_pages: 3,
        };
        assert_eq!(
            many.describe(),
            "2 downloads are still in progress and will stop.\n\
             The agent is still working on a task and will be stopped.\n\
             3 pages have unsaved changes."
        );
    }
}
