//! subtitles commands.

// Tauri commands receive their arguments by value; that is the IPC contract.
#![allow(clippy::needless_pass_by_value)]

use dive_core::TabId;
use tauri::{AppHandle, State};

use crate::Runtime;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// The local subtitle models and whether each is downloaded.
#[tauri::command]
#[specta::specta]
pub(crate) fn subtitle_models() -> Vec<crate::subtitles::SubtitleModel> {
    crate::subtitles::models()
}

/// Download a subtitle model; progress arrives on `SubtitleModelProgress`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn subtitle_model_download(app: AppHandle<Runtime>, id: String) -> AppResult<()> {
    crate::subtitles::download_model(&app, &id)
        .await
        .map_err(AppError::new)
}

/// Stop a subtitle model download; it reports itself cancelled on
/// `SubtitleModelProgress`.
#[tauri::command]
#[specta::specta]
pub(crate) fn subtitle_model_cancel(id: String) {
    crate::subtitles::cancel_download(&id);
}

/// Delete a downloaded subtitle model to free its space.
#[tauri::command]
#[specta::specta]
pub(crate) async fn subtitle_model_delete(id: String) -> AppResult<()> {
    crate::subtitles::delete_model(&id)
        .await
        .map_err(AppError::new)
}

/// Start live subtitles on a tab. `language` is an ISO code or "auto";
/// `translate` renders an English translation instead of the source text.
#[tauri::command]
#[specta::specta]
pub(crate) async fn subtitle_start(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: TabId,
    model: String,
    language: String,
    translate: bool,
) -> AppResult<()> {
    let session = lock(&state.host)
        .as_ref()
        .and_then(|h| h.cdp(id))
        .ok_or_else(|| AppError::new("no devtools session"))?;
    crate::subtitles::start(app, id, session, model, language, translate)
        .await
        .map_err(AppError::new)
}

/// Stop live subtitles on a tab and clear the overlay.
#[tauri::command]
#[specta::specta]
pub(crate) fn subtitle_stop(app: AppHandle<Runtime>, id: TabId) {
    crate::subtitles::stop_tab(&app, id);
}

/// Whether a tab is transcribing right now.
#[tauri::command]
#[specta::specta]
pub(crate) fn subtitle_running(app: AppHandle<Runtime>, id: TabId) -> bool {
    crate::subtitles::is_running(&app, id)
}
