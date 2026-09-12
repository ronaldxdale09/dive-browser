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
}

/// What to do to a download in flight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    Cancel,
    Pause,
    Resume,
}

type Sink = Box<dyn Fn(DownloadProgress) + Send + Sync>;

static SINK: OnceLock<Sink> = OnceLock::new();
static PENDING: Mutex<Option<HashMap<u32, Control>>> = Mutex::new(None);
static LAST_REPORT: Mutex<Option<HashMap<u32, Instant>>> = Mutex::new(None);

/// Hear about downloads in flight. The first caller wins; later ones are
/// ignored, which keeps the application in charge of its own reporting.
pub fn on_download_progress(sink: impl Fn(DownloadProgress) + Send + Sync + 'static) {
    let _ = SINK.set(Box::new(sink));
}

/// Ask CEF to cancel, pause or resume a download.
///
/// Queued rather than applied: the callback that can do it is only lent to the
/// handler for the length of one update, so the request waits for the next one.
/// CEF updates an active download several times a second, so the wait is not
/// perceptible; a download that has already finished never picks it up, which
/// is the right answer for a cancel that lost the race.
pub fn control(id: u32, action: Control) {
    let mut pending = lock(&PENDING);
    pending.get_or_insert_with(HashMap::new).insert(id, action);
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
    fn the_latest_request_for_a_download_is_the_one_that_counts() {
        // Pause then cancel: the person changed their mind before CEF got
        // round to either, and cancel is what they meant.
        control(11, Control::Pause);
        control(11, Control::Cancel);
        assert_eq!(take_control(11), Some(Control::Cancel));
        assert_eq!(take_control(11), None);
    }
}
