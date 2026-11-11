//! One way to run work on the main thread and wait for its answer.
//!
//! Native views may only be created or shown on the main thread, so code on
//! any other thread queues a closure there and waits. The wait is bounded, but
//! the queued closure is not cancelled when the wait ends: a main thread that
//! was stuck in a dialog would run it minutes later, after the caller had
//! already been told "no answer" and retried. Every hop therefore carries the
//! caller's deadline into the closure and skips the work if it has passed (or
//! if the caller stopped waiting). Work already running cannot be cancelled.

use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::Runtime;

/// How long a caller waits for the main thread before giving up.
pub(crate) const BUDGET: Duration = Duration::from_secs(30);

/// Why a hop produced no value.
pub(crate) enum HopError {
    /// The runtime refused to queue the closure.
    Queue(String),
    /// The main thread did not start the work within the budget.
    TimedOut(Duration),
    /// The queued closure was dropped without answering.
    Dropped,
}

/// Whether queued main-thread work should still start: not once the
/// caller's budget has passed, and not once the caller stopped waiting.
pub(crate) fn should_start(now: Instant, deadline: Instant, waiter_gone: bool) -> bool {
    !waiter_gone && now < deadline
}

/// Run `f` on the main thread, blocking this (non-main) thread for the answer.
pub(crate) fn blocking<T: Send + 'static>(
    app: &AppHandle<Runtime>,
    budget: Duration,
    f: impl FnOnce(&AppHandle<Runtime>) -> T + Send + 'static,
) -> Result<T, HopError> {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    let deadline = Instant::now() + budget;
    app.run_on_main_thread(move || {
        if !should_start(Instant::now(), deadline, false) {
            return;
        }
        let _ = tx.send(f(&handle));
    })
    .map_err(|e| HopError::Queue(e.to_string()))?;
    match rx.recv_timeout(budget) {
        Ok(value) => Ok(value),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(HopError::TimedOut(budget)),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(HopError::Dropped),
    }
}

/// Run `f` on the main thread, awaiting the answer without blocking a task.
pub(crate) async fn run<T: Send + 'static>(
    app: &AppHandle<Runtime>,
    budget: Duration,
    f: impl FnOnce(&AppHandle<Runtime>) -> T + Send + 'static,
) -> Result<T, HopError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    let deadline = Instant::now() + budget;
    app.run_on_main_thread(move || {
        if !should_start(Instant::now(), deadline, tx.is_closed()) {
            return;
        }
        let _ = tx.send(f(&handle));
    })
    .map_err(|e| HopError::Queue(e.to_string()))?;
    match tokio::time::timeout(budget, rx).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => Err(HopError::Dropped),
        Err(_) => Err(HopError::TimedOut(budget)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queued_work_starts_before_the_deadline() {
        let t = Instant::now();
        assert!(should_start(t, t + Duration::from_secs(1), false));
    }

    #[test]
    fn queued_work_is_dropped_once_the_caller_gave_up() {
        let t = Instant::now();
        assert!(!should_start(
            t + Duration::from_secs(2),
            t + Duration::from_secs(1),
            false
        ));
    }

    #[test]
    fn queued_work_is_dropped_when_nobody_waits() {
        let t = Instant::now();
        assert!(!should_start(t, t + Duration::from_secs(1), true));
    }

    #[test]
    fn deadline_is_exclusive() {
        let t = Instant::now();
        assert!(!should_start(t, t, false));
    }
}
