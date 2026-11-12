//! Applying a site's remembered zoom to a tab's view.

use std::sync::Mutex;

use dive_core::TabId;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::Runtime;
use crate::state::{AppState, lock};

/// The engine applied a zoom factor to a tab. The chrome badge reads this so
/// a site-restored level is this tab's, not a leftover from a sibling.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, Event)]
pub struct TabZoom {
    /// Tab whose view was zoomed.
    pub tab_id: TabId,
    /// Factor the engine set (`1.0` is 100%).
    pub factor: f64,
}

/// One view's zoom bookkeeping, shared with the hops that apply it.
#[cfg(feature = "cef")]
#[derive(Clone, Default)]
pub(super) struct SiteZoomState {
    /// Bumped on every address change; a hop for an older one stands aside.
    pub(super) epoch: std::sync::Arc<std::sync::atomic::AtomicU64>,
    /// The [`crate::site_zoom::key_of`] the view was last put at.
    pub(super) applied: std::sync::Arc<Mutex<Option<String>>>,
}

/// How many loop turns a site zoom waits for a busy host before giving up.
#[cfg(feature = "cef")]
pub(super) const SITE_ZOOM_ATTEMPTS: u32 = 30;
/// Pause between those turns, so waiting is not a spin of the main loop.
#[cfg(feature = "cef")]
const SITE_ZOOM_RETRY: std::time::Duration = std::time::Duration::from_millis(20);

/// Put `tab_id`'s view at `key`'s zoom on a later turn of the main loop,
/// trying again on the next turns while the host is busy. The zoom used to be
/// skipped then, and the page stayed at the last site's size with the badge
/// saying so.
#[cfg(feature = "cef")]
pub(super) fn schedule_site_zoom(
    app: AppHandle<Runtime>,
    tab_id: TabId,
    key: String,
    zoom: SiteZoomState,
    epoch: u64,
    attempts: u32,
) {
    tauri::async_runtime::spawn(async move {
        if attempts < SITE_ZOOM_ATTEMPTS {
            tokio::time::sleep(SITE_ZOOM_RETRY).await;
        }
        let hop = app.clone();
        let _ = hop.run_on_main_thread(move || {
            if zoom.epoch.load(std::sync::atomic::Ordering::Relaxed) != epoch {
                return;
            }
            if apply_site_zoom(&app, tab_id, &key) {
                *lock(&zoom.applied) = Some(key);
            } else if let Some(left) = attempts.checked_sub(1) {
                schedule_site_zoom(app, tab_id, key, zoom, epoch, left);
            } else {
                tracing::debug!(%tab_id, "site zoom not applied: the host stayed busy");
            }
        });
    });
}

/// Put the view at the zoom the person last chose for the site `key` names,
/// or the default -- which is also where a page without an origin (`file:`,
/// `data:`) goes, rather than keeping the last site's zoom.
///
/// Returns `false` when the host or, the first time, the store is busy:
/// this runs on the main thread, which must not wait on either, so the
/// caller tries again on a later turn.
#[cfg(feature = "cef")]
fn apply_site_zoom(app: &AppHandle<Runtime>, tab_id: TabId, key: &str) -> bool {
    let state = app.state::<AppState>();
    // Read before the store is taken: on a cold cache the preferences load
    // from the store, and asking for them under its guard locked the same
    // mutex twice on one thread.
    let default_zoom = state.prefs.snapshot(&state).default_zoom;
    let factor = if key.is_empty() {
        default_zoom
    } else {
        let level = crate::site_zoom::cache().level(key, || {
            let store = state.store.try_lock().ok()?;
            crate::site_zoom::stored(&store)
        });
        match level {
            Ok(level) => level.unwrap_or(default_zoom),
            Err(crate::site_zoom::StoreBusy) => return false,
        }
    };
    let Ok(host) = state.host.try_lock() else {
        return false;
    };
    let Some(host) = host.as_ref() else {
        return true;
    };
    if let Err(e) = host.with_view(tab_id, |v| v.set_zoom(factor)) {
        // The view is gone; there is nothing to try again.
        tracing::debug!(%tab_id, "site zoom not applied: {e}");
        return true;
    }
    let _ = TabZoom { tab_id, factor }.emit(app);
    true
}
