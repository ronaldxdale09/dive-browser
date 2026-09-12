//! Shared "enable domains, then forward mapped CDP events" loop used by the
//! console and network feeds.

use dive_cdp::{CdpEvent, CdpSession};
use dive_core::TabId;
use tauri::{AppHandle, Emitter, Manager};

use crate::Runtime;
use crate::state::AppState;

pub(crate) const IPC_BATCH_MAX: usize = 64;
const IPC_BATCH_WINDOW: std::time::Duration = std::time::Duration::from_millis(16);

/// A feed-local bounded batch. Host history is recorded before insertion;
/// this only delays and reduces native-to-chrome IPC publications.
pub(crate) struct IpcBatch<T> {
    items: Vec<T>,
    deadline: Option<tokio::time::Instant>,
}

impl<T> Default for IpcBatch<T> {
    fn default() -> Self {
        Self {
            items: Vec::with_capacity(IPC_BATCH_MAX),
            deadline: None,
        }
    }
}

impl<T> IpcBatch<T> {
    pub(crate) fn push(&mut self, item: T) -> bool {
        if self.items.is_empty() {
            self.deadline = Some(tokio::time::Instant::now() + IPC_BATCH_WINDOW);
        }
        self.items.push(item);
        self.items.len() >= IPC_BATCH_MAX
    }

    pub(crate) fn deadline(&self) -> Option<tokio::time::Instant> {
        self.deadline
    }

    pub(crate) fn take(&mut self) -> Vec<T> {
        self.deadline = None;
        std::mem::replace(&mut self.items, Vec::with_capacity(IPC_BATCH_MAX))
    }
}

pub(crate) fn emit_batch<T: serde::Serialize>(
    app: &AppHandle<Runtime>,
    session: &CdpSession,
    event: &str,
    batch: &mut IpcBatch<T>,
    tab_id: TabId,
) {
    let items = batch.take();
    if !session.is_closed()
        && !items.is_empty()
        && let Err(error) = app.emit(event, &items)
    {
        tracing::warn!(%tab_id, %error, event, "batch emit failed");
    }
}

fn emit_navigation_reset(
    app: &AppHandle<Runtime>,
    session: &CdpSession,
    event: &str,
    tab_id: TabId,
) {
    if !session.is_closed()
        && let Err(error) = app.emit(event, serde_json::json!({ "reset": tab_id }))
    {
        tracing::warn!(%tab_id, %error, event, "navigation reset emit failed");
    }
}

/// Enable `domains` on `session`, then map every event with `map`; each hit
/// is recorded through `record` and emitted to the chrome.
///
/// The returned receiver resolves once every domain has been enabled (or has
/// failed to), so callers can hold the first navigation until the feed is
/// listening.
pub fn attach<T, M, R>(
    app: AppHandle<Runtime>,
    tab_id: TabId,
    session: CdpSession,
    domains: &'static [&'static str],
    batch_event: &'static str,
    map: M,
    record: R,
) -> Ready
where
    T: serde::Serialize + Clone + Send + 'static,
    M: Fn(TabId, &CdpEvent) -> Option<T> + Send + 'static,
    R: Fn(&AppState, &T) + Send + 'static,
{
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let mut events = session.subscribe();
        for method in domains {
            if let Err(e) = session.call0(method).await {
                tracing::warn!(%tab_id, "{method} failed: {e}");
            }
        }
        let _ = ready_tx.send(());
        let mut batch = IpcBatch::default();
        loop {
            let incoming = if let Some(deadline) = batch.deadline() {
                tokio::select! {
                    event = events.recv() => Some(event),
                    () = tokio::time::sleep_until(deadline) => None,
                }
            } else {
                Some(events.recv().await)
            };
            let Some(incoming) = incoming else {
                emit_batch(&app, &session, batch_event, &mut batch, tab_id);
                continue;
            };
            match incoming {
                Ok(event) => {
                    if event.method == "Page.frameNavigated"
                        && event.params["frame"]["parentId"].is_null()
                    {
                        emit_batch(&app, &session, batch_event, &mut batch, tab_id);
                        emit_navigation_reset(&app, &session, batch_event, tab_id);
                    }
                    if let Some(item) = map(tab_id, &event) {
                        record(&app.state::<AppState>(), &item);
                        if batch.push(item) {
                            emit_batch(&app, &session, batch_event, &mut batch, tab_id);
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(%tab_id, n, "cdp feed lagged");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    // Host history was recorded immediately. The UI may have
                    // already dropped this tab, so a close must not publish a
                    // late batch that resurrects it.
                    let _ = batch.take();
                    break;
                }
            }
        }
    });
    ready_rx
}

/// Resolves once a feed's `DevTools` domains are enabled.
pub type Ready = tokio::sync::oneshot::Receiver<()>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_flushes_at_the_count_limit_in_insertion_order() {
        let mut batch = IpcBatch::default();
        for value in 0..IPC_BATCH_MAX - 1 {
            assert!(!batch.push(value));
        }
        assert!(batch.push(IPC_BATCH_MAX - 1));
        assert_eq!(batch.take(), (0..IPC_BATCH_MAX).collect::<Vec<_>>());
        assert!(batch.deadline().is_none());
    }

    #[test]
    fn first_item_starts_one_short_deadline() {
        let mut batch = IpcBatch::default();
        assert!(batch.deadline().is_none());
        batch.push(1);
        let deadline = batch.deadline().unwrap();
        batch.push(2);
        assert_eq!(batch.deadline(), Some(deadline));
        assert!(deadline <= tokio::time::Instant::now() + IPC_BATCH_WINDOW);
    }
}
