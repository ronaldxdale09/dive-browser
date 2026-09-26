//! Progress for a download in flight, and the means to stop one.
//!
//! Tauri's `DownloadEvent` has two variants -- the request and the finish --
//! so a download that takes a minute reports nothing for that minute and the
//! chrome has no number to show. CEF knows the whole time: the item carries
//! received and total bytes and a current speed, and it offers a callback that
//! cancels, pauses and resumes. None of that fits through Tauri's handler, so
//! it comes through here instead.
//!
//! Process-global because CEF is: there is one browser process, one set of
//! downloads, and one application listening to them.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How often a download in flight is reported at most.
///
/// CEF updates an item far more often than a person can read it -- several
/// times a second per download -- and every report crosses to the chrome and
/// re-renders a row. Four a second is smooth to watch and cheap to produce.
const REPORT_EVERY: Duration = Duration::from_millis(250);

/// Where a download has got to.
#[derive(Debug, Clone)]
pub struct DownloadProgress {
    /// CEF's id for the download, and the handle for [`control`].
    pub id: u32,
    /// Where it came from.
    pub url: String,
    /// Where it is being written, once CEF has decided.
    pub path: String,
    /// Bytes written so far.
    pub received: u64,
    /// Total size, when the server said. A chunked response has none, and the
    /// chrome shows what has arrived rather than a meaningless percentage.
    pub total: Option<u64>,
    /// Bytes per second, as CEF measures it.
    pub speed: u64,
    /// Whether the download is paused.
    pub paused: bool,
    /// Why the download stopped, when the engine interrupted it: Chromium's
    /// reason name without its prefix, such as `FILE_NO_SPACE` or
    /// `NETWORK_FAILED`. An interrupted download is over as far as the
    /// person can tell, even though the engine keeps it around to resume.
    pub interrupted: Option<String>,
}

/// Whether a download stopped for `reason` can be picked up where it left
/// off. Only the network going away qualifies: a full disk or a refused file
/// fails the same way again, and a server that answered badly would too.
pub fn resumable(reason: &str) -> bool {
    reason.starts_with("NETWORK_")
}

/// What to do to a download in flight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    Cancel,
    Pause,
    Resume,
}

type Sink = Box<dyn Fn(DownloadProgress) + Send + Sync>;

/// The engine's handle on one download, kept between updates.
pub(crate) struct Held(pub(crate) cef::DownloadItemCallback);

// SAFETY: CEF's download item callback is reference counted with atomic
// counts, and its cancel, pause and resume post to CEF's UI thread when
// called from any other.
unsafe impl Send for Held {}

impl Held {
    fn apply(&self, action: Control) {
        use cef::ImplDownloadItemCallback;
        match action {
            Control::Cancel => self.0.cancel(),
            Control::Pause => self.0.pause(),
            Control::Resume => self.0.resume(),
        }
    }
}

static SINK: OnceLock<Sink> = OnceLock::new();
static PENDING: Mutex<Option<HashMap<u32, Control>>> = Mutex::new(None);
static LAST_REPORT: Mutex<Option<HashMap<u32, Instant>>> = Mutex::new(None);
/// The callback each unfinished download last lent, so a cancel applies at
/// once. An interrupted download sends no further updates, so a cancel or a
/// resume queued for the next one would never be applied.
static HELD: Mutex<Option<HashMap<u32, Held>>> = Mutex::new(None);
/// Downloads whose current interruption has been reported.
static INTERRUPTED: Mutex<Option<std::collections::HashSet<u32>>> = Mutex::new(None);

/// Hear about downloads in flight. The first caller wins; later ones are
/// ignored, which keeps the application in charge of its own reporting.
pub fn on_download_progress(sink: impl Fn(DownloadProgress) + Send + Sync + 'static) {
    let _ = SINK.set(Box::new(sink));
}

/// Ask CEF to cancel, pause or resume a download.
///
/// Applied at once through the callback the download's last update lent,
/// when there is one; otherwise queued for the next update. A download that
/// has already finished never picks a queued request up, which is the right
/// answer for a cancel that lost the race.
pub fn control(id: u32, action: Control) {
    // Cloned out of the lock: on the UI thread the engine can report the
    // change from inside the call, and that report takes the lock again.
    let held = lock(&HELD)
        .as_ref()
        .and_then(|held| held.get(&id))
        .map(|held| Held(held.0.clone()));
    if let Some(callback) = held {
        callback.apply(action);
        return;
    }
    let mut pending = lock(&PENDING);
    pending.get_or_insert_with(HashMap::new).insert(id, action);
}

/// Keep the callback `id`'s update lent, for [`control`] to use later.
pub(crate) fn hold(id: u32, callback: cef::DownloadItemCallback) {
    lock(&HELD)
        .get_or_insert_with(HashMap::new)
        .insert(id, Held(callback));
}

/// Let go of `id`'s callback: the download is over for good.
pub(crate) fn release(id: u32) {
    // Taken out before dropping: releasing the engine's reference must not
    // happen with the lock held, for the same reentrancy as in `control`.
    let held = lock(&HELD).as_mut().and_then(|held| held.remove(&id));
    drop(held);
    if let Some(pending) = lock(&PENDING).as_mut() {
        pending.remove(&id);
    }
    if let Some(interrupted) = lock(&INTERRUPTED).as_mut() {
        interrupted.remove(&id);
    }
}

/// Note that `id` was interrupted; true the first time, so one interruption
/// is reported once however often the engine repeats its update.
pub(crate) fn mark_interrupted(id: u32) -> bool {
    lock(&INTERRUPTED)
        .get_or_insert_with(std::collections::HashSet::new)
        .insert(id)
}

/// `id` is moving again (resumed), so a later interruption is news.
pub(crate) fn clear_interrupted(id: u32) {
    if let Some(interrupted) = lock(&INTERRUPTED).as_mut() {
        interrupted.remove(&id);
    }
}

/// Take the request waiting for `id`, if any.
pub(crate) fn take_control(id: u32) -> Option<Control> {
    let mut pending = lock(&PENDING);
    pending.as_mut().and_then(|map| map.remove(&id))
}

/// Report progress, unless this download was reported too recently.
///
/// `final_report` is set once the download is over; that one always goes
/// through, or a download that finished inside a quiet window would leave the
/// chrome showing whatever fraction it last heard.
pub(crate) fn report(progress: &DownloadProgress, final_report: bool) {
    let Some(sink) = SINK.get() else {
        return;
    };
    if !final_report {
        let mut last = lock(&LAST_REPORT);
        let seen = last.get_or_insert_with(HashMap::new);
        let now = Instant::now();
        if let Some(previous) = seen.get(&progress.id)
            && now.duration_since(*previous) < REPORT_EVERY
        {
            return;
        }
        seen.insert(progress.id, now);
    } else {
        // Nothing more is coming for this one.
        if let Some(seen) = lock(&LAST_REPORT).as_mut() {
            seen.remove(&progress.id);
        }
    }
    sink(progress.clone());
}

/// A poisoned lock here holds only bookkeeping, and losing a report is far
/// better than taking the browser process down inside a CEF callback.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_is_taken_once_and_only_by_its_own_download() {
        control(7, Control::Cancel);
        assert_eq!(
            take_control(9),
            None,
            "another download must not consume it"
        );
        assert_eq!(take_control(7), Some(Control::Cancel));
        assert_eq!(take_control(7), None, "the request is spent once applied");
    }

    #[test]
    fn an_interruption_is_reported_once_until_the_download_moves_again() {
        assert!(mark_interrupted(21));
        assert!(!mark_interrupted(21), "a repeated update is the same failure");
        clear_interrupted(21);
        assert!(mark_interrupted(21), "resumed and interrupted again is news");
        release(21);
        assert!(mark_interrupted(21), "a finished download forgets it");
        release(21);
    }

    #[test]
    fn only_a_network_interruption_is_worth_resuming() {
        assert!(resumable("NETWORK_FAILED"));
        assert!(resumable("NETWORK_DISCONNECTED"));
        assert!(!resumable("FILE_NO_SPACE"));
        assert!(!resumable("FILE_ACCESS_DENIED"));
        assert!(!resumable("SERVER_FORBIDDEN"));
    }

    #[test]
    fn a_released_download_drops_a_request_it_never_picked_up() {
        control(31, Control::Pause);
        release(31);
        assert_eq!(take_control(31), None);
    }

    #[test]
    fn the_latest_request_for_a_download_is_the_one_that_counts() {
        // Pause then cancel: the person changed their mind before CEF got
        // round to either, and cancel is what they meant.
        control(11, Control::Pause);
        control(11, Control::Cancel);
        assert_eq!(take_control(11), Some(Control::Cancel));
        assert_eq!(take_control(11), None);
    }
}
