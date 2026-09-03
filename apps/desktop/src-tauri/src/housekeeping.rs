//! Background chores: archive idle `Today` tabs and tear down their views.

use std::time::Duration;

use dive_core::{CoreEvent, TabState, Timestamp};
use tauri::{AppHandle, Manager};

use crate::Runtime;
use crate::state::{AppState, lock};

/// How long a `Today` tab may sit unfocused before it is discarded.
pub const MAX_IDLE: time::Duration = time::Duration::hours(12);
const EVERY: Duration = Duration::from_mins(10);

/// Start the periodic sweep.
pub fn start(app: AppHandle<Runtime>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(EVERY).await;
            let state = app.state::<AppState>();
            match sweep(&state) {
                Ok(0) => {}
                Ok(n) => tracing::info!(n, "archived idle tabs"),
                Err(e) => tracing::warn!("archive sweep failed: {e}"),
            }
            match crate::prefs::prune_history(&state) {
                Ok(0) => {}
                Ok(n) => tracing::info!(n, "pruned history past the retention window"),
                Err(e) => tracing::warn!("history prune failed: {e}"),
            }
        }
    });
}

/// Archive idle tabs in every workspace, close their engine views, and
/// announce the changes. Returns how many tabs were archived.
pub fn sweep(state: &AppState) -> dive_core::Result<usize> {
    let discarded = lock(&state.store).discard_idle_tabs(Timestamp::now(), MAX_IDLE)?;
    if discarded.is_empty() {
        return Ok(0);
    }
    let count = discarded.len();
    // Never discard the tab the user is looking at.
    let showing = lock(&state.host)
        .as_ref()
        .and_then(crate::engine::TabHost::active);
    for tab in discarded {
        if Some(tab.id) == showing {
            let mut keep = tab.clone();
            keep.state = TabState::Active;
            keep.last_active_at = Timestamp::now();
            lock(&state.store).upsert_tab(&keep)?;
            continue;
        }
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
    Ok(count)
}
