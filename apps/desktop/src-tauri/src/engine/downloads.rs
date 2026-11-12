//! Downloads: where a file goes, the notices the chrome shows while it comes, and keeping it in the Library.

use std::path::PathBuf;

use dive_core::TabId;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::webview::DownloadEvent;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::Runtime;
use crate::state::AppState;

/// A download started or finished; shown as a toast.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type, Event)]
pub struct DownloadNotice {
    /// The tab the download came from, when a page asked for it.
    pub tab: Option<TabId>,
    /// Source URL.
    pub url: String,
    /// Where the file is (or will be) written.
    pub path: String,
    /// `started` | `finished` | `failed` | `cancelled`.
    pub status: String,
    /// Why a download failed, when the engine said: Chromium's reason, such
    /// as `FILE_NO_SPACE`, `FILE_ACCESS_DENIED` or `NETWORK_FAILED`.
    #[specta(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The engine's id for the download, when known; resuming needs it.
    #[specta(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<u32>,
    /// The network dropped, and the download can pick up where it stopped.
    #[specta(optional)]
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub resumable: bool,
}

/// How far a download has got, while it is still going.
///
/// Separate from [`DownloadNotice`], which says only that something started or
/// ended. This is the one the progress bar reads, and it arrives about four
/// times a second per download.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, Event)]
pub struct DownloadProgress {
    /// CEF's id, and the handle for cancelling.
    pub id: u32,
    /// Source URL, for matching against a row that has no path yet.
    pub url: String,
    /// Destination, once CEF has decided on one.
    pub path: String,
    /// Bytes written so far. A float because that is what JavaScript has, and
    /// it counts whole bytes exactly far past any file anyone will download.
    pub received: f64,
    /// Total size when the server declared one. A chunked response has none.
    pub total: Option<f64>,
    /// Bytes per second.
    pub speed: f64,
    /// Whether it is paused.
    pub paused: bool,
    /// Set when the engine interrupted it, with Chromium's reason.
    #[specta(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interrupted: Option<String>,
}

/// Forward the runtime's download progress to the chrome.
///
/// Registered once at startup. The runtime throttles to about four reports a
/// second per download, so this is a cheap passthrough rather than a place
/// that needs its own rate limit.
#[cfg(feature = "cef")]
pub fn watch_download_progress(app: &AppHandle<Runtime>) {
    let app = app.clone();
    tauri_runtime_cef::downloads::on_download_progress(move |p| {
        let state = app.state::<AppState>();
        let downloads = &state.downloads;
        downloads.track(p.id, &p.url, &p.path);
        // Reported before the engine's finish, which names only the address
        // and path: this is where the finish learns why it failed.
        if let Some(reason) = &p.interrupted {
            downloads.interrupted(p.id, reason);
        }
        #[allow(clippy::cast_precision_loss)] // exact to 2^53 bytes; files are smaller.
        let _ = DownloadProgress {
            id: p.id,
            url: p.url,
            path: p.path,
            received: p.received as f64,
            total: p.total.map(|t| t as f64),
            speed: p.speed as f64,
            paused: p.paused,
            interrupted: p.interrupted,
        }
        .emit(&app);
    });
}

/// `~/Downloads`, or the temp dir when the home is unknown.
pub fn downloads_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    home.map_or_else(std::env::temp_dir, |h| h.join("Downloads"))
}

/// Pick a path in `dir` for `suggested`, appending ` (n)` if taken.
pub fn unique_path(dir: &std::path::Path, suggested: &str) -> PathBuf {
    let name = std::path::Path::new(suggested)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("download");
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_owned(), format!(".{e}")),
        _ => (name.to_owned(), String::new()),
    };
    let mut candidate = dir.join(name);
    let mut n = 1;
    // Created, not merely checked. Two downloads of the same name starting
    // together both used to find the name free and both take it, so the second
    // overwrote the first -- the one thing this function exists to prevent.
    // Creating it exclusively means the winner holds the name.
    loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            // Anything other than "taken" -- a read-only directory, a name the
            // filesystem refuses -- is for the caller to report: hand back the
            // candidate and let the write fail where it can be explained.
            Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return candidate,
            Ok(_) => return candidate,
            Err(_) => {
                candidate = dir.join(format!("{stem} ({n}){ext}"));
                n += 1;
            }
        }
    }
}

/// Shared by page views and chrome-owned editors. Blob exports from capture,
/// recording and developer tools need the same destination and notices as pages.
pub(super) fn handle_download(
    app: &AppHandle<Runtime>,
    event: DownloadEvent<'_>,
    source: Option<(TabId, &str)>,
) -> bool {
    let notice = match event {
        DownloadEvent::Requested { url, destination } => {
            let state = app.state::<AppState>();
            let dir = state.prefs.get(&state).download_dir();
            match download_destination(&dir, destination, &url) {
                Ok(path) => *destination = path,
                Err(error) => {
                    tracing::warn!(%error, "preparing download destination failed");
                    let _ = DownloadNotice {
                        tab: source.map(|(tab, _)| tab),
                        url: url.to_string(),
                        path: String::new(),
                        status: "failed".into(),
                        ..DownloadNotice::default()
                    }
                    .emit(app);
                    return false;
                }
            }
            if let Some((tab, nonce)) = source {
                state.activity.download(tab, nonce, url.as_str(), true);
            }
            let path = destination.to_string_lossy().into_owned();
            state.downloads.placeholder(url.as_str(), &path);
            DownloadNotice {
                tab: source.map(|(tab, _)| tab),
                url: url.to_string(),
                path,
                status: "started".into(),
                ..DownloadNotice::default()
            }
        }
        DownloadEvent::Finished { url, path, success } => {
            let state = app.state::<AppState>();
            if let Some((tab, nonce)) = source {
                state.activity.download(tab, nonce, url.as_str(), false);
            }
            let path = path
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            // Asked for, not gone wrong: a download the person cancelled says
            // so rather than claiming it failed, and one the engine interrupted
            // says why.
            let ended = state.downloads.end(url.as_str(), &path);
            let cancelled = !success && ended.cancelled;
            // The empty file that held the name is only worth keeping under
            // a finished download, which wrote over it.
            let placeholder = state.downloads.take_placeholder(url.as_str(), &path);
            if !success && let Some(placeholder) = placeholder {
                remove_placeholder(placeholder);
            }
            let reason = (!success && !cancelled).then_some(ended.reason).flatten();
            DownloadNotice {
                tab: source.map(|(tab, _)| tab),
                url: url.to_string(),
                path,
                status: if success {
                    "finished"
                } else if cancelled {
                    "cancelled"
                } else {
                    "failed"
                }
                .into(),
                resumable: reason.as_deref().is_some_and(download_resumable),
                id: ended.id,
                reason,
            }
        }
        _ => return true,
    };
    app.state::<AppState>().downloads.record(&notice);
    persist_download(app, &notice);
    let _ = notice.emit(app);
    true
}

/// Whether a download that stopped for `reason` can pick up where it left
/// off: only when the network went away. A full disk or a refused file would
/// fail the same way again.
fn download_resumable(reason: &str) -> bool {
    #[cfg(feature = "cef")]
    return tauri_runtime_cef::downloads::resumable(reason);
    #[cfg(not(feature = "cef"))]
    reason.starts_with("NETWORK_")
}

/// Delete the empty file [`unique_path`] made to hold a download's name,
/// once that download failed or was cancelled. Only while it is still
/// empty: anything with bytes in it is not ours to throw away. Off the
/// engine's thread, since it touches the disk.
fn remove_placeholder(path: PathBuf) {
    tauri::async_runtime::spawn_blocking(move || {
        if std::fs::metadata(&path).is_ok_and(|meta| meta.is_file() && meta.len() == 0)
            && let Err(error) = std::fs::remove_file(&path)
        {
            tracing::debug!(%error, path = %path.display(), "could not remove a download's placeholder");
        }
    });
}

/// Keep a download in the profile's list, so the Library still shows it
/// after a restart. Off the thread that reported it -- CEF calls from its UI
/// thread, and this touches the database and, for a finished file, the disk.
/// A private session keeps nothing.
fn persist_download(app: &AppHandle<Runtime>, notice: &DownloadNotice) {
    if crate::private_session::is_private() {
        return;
    }
    let app = app.clone();
    let notice = notice.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = (notice.status == "finished")
            .then(|| std::fs::metadata(&notice.path).ok().map(|m| m.len()))
            .flatten();
        let state = app.state::<AppState>();
        if let Err(error) = crate::state::lock(&state.store).record_download(
            &notice.url,
            &notice.path,
            &notice.status,
            bytes,
            dive_core::Timestamp::now(),
        ) {
            tracing::warn!(%error, "could not keep the download in the Library");
        }
    });
}

fn download_destination(
    dir: &std::path::Path,
    suggested: &std::path::Path,
    url: &url::Url,
) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let name = suggested
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_else(|| {
            url.path_segments()
                .and_then(|mut parts| parts.next_back())
                .filter(|name| !name.is_empty())
                .unwrap_or("download")
        });
    Ok(unique_path(dir, name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_downloads_use_configured_directory_and_preserve_existing_files() {
        let root = std::env::temp_dir().join(format!("dive-export-{}", TabId::new()));
        let dir = root.join("custom-downloads");
        let url = url::Url::parse("blob:https://tauri.localhost/test-export").unwrap();
        let suggestion = std::path::Path::new("/ignored/example.png");
        let first = download_destination(&dir, suggestion, &url).unwrap();
        assert_eq!(first, dir.join("example.png"));
        std::fs::write(&first, b"existing capture").unwrap();
        assert_eq!(
            download_destination(&dir, suggestion, &url).unwrap(),
            dir.join("example (1).png")
        );
        assert_eq!(std::fs::read(&first).unwrap(), b"existing capture");
        // A failed configured destination must not silently fall back elsewhere.
        assert!(download_destination(&first.join("child"), suggestion, &url).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unique_path_appends_counter() {
        let dir = std::env::temp_dir().join(format!("dive-dl-{}", TabId::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = unique_path(&dir, "/tmp/report.tar.gz");
        assert_eq!(first.file_name().unwrap(), "report.tar.gz");
        std::fs::write(&first, b"x").unwrap();
        assert_eq!(
            unique_path(&dir, "report.tar.gz").file_name().unwrap(),
            "report.tar (1).gz"
        );
        assert_eq!(unique_path(&dir, "noext").file_name().unwrap(), "noext");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
