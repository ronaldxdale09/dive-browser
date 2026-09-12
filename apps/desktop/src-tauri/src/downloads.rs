//! What has been downloaded, so an agent can pick the file up.
//!
//! "Click Export, then use what came out" is one of the most ordinary things
//! anyone asks an automated browser to do, and it was impossible: downloads
//! were announced to the chrome and then forgotten, so nothing could say what
//! arrived or where it went. Every notice now also lands here.
//!
//! Only the recent ones are kept. This is for the file that was just fetched,
//! not for a history -- that is the Library's job, and it has one.

use std::collections::VecDeque;
use std::sync::Mutex;

use serde::Serialize;
use specta::Type;

use crate::engine::DownloadNotice;
use crate::state::lock;

/// How many downloads are remembered.
const KEEP: usize = 50;

/// One download, as a tool caller sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct Download {
    /// Where the file is.
    pub path: String,
    /// Where it came from.
    pub url: String,
    /// `started`, `finished` or `failed`.
    pub status: String,
    /// The tab that asked for it, when a page did.
    pub tab_id: Option<String>,
    /// Size on disk in bytes, once it has finished.
    pub bytes: Option<u64>,
}

/// The downloads this session has seen, newest last.
#[derive(Default)]
pub struct Registry {
    seen: Mutex<VecDeque<Download>>,
    /// How many downloads have ever finished, counted rather than recounted.
    ///
    /// The deque holds the last [`KEEP`]; once it is full of finished entries,
    /// counting them always gives `KEEP`, because a new download evicts an old
    /// one. A wait that compares the count before and after therefore never
    /// saw an increase, and told the caller nothing had finished when
    /// something had. A counter that only goes up cannot do that.
    finished: std::sync::atomic::AtomicUsize,
}

impl Registry {
    /// Record a notice. A finish replaces the start it belongs to, so one
    /// download is one entry rather than two half-told ones.
    pub fn record(&self, notice: &DownloadNotice) {
        if notice.status == "finished" {
            self.finished
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        let mut seen = lock(&self.seen);
        let entry = Download {
            path: notice.path.clone(),
            url: notice.url.clone(),
            status: notice.status.clone(),
            tab_id: notice.tab.map(|t| t.to_string()),
            bytes: (notice.status == "finished")
                .then(|| std::fs::metadata(&notice.path).ok().map(|m| m.len()))
                .flatten(),
        };
        // Matched on path rather than on URL: a redirect changes the URL
        // between the request and the file, and the path is what was decided
        // up front and does not move.
        if !entry.path.is_empty()
            && let Some(existing) = seen.iter_mut().find(|d| d.path == entry.path)
        {
            *existing = entry;
            return;
        }
        seen.push_back(entry);
        while seen.len() > KEEP {
            seen.pop_front();
        }
    }

    /// Forget everything. The chrome's list and this one are the same list as
    /// far as anyone using Dive is concerned, so clearing one clears both.
    pub fn clear(&self) {
        lock(&self.seen).clear();
    }

    /// The most recent downloads, newest first.
    pub fn recent(&self, limit: usize) -> Vec<Download> {
        let seen = lock(&self.seen);
        seen.iter().rev().take(limit).cloned().collect()
    }

    /// How many downloads have finished this session, as a marker for
    /// "anything new since". Monotonic: see [`Registry::finished`].
    pub fn finished_count(&self) -> usize {
        self.finished.load(std::sync::atomic::Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notice(path: &str, status: &str) -> DownloadNotice {
        DownloadNotice {
            tab: None,
            url: format!("https://example.com/{path}"),
            path: path.to_owned(),
            status: status.to_owned(),
        }
    }

    #[test]
    fn a_download_that_finishes_is_one_entry_not_two() {
        // Otherwise "what did I just download" answers with a started row and
        // a finished row for the same file, and a caller picks the wrong one.
        let registry = Registry::default();
        registry.record(&notice("/tmp/report.csv", "started"));
        registry.record(&notice("/tmp/report.csv", "finished"));
        let recent = registry.recent(10);
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].status, "finished");
    }

    #[test]
    fn separate_files_stay_separate_and_come_back_newest_first() {
        let registry = Registry::default();
        registry.record(&notice("/tmp/a.csv", "finished"));
        registry.record(&notice("/tmp/b.csv", "finished"));
        let recent = registry.recent(10);
        assert_eq!(
            recent.iter().map(|d| d.path.as_str()).collect::<Vec<_>>(),
            vec!["/tmp/b.csv", "/tmp/a.csv"]
        );
        assert_eq!(registry.finished_count(), 2);
    }

    #[test]
    fn a_failure_with_no_path_is_still_reported() {
        // A download that never got a destination has an empty path, and
        // those must not all collapse into one another.
        let registry = Registry::default();
        registry.record(&notice("", "failed"));
        registry.record(&notice("", "failed"));
        assert_eq!(registry.recent(10).len(), 2);
        assert_eq!(registry.finished_count(), 0);
    }

    #[test]
    fn a_long_session_can_still_tell_that_something_finished() {
        // The deque keeps the last KEEP entries, so counting finished ones
        // inside it saturates and a wait can never observe an increase. An
        // agent was told "no download finished in that time" for a file that
        // was already on disk.
        let registry = Registry::default();
        for i in 0..(KEEP + 10) {
            registry.record(&notice(&format!("/tmp/{i}.bin"), "started"));
            registry.record(&notice(&format!("/tmp/{i}.bin"), "finished"));
        }
        let before = registry.finished_count();
        registry.record(&notice("/tmp/new.bin", "started"));
        registry.record(&notice("/tmp/new.bin", "finished"));
        assert!(
            registry.finished_count() > before,
            "a finish after {before} others has to be visible; the deque only holds {KEEP}"
        );
    }

    #[test]
    fn clearing_forgets_what_an_agent_can_see_too() {
        let registry = Registry::default();
        registry.record(&notice("/tmp/a.csv", "finished"));
        registry.clear();
        assert!(registry.recent(10).is_empty());
    }

    #[test]
    fn only_the_recent_ones_are_kept() {
        let registry = Registry::default();
        for i in 0..(KEEP + 10) {
            registry.record(&notice(&format!("/tmp/{i}.bin"), "finished"));
        }
        assert_eq!(registry.recent(1000).len(), KEEP);
        // The oldest went, not the newest.
        assert_eq!(registry.recent(1)[0].path, format!("/tmp/{}.bin", KEEP + 9));
    }
}
