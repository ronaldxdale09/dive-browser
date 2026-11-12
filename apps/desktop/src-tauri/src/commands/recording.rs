//! recording commands.

// Tauri commands receive their arguments by value; that is the IPC contract.
#![allow(clippy::needless_pass_by_value)]

use dive_core::TabId;
use tauri::{AppHandle, State};

use super::{captures_dir, cdp_for};
use crate::Runtime;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// Start recording a tab with these options.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_screencast_start(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: TabId,
    options: crate::screencast::RecordOptions,
) -> AppResult<()> {
    let _pending = state.activity.pending(id);
    let session = cdp_for(&state, id)?;
    let window = window_rect(&app);
    // Named after the page, like every other capture: "example.com recording …".
    let page_url = lock(&state.store)
        .tab(id)
        .map(|tab| tab.url)
        .unwrap_or_default();
    state
        .screencast
        .start(app, id, session, options, window, &page_url)
        .await
}

/// Where the main window sits on its display, in that display's physical
/// pixels, for a whole-window screen capture.
fn window_rect(app: &AppHandle<Runtime>) -> Option<crate::screencast::WindowRect> {
    use tauri::Manager;
    let window = app.get_window(crate::MAIN_WINDOW)?;
    let monitor = window.current_monitor().ok().flatten()?;
    let monitors = window.available_monitors().ok()?;
    let screen = monitors
        .iter()
        .position(|m| m.position() == monitor.position())
        .unwrap_or(0);
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    let x = u32::try_from(pos.x - monitor.position().x).unwrap_or(0);
    let y = u32::try_from(pos.y - monitor.position().y).unwrap_or(0);
    Some(crate::screencast::WindowRect {
        x,
        y,
        width: size.width.min(monitor.size().width.saturating_sub(x)),
        height: size.height.min(monitor.size().height.saturating_sub(y)),
        screen,
    })
}

/// Pause or resume a recording; paused time is cut out of the file.
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_screencast_pause(
    state: State<'_, AppState>,
    id: TabId,
    paused: bool,
) -> AppResult<()> {
    state.screencast.set_paused(id, paused)
}

/// Stop recording and encode the file; returns what was written. A save
/// that failed can be tried again here after its tab has closed, so a
/// missing session only means the page is not told.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_screencast_stop(
    state: State<'_, AppState>,
    id: TabId,
) -> AppResult<crate::screencast::RecordingResult> {
    let session = cdp_for(&state, id).ok();
    state.screencast.stop(id, session.as_ref()).await
}

/// Throw a recording away without encoding it. While it is saving, stop the
/// save instead and keep the recording to try again or throw away.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_screencast_cancel(state: State<'_, AppState>, id: TabId) -> AppResult<()> {
    if let Ok(session) = cdp_for(&state, id) {
        let _ = session.call0("Page.stopScreencast").await;
    }
    state.screencast.discard(id);
    Ok(())
}

/// What the recording dialog may offer on this machine.
#[tauri::command]
#[specta::specta]
pub(crate) async fn recording_capabilities()
-> Result<crate::screencast::RecordingCapabilities, AppError> {
    tauri::async_runtime::spawn_blocking(crate::screencast::capabilities)
        .await
        .map_err(AppError::new)
}

/// Largest recording the chrome previews inline, as base64.
const PREVIEW_MAX_BYTES: u64 = 80 * 1024 * 1024;

/// A finished recording inside the captures directory, resolved and checked.
fn recording_file(path: &str) -> AppResult<std::path::PathBuf> {
    let dir = captures_dir()?.canonicalize()?;
    let file = std::path::Path::new(path).canonicalize()?;
    let ok = file.starts_with(&dir)
        && file
            .extension()
            .is_some_and(|e| e == "mp4" || e == "gif" || e == "png" || e == "webm" || e == "json");
    if !ok {
        return Err(AppError::new("not a recording"));
    }
    Ok(file)
}

/// Read a recording as base64 for the preview. Refuses files too large to
/// hold in the chrome's memory; those are opened with the system player.
#[tauri::command]
#[specta::specta]
pub(crate) async fn recording_read(path: String) -> Result<String, AppError> {
    use base64::Engine as _;
    let file = recording_file(&path)?;
    if std::fs::metadata(&file)?.len() > PREVIEW_MAX_BYTES {
        return Err(AppError::new("too large to preview here"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        Ok(base64::engine::general_purpose::STANDARD.encode(std::fs::read(file)?))
    })
    .await
    .map_err(AppError::new)?
}

/// Open a recording with whatever the system uses for it.
#[tauri::command]
#[specta::specta]
pub(crate) fn recording_open(path: String) -> AppResult<()> {
    let file = recording_file(&path)?;
    crate::os_open::open(file.as_os_str(), "the recording")
}

/// Delete a recording.
#[tauri::command]
#[specta::specta]
pub(crate) fn recording_delete(path: String) -> AppResult<()> {
    let file = recording_file(&path)?;
    std::fs::remove_file(&file)?;
    // The preview companion and any DiveScreen edits go with it.
    if let Some(stem) = file.file_stem()
        && let Some(dir) = file.parent()
    {
        let side = dir.join(crate::screencast::PREVIEW_DIR);
        let stem = stem.to_string_lossy();
        let _ = std::fs::remove_file(side.join(format!("{stem}.webm")));
        let _ = std::fs::remove_file(side.join(format!("{stem}.divescreen.json")));
    }
    Ok(())
}
