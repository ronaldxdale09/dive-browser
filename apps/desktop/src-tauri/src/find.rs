//! Find in page, with the engine's own find.
//!
//! Chromium's find highlights every match, finds text that runs across
//! elements and into frames, counts what the reader can actually see, and
//! never touches the page's selection. The engine reports its results through
//! a per-view handler, as a stream: counts can grow while a long page is
//! searched, and only the last report of a search is final. Each tab keeps
//! its latest report in a watch channel, and a find call waits for the report
//! of the search it started.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use dive_core::TabId;
use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::sync::watch;

use crate::error::AppResult;
use crate::state::AppState;

/// Result of a find step.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct FindResult {
    /// Total matches in the document.
    pub total: u32,
    /// 1-based index of the selected match, 0 when none.
    pub current: u32,
}

/// The latest report the engine made for a tab's search.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Report {
    /// Which search it belongs to. The engine numbers every request, a step
    /// to the next match included, so a new number means a new answer.
    identifier: i32,
    result: FindResult,
    final_update: bool,
}

/// How long a find waits for the engine to finish counting. A huge page can
/// take longer; the bar then shows the count so far, and the report that
/// completes it is simply not waited for.
const FIND_BUDGET: Duration = Duration::from_millis(1500);

static REPORTS: LazyLock<Mutex<HashMap<TabId, watch::Sender<Report>>>> =
    LazyLock::new(Default::default);

fn channel(tab: TabId) -> watch::Sender<Report> {
    REPORTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .entry(tab)
        .or_insert_with(|| watch::channel(Report::default()).0)
        .clone()
}

/// Receive `view`'s find results. Called for every view a tab gets, so a
/// page woken from sleep reports into the same channel as before.
#[cfg(feature = "cef")]
pub fn attach(tab: TabId, view: &tauri::Webview<crate::Runtime>) {
    let reports = channel(tab);
    let ordinal = std::sync::Mutex::new(None);
    let _ = view.with_webview(move |native| {
        native.set_find_handler(move |update: tauri_runtime_cef::FindUpdate| {
            let mut last = ordinal
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            reports.send_replace(report_of(
                update.identifier,
                update.count,
                update.active_match_ordinal,
                update.final_update,
                &mut last,
            ));
        });
    });
}

/// One engine report as the bar reads it. Chromium names the highlighted
/// match once, early in a search, and its later reports -- the final count
/// among them -- say -1, "unchanged". Taken literally that turned "1 of 3"
/// into "0 of 3" the moment counting finished, so the position a search last
/// named is carried forward in `last` until the search names a new one.
fn report_of(
    identifier: i32,
    count: i32,
    active_match_ordinal: i32,
    final_update: bool,
    last: &mut Option<(i32, u32)>,
) -> Report {
    let current = match u32::try_from(active_match_ordinal) {
        Ok(current) => {
            *last = Some((identifier, current));
            current
        }
        Err(_) => last
            .filter(|(search, _)| *search == identifier)
            .map_or(0, |(_, current)| current),
    };
    Report {
        identifier,
        result: FindResult {
            total: u32::try_from(count).unwrap_or(0),
            current,
        },
        final_update,
    }
}

/// The tab is gone; so is its channel.
pub fn forget(tab: TabId) {
    REPORTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&tab);
}

/// Search `tab` for `query`. `find_next` steps from the current match,
/// backwards when `forward` is false; otherwise the search starts over, from
/// the top. An empty query ends the search and takes its highlights away.
/// A tab without a live page (asleep) has nothing to find.
pub async fn find(
    state: &AppState,
    tab: TabId,
    query: &str,
    forward: bool,
    find_next: bool,
) -> AppResult<FindResult> {
    if query.is_empty() {
        stop(state, tab);
        return Ok(FindResult::default());
    }
    let mut reports = channel(tab).subscribe();
    let before = reports.borrow_and_update().identifier;
    let text = query.to_owned();
    let started = crate::commands::with_view(state, tab, move |view| {
        view.with_webview(move |native| native.find(&text, forward, false, find_next))
    });
    if started.is_err() {
        return Ok(FindResult::default());
    }
    Ok(wait_for_answer(&mut reports, before, FIND_BUDGET).await)
}

/// The final report of the first search numbered after `before`, or the
/// latest report of it when the budget runs out first.
async fn wait_for_answer(
    reports: &mut watch::Receiver<Report>,
    before: i32,
    budget: Duration,
) -> FindResult {
    let mut latest = None;
    let _ = tokio::time::timeout(budget, async {
        while reports.changed().await.is_ok() {
            let report = *reports.borrow_and_update();
            if report.identifier == before {
                continue;
            }
            latest = Some(report.result);
            if report.final_update {
                break;
            }
        }
    })
    .await;
    latest.unwrap_or_default()
}

/// End `tab`'s search and clear its highlights, leaving the page's own
/// selection as the person left it.
pub fn stop(state: &AppState, tab: TabId) {
    // A sleeping tab has no page and no highlights to clear.
    let _ = crate::commands::with_view(state, tab, |view| {
        view.with_webview(|native| native.stop_finding(true))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(identifier: i32, total: u32, current: u32, final_update: bool) -> Report {
        Report {
            identifier,
            result: FindResult { total, current },
            final_update,
        }
    }

    #[tokio::test]
    async fn a_find_answers_with_the_final_count_of_its_own_search() {
        let (tx, mut rx) = watch::channel(report(4, 9, 9, true));
        let before = rx.borrow_and_update().identifier;
        let sender = tokio::spawn(async move {
            // A stale report of the previous search changes nothing.
            tx.send_replace(report(4, 9, 9, true));
            tokio::task::yield_now().await;
            tx.send_replace(report(5, 2, 1, false));
            tokio::task::yield_now().await;
            tx.send_replace(report(5, 3, 1, true));
            tx
        });
        let found = wait_for_answer(&mut rx, before, FIND_BUDGET).await;
        drop(sender.await);
        assert_eq!(
            found,
            FindResult {
                total: 3,
                current: 1
            }
        );
    }

    #[tokio::test]
    async fn a_search_still_counting_answers_with_what_it_has() {
        let (tx, mut rx) = watch::channel(Report::default());
        tx.send_replace(report(1, 40, 1, false));
        let found = wait_for_answer(&mut rx, 0, Duration::from_millis(50)).await;
        assert_eq!(
            found,
            FindResult {
                total: 40,
                current: 1
            }
        );
    }

    #[test]
    fn the_highlighted_match_survives_the_final_count() {
        let mut last = None;
        let early = report_of(7, 1, 1, false, &mut last);
        assert_eq!(early.result.current, 1);
        // The final report says -1: unchanged, not "no match".
        let done = report_of(7, 3, -1, true, &mut last);
        assert_eq!(
            done.result,
            FindResult {
                total: 3,
                current: 1
            }
        );
        // A new search does not inherit the old position.
        assert_eq!(report_of(8, 2, -1, true, &mut last).result.current, 0);
    }

    #[tokio::test]
    async fn no_answer_is_no_match() {
        let (_tx, mut rx) = watch::channel(Report::default());
        assert_eq!(
            wait_for_answer(&mut rx, 0, Duration::from_millis(50)).await,
            FindResult::default()
        );
    }
}
