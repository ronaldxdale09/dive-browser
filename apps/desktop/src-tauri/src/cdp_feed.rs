//! Shared "enable domains, then forward mapped CDP events" loop used by the
//! console and network feeds.

use dive_cdp::{CdpEvent, CdpSession};
use dive_core::TabId;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::Runtime;
use crate::state::AppState;

/// Enable `domains` on `session`, then map every event with `map`; each hit
/// is recorded through `record` and emitted to the chrome.
pub fn attach<T, M, R>(
    app: AppHandle<Runtime>,
    tab_id: TabId,
    session: CdpSession,
    domains: &'static [&'static str],
    map: M,
    record: R,
) where
    T: Event + serde::Serialize + Clone + Send + 'static,
    M: Fn(TabId, &CdpEvent) -> Option<T> + Send + 'static,
    R: Fn(&AppState, &T) + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut events = session.subscribe();
        for method in domains {
            if let Err(e) = session.call0(method).await {
                tracing::warn!(%tab_id, "{method} failed: {e}");
            }
        }
        loop {
            match events.recv().await {
                Ok(event) => {
                    if let Some(item) = map(tab_id, &event) {
                        record(&app.state::<AppState>(), &item);
                        if let Err(e) = item.emit(&app) {
                            tracing::warn!(%tab_id, "emit failed: {e}");
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(%tab_id, n, "cdp feed lagged");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}
