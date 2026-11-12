//! downloads commands.

// Tauri commands receive their arguments by value; that is the IPC contract.
#![allow(clippy::needless_pass_by_value)]

use dive_core::TabId;
use tauri::{AppHandle, State};

use super::{on_main, with_view};
use crate::Runtime;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// Ask for a download folder. `None` when the dialog was dismissed; the
/// chrome saves the answer through `prefs_set`, which checks it.
#[tauri::command]
#[specta::specta]
pub(crate) async fn download_dir_pick(state: State<'_, AppState>) -> AppResult<Option<String>> {
    let start = state.prefs.snapshot(&state).download_dir();
    let picked = rfd::AsyncFileDialog::new()
        .set_title("Save downloads to")
        .set_directory(start)
        .pick_folder()
        .await;
    Ok(picked.map(|folder| folder.path().to_string_lossy().into_owned()))
}

/// Show a download in the system file manager, or the downloads folder when `path` is `None`.
#[tauri::command]
#[specta::specta]
pub(crate) fn downloads_reveal(state: State<'_, AppState>, path: Option<String>) -> AppResult<()> {
    let target = match path {
        Some(p) if !p.is_empty() => std::path::PathBuf::from(p),
        _ => state.prefs.get(&state).download_dir(),
    };
    if !target.exists() {
        return Err(AppError::new("that file is no longer there"));
    }
    crate::os_open::reveal(&target)
}

#[tauri::command]
#[specta::specta]
/// Open a downloaded file with whatever the system opens that kind of file
/// with. Only a file the downloads list knows about is offered, and it must
/// still exist.
pub(crate) fn downloads_open(path: String) -> AppResult<()> {
    let target = std::path::PathBuf::from(&path);
    if path.is_empty() || !target.is_file() {
        return Err(AppError::new("that file is no longer there"));
    }
    crate::os_open::open(target.as_os_str(), "the file")
}

/// Stop a download that is still going.
///
/// `id` is CEF's, reported with each progress update. The engine's handle on
/// the download is kept between updates, so the cancel applies at once --
/// an interrupted download, which gets no more updates, included. One that
/// has already finished never sees it, which is the right answer for a
/// cancel that lost the race.
#[tauri::command]
#[specta::specta]
#[allow(clippy::unnecessary_wraps)] // The chrome's ipc layer unwraps a Result for every command.
pub(crate) fn downloads_cancel(state: State<'_, AppState>, id: u32) -> AppResult<()> {
    state.downloads.mark_cancelled(id);
    #[cfg(feature = "cef")]
    tauri_runtime_cef::downloads::control(id, tauri_runtime_cef::DownloadControl::Cancel);
    #[cfg(not(feature = "cef"))]
    let _ = id;
    Ok(())
}

/// Pick up a download the network interrupted, where it stopped. `id` is the
/// one its failure notice carried. A download that failed for any other
/// reason would only fail again, and the chrome does not offer it.
#[tauri::command]
#[specta::specta]
#[allow(clippy::unnecessary_wraps)] // The chrome's ipc layer unwraps a Result for every command.
pub(crate) fn downloads_resume(id: u32) -> AppResult<()> {
    #[cfg(feature = "cef")]
    tauri_runtime_cef::downloads::control(id, tauri_runtime_cef::DownloadControl::Resume);
    #[cfg(not(feature = "cef"))]
    let _ = id;
    Ok(())
}

/// Forget the downloads this session has seen.
///
/// Clears the engine's list as well as the chrome's: someone tidying up, or
/// clearing before handing the browser to an agent, means both.
#[tauri::command]
#[specta::specta]
#[allow(clippy::unnecessary_wraps)] // The chrome's ipc layer unwraps a Result for every command.
pub(crate) fn downloads_clear(state: State<'_, AppState>) -> AppResult<()> {
    state.downloads.clear();
    Ok(())
}

/// The downloads kept for this profile, newest first: what the Library
/// lists, across restarts.
#[tauri::command]
#[specta::specta]
pub(crate) async fn downloads_history(
    state: State<'_, AppState>,
    limit: u32,
) -> AppResult<Vec<dive_core::DownloadRecord>> {
    let limit = usize::try_from(limit.min(2000)).unwrap_or(200);
    Ok(lock(&state.store).downloads(limit)?)
}

/// Take one download off the Library's list. The file stays where it is.
#[tauri::command]
#[specta::specta]
pub(crate) async fn download_forget(state: State<'_, AppState>, id: String) -> AppResult<bool> {
    Ok(lock(&state.store).remove_download(&id)?)
}

/// Empty the Library's list of downloads. Every file stays where it is.
#[tauri::command]
#[specta::specta]
pub(crate) async fn downloads_history_clear(state: State<'_, AppState>) -> AppResult<u32> {
    let n = lock(&state.store).clear_downloads_since(None)?;
    Ok(u32::try_from(n).unwrap_or(u32::MAX))
}

/// Which of `paths` are no longer on disk, so the Library can say a file was
/// moved or deleted instead of offering to open it. Off the main thread: it
/// asks the filesystem about each one.
#[tauri::command]
#[specta::specta]
pub(crate) async fn downloads_missing(paths: Vec<String>) -> AppResult<Vec<String>> {
    tokio::task::spawn_blocking(move || {
        paths
            .into_iter()
            .filter(|path| !path.is_empty() && !std::path::Path::new(path).is_file())
            .collect()
    })
    .await
    .map_err(AppError::new)
}

/// Download `url` again, through the tab `id`'s page so it goes out with that
/// page's cookies and container, as the first attempt did.
#[tauri::command]
#[specta::specta]
pub(crate) fn download_start(app: AppHandle<Runtime>, id: TabId, url: String) -> AppResult<()> {
    let parsed = url::Url::parse(&url)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::new("only a web address can be downloaded again"));
    }
    on_main(&app, move |_, _, state| {
        with_view(state, id, move |view| {
            view.with_webview(move |native| {
                use cef::{ImplBrowser, ImplBrowserHost};
                if let Some(host) = native.browser().host() {
                    host.start_download(Some(&cef::CefString::from(url.as_str())));
                }
            })
        })?;
        Ok(())
    })
}
