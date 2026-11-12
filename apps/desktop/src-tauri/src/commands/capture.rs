//! capture commands.

// Tauri commands receive their arguments by value; that is the IPC contract.
#![allow(clippy::needless_pass_by_value)]

use dive_core::TabId;
use tauri::State;

use super::cdp_for;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// Screenshot a tab (viewport, or the whole document when `full_page`) to a
/// PNG under the app data dir and return its path.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_capture(
    state: State<'_, AppState>,
    id: TabId,
    full_page: bool,
) -> AppResult<String> {
    let path = capture_tab(&state, id, full_page).await?;
    Ok(path.to_string_lossy().into_owned())
}

/// Screenshot a tab's viewport as base64 PNG, saving and copying nothing:
/// for a picture the chrome finishes before it is kept, such as a device
/// frame drawn around it. Going through `tab_capture` for that left an
/// unframed copy in the captures folder beside every framed one.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_capture_png(state: State<'_, AppState>, id: TabId) -> AppResult<String> {
    let session = cdp_for(&state, id)?;
    dive_cdp::page::capture_screenshot_base64(
        &session,
        dive_cdp::page::ScreenshotOptions::default(),
    )
    .await
    .map_err(AppError::new)
}

/// Put a base64 PNG on the system clipboard, and nothing else. Copying from
/// the capture editor used to save a new file on every click, and said
/// "Copied" even when the clipboard refused the picture.
#[tauri::command]
#[specta::specta]
pub(crate) fn clipboard_write_png(png_base64: String) -> AppResult<()> {
    use base64::Engine as _;
    let png = base64::engine::general_purpose::STANDARD
        .decode(png_base64)
        .map_err(AppError::new)?;
    copy_png_to_clipboard(&png)
}

/// Put text on the system clipboard. Goes through the host rather than the
/// page's clipboard API, which refuses when the chrome document is not the
/// focused one (the person may have just clicked the page).
#[tauri::command]
#[specta::specta]
pub(crate) fn clipboard_write_text(text: String) -> AppResult<()> {
    arboard::Clipboard::new()
        .map_err(AppError::new)?
        .set_text(text)
        .map_err(AppError::new)
}

/// Put a secret on the system clipboard, hidden from clipboard history and
/// cleared again after half a minute unless something else was copied.
#[tauri::command]
#[specta::specta]
pub(crate) async fn clipboard_write_secret(text: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || crate::clipboard_secret::write(&text))
        .await
        .map_err(AppError::new)?
}

/// Put PNG bytes on the system clipboard as an image.
pub fn copy_png_to_clipboard(png: &[u8]) -> AppResult<()> {
    let img = image::load_from_memory_with_format(png, image::ImageFormat::Png)
        .map_err(AppError::new)?
        .to_rgba8();
    let (width, height) = img.dimensions();
    let data = arboard::ImageData {
        width: width as usize,
        height: height as usize,
        bytes: img.into_raw().into(),
    };
    arboard::Clipboard::new()
        .map_err(AppError::new)?
        .set_image(data)
        .map_err(AppError::new)
}

/// Capture `id` to `<data>/captures/dive-<timestamp>.png`.
pub async fn capture_tab(
    state: &AppState,
    id: TabId,
    full_page: bool,
) -> AppResult<std::path::PathBuf> {
    let page_url = lock(&state.store).tab(id)?.url;
    let session = cdp_for(state, id)?;
    let png = if full_page {
        dive_cdp::page::capture_full_page(&session, dive_cdp::page::ImageFormat::Png).await
    } else {
        dive_cdp::page::capture_screenshot(&session, dive_cdp::page::ScreenshotOptions::default())
            .await
    }
    .map_err(AppError::new)?;

    save_capture(
        &png,
        &page_url,
        if full_page { "full page" } else { "capture" },
    )
}

/// Write `png` under captures, named after the page (see [`capture_name`]),
/// and copy it to the clipboard.
fn save_capture(png: &[u8], page_url: &str, kind: &str) -> AppResult<std::path::PathBuf> {
    let dir = captures_dir()?;
    let path = dir.join(capture_name(
        page_url,
        kind,
        "png",
        dive_core::Timestamp::now(),
    ));
    std::fs::write(&path, png)?;
    if let Err(e) = copy_png_to_clipboard(png) {
        tracing::warn!("capture saved but clipboard copy failed: {e}");
    }
    Ok(path)
}

pub(crate) fn captures_dir() -> AppResult<std::path::PathBuf> {
    let dir = crate::state::data_root().join("captures");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Read a capture as base64 PNG for the annotator. Only files inside the
/// captures directory are readable.
#[tauri::command]
#[specta::specta]
pub(crate) fn capture_read(path: String) -> AppResult<String> {
    use base64::Engine as _;
    let dir = captures_dir()?.canonicalize()?;
    let file = std::path::Path::new(&path).canonicalize()?;
    if !file.starts_with(&dir) || file.extension().is_none_or(|e| e != "png") {
        return Err(AppError::new("not a capture"));
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(std::fs::read(file)?))
}

/// Save an annotated capture (base64 PNG) beside the original and copy it
/// to the clipboard; returns the new path.
#[tauri::command]
#[specta::specta]
pub(crate) fn capture_save(state: State<'_, AppState>, png_base64: String) -> AppResult<String> {
    use base64::Engine as _;
    let png = base64::engine::general_purpose::STANDARD
        .decode(png_base64)
        .map_err(AppError::new)?;
    image::load_from_memory_with_format(&png, image::ImageFormat::Png).map_err(AppError::new)?;
    // The annotated picture belongs to whatever page is up now, which is the
    // page it was taken from unless the tab moved on meanwhile.
    let page_url = {
        let host = lock(&state.host);
        let active = host.as_ref().and_then(crate::engine::TabHost::active);
        drop(host);
        active
            .and_then(|id| lock(&state.store).tab(id).ok())
            .map(|t| t.url)
            .unwrap_or_default()
    };
    let path = save_capture(&png, &page_url, "annotated")?;
    Ok(path.to_string_lossy().into_owned())
}

/// `<captures>/<prefix>-<timestamp>.<ext>`.
pub(super) fn stamped_capture(
    page_url: &str,
    kind: &str,
    ext: &str,
) -> AppResult<std::path::PathBuf> {
    Ok(captures_dir()?.join(capture_name(
        page_url,
        kind,
        ext,
        dive_core::Timestamp::now(),
    )))
}

/// A file name someone can read in Finder: the page's host, what the file
/// is, and a local-looking time, as in `github.com bug report 2026-09-07
/// 18.19.30.md`. Without a host (a blank tab) the kind stands alone.
pub(crate) fn capture_name(
    page_url: &str,
    kind: &str,
    ext: &str,
    at: dive_core::Timestamp,
) -> String {
    format!("{}.{ext}", capture_stem(page_url, kind, at))
}

/// The name without its extension; recordings add theirs once encoded.
/// The Mac's wall-clock offset, so a capture is named by the time on the
/// menu bar rather than UTC. `chrono` reads the zone safely from any thread.
pub(crate) fn local_offset() -> time::UtcOffset {
    let seconds = chrono::Local::now().offset().local_minus_utc();
    time::UtcOffset::from_whole_seconds(seconds).unwrap_or(time::UtcOffset::UTC)
}

pub(crate) fn capture_stem(page_url: &str, kind: &str, at: dive_core::Timestamp) -> String {
    let host = url::Url::parse(page_url)
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| h.trim_start_matches("www.").to_owned())
        })
        .filter(|h| !h.is_empty());
    let stamp =
        at.0.to_offset(local_offset())
            .format(time::macros::format_description!(
                "[year]-[month]-[day] [hour].[minute].[second]"
            ))
            .unwrap_or_default();
    match host {
        Some(host) => format!("{host} {kind} {stamp}"),
        None => format!("{kind} {stamp}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_names_read_as_host_kind_and_local_time() {
        let at = dive_core::Timestamp::parse("2026-09-07T18:19:30Z").unwrap();
        // Named by the clock on the menu bar, whatever zone the test runs in.
        let local =
            at.0.to_offset(local_offset())
                .format(time::macros::format_description!(
                    "[year]-[month]-[day] [hour].[minute].[second]"
                ))
                .unwrap();
        assert_eq!(
            capture_name(
                "https://www.github.com/tauri-apps/tauri",
                "requests",
                "har",
                at
            ),
            format!("github.com requests {local}.har")
        );
        assert_eq!(
            capture_name("about:blank", "bug report", "md", at),
            format!("bug report {local}.md")
        );
    }
}
