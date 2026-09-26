//! Checking for, downloading and installing a newer build.
//!
//! Three things used to go wrong here. A check had no time limit, so a
//! release server that accepted the connection and then said nothing left
//! "Checking..." up for good. The download had neither a limit nor a way to
//! stop it, and the dialog locked its buttons for the duration, so a stalled
//! download could only be escaped by quitting. And Install checked again
//! before installing, which could install a different release from the one
//! the person had read about -- or fail, offline, after they had said yes.
//!
//! Now a check gives up after [`CHECK_TIMEOUT`], the download is watched for
//! progress and can be cancelled, and Install installs the very release the
//! last check offered.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt as _};
use tauri_specta::Event as _;

use crate::Runtime;
use crate::commands::{UpdateInfo, updater_configured};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// How long a check may wait for the release server.
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

/// How long a download may go without a single byte before it counts as
/// stalled. A total limit would cut short a slow connection that is still
/// making progress; this only catches one that is not.
const STALL_LIMIT: Duration = Duration::from_secs(60);

/// The update the last check offered, which is what Install installs.
static OFFERED: Mutex<Option<Update>> = Mutex::new(None);

/// Set while an install runs; a second Install waits for the first.
static INSTALLING: AtomicBool = AtomicBool::new(false);

/// How to stop the download in flight.
static CANCEL: Mutex<Option<tokio::sync::watch::Sender<bool>>> = Mutex::new(None);

fn info(update: &Update) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone(),
    }
}

async fn check(app: &AppHandle<Runtime>) -> AppResult<Option<Update>> {
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|e| AppError::new(e.to_string()))?;
    let found = updater
        .check()
        .await
        .map_err(|e| AppError::new(e.to_string()))?;
    lock(&OFFERED).clone_from(&found);
    Ok(found)
}

/// Ask the release channel for a newer build. `None` when this build has
/// no updater (development) or is current.
#[tauri::command]
#[specta::specta]
pub(crate) async fn update_check(app: AppHandle<Runtime>) -> AppResult<Option<UpdateInfo>> {
    if !updater_configured(option_env!("DIVE_UPDATER_PUBKEY")) {
        return Ok(None);
    }
    Ok(check(&app).await?.as_ref().map(info))
}

/// Why this copy of Dive cannot replace itself, if it cannot.
///
/// Opened straight from the disk image, or from a folder macOS moved into
/// App Translocation because it came from a download, the app sits on a
/// read-only volume: the download would finish and the install fail at the
/// last step. Saying so before downloading a hundred megabytes is better.
fn install_location_problem() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let bundle = exe
        .ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))?;
    let read_only = bundle
        .parent()
        .is_some_and(|parent| match tempfile::tempfile_in(parent) {
            Ok(_) => false,
            Err(error) => error.kind() == std::io::ErrorKind::ReadOnlyFilesystem,
        });
    (read_only || translocated(&bundle.to_string_lossy())).then(|| {
        "Dive is running from a disk image or a read-only location, so it cannot update \
         itself. Quit Dive, move it to your Applications folder, open it from there, and \
         install the update again."
            .to_owned()
    })
}

/// Whether `bundle` is a copy macOS runs from a randomised read-only path.
fn translocated(bundle: &str) -> bool {
    bundle.contains("/AppTranslocation/")
}

/// Why an install cannot start right now, if it cannot.
fn install_blocked(state: &AppState) -> Option<String> {
    if state.screencast.any() {
        return Some(
            "A screen recording is in progress. Stop it first; installing restarts Dive.".into(),
        );
    }
    if state.screen_exports.busy() {
        return Some(
            "A recording is still exporting. Let it finish first; installing restarts Dive.".into(),
        );
    }
    install_location_problem()
}

/// Clears the install's bookkeeping however it ends.
struct Installing;

impl Drop for Installing {
    fn drop(&mut self) {
        lock(&CANCEL).take();
        INSTALLING.store(false, Ordering::SeqCst);
    }
}

/// Download and install `version`, the release the last check offered, then
/// quit through the ordinary exit and start the new build.
#[tauri::command]
#[specta::specta]
pub(crate) async fn update_install(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    version: String,
) -> AppResult<()> {
    if !updater_configured(option_env!("DIVE_UPDATER_PUBKEY")) {
        return Err(AppError::new("this build has no updater"));
    }
    if let Some(reason) = install_blocked(&state) {
        return Err(AppError::new(reason));
    }
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err(AppError::new("The update is already being installed."));
    }
    let _installing = Installing;
    let offered = lock(&OFFERED).clone().filter(|u| u.version == version);
    // The chrome may have been reloaded since the check that found it; then
    // the release channel is asked again, and only the same release will do.
    let mut update = match offered {
        Some(update) => update,
        None => match check(&app).await? {
            Some(update) if update.version == version => update,
            Some(other) => {
                return Err(AppError::new(format!(
                    "Dive {} is now the latest release. Check again to see what changed.",
                    other.version
                )));
            }
            None => return Err(AppError::new("already up to date")),
        },
    };
    // The check's time limit would also cap the download's total length,
    // cutting off a slow connection that is still making progress; the
    // stall watch below is the download's limit instead.
    update.timeout = None;

    let (cancel, mut cancelled) = tokio::sync::watch::channel(false);
    *lock(&CANCEL) = Some(cancel);
    let started = Instant::now();
    let last_chunk_ms = std::sync::Arc::new(AtomicU64::new(0));
    let received = std::sync::Arc::new(AtomicU64::new(0));
    let progress_app = app.clone();
    let finish_app = app.clone();
    let chunk_clock = std::sync::Arc::clone(&last_chunk_ms);
    let counter = std::sync::Arc::clone(&received);
    let bytes = {
        let download = update.download(
            move |chunk, total| {
                chunk_clock.store(
                    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                    Ordering::Relaxed,
                );
                let so_far = counter.fetch_add(chunk as u64, Ordering::Relaxed) + chunk as u64;
                #[allow(clippy::cast_precision_loss)] // exact to 2^53 bytes.
                let _ = crate::engine::UpdateProgress {
                    received: so_far as f64,
                    total: total.map(|t| t as f64),
                    done: false,
                }
                .emit(&progress_app);
            },
            move || {
                let _ = crate::engine::UpdateProgress {
                    received: 0.0,
                    total: None,
                    done: true,
                }
                .emit(&finish_app);
            },
        );
        tokio::pin!(download);
        let mut watch = tokio::time::interval(Duration::from_secs(5));
        loop {
            tokio::select! {
                result = &mut download => break result.map_err(|e| AppError::new(e.to_string()))?,
                _ = cancelled.changed() => {
                    tracing::info!(version, "update download cancelled");
                    return Err(AppError::new("Update cancelled."));
                }
                _ = watch.tick() => {
                    let last = Duration::from_millis(last_chunk_ms.load(Ordering::Relaxed));
                    if stalled(started.elapsed(), last) {
                        tracing::warn!(version, "update download stalled");
                        return Err(AppError::new(
                            "The download stopped: nothing arrived for a minute. Check your \
                             connection and try again.",
                        ));
                    }
                }
            }
        }
    };
    // Off the async workers: unpacking and moving the bundle is blocking
    // work, and on macOS an install that needs an administrator's password
    // waits on the main thread for the prompt.
    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|e| AppError::new(e.to_string()))?
        .map_err(|e| AppError::new(e.to_string()))?;
    tracing::info!(version, "update installed; quitting to restart");
    crate::quit::exit_for_update(&app);
    Ok(())
}

/// Whether a download that began `elapsed` ago and last received a chunk at
/// `last_chunk` (from its start) has made no progress for too long.
fn stalled(elapsed: Duration, last_chunk: Duration) -> bool {
    elapsed.saturating_sub(last_chunk) > STALL_LIMIT
}

/// Stop the update download in flight. Too late once the install has begun;
/// that step is short and must not be interrupted halfway.
#[tauri::command]
#[specta::specta]
pub(crate) fn update_cancel() {
    if let Some(cancel) = lock(&CANCEL).as_ref() {
        let _ = cancel.send(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_download_is_stalled_only_after_a_minute_without_a_chunk() {
        let s = Duration::from_secs;
        assert!(!stalled(s(30), s(0)));
        assert!(!stalled(s(600), s(590)));
        assert!(stalled(s(61), s(0)));
        assert!(stalled(s(200), s(100)));
    }

    #[test]
    fn a_translocated_copy_is_recognised() {
        assert!(translocated(
            "/private/var/folders/x/AppTranslocation/ABC-123/d/Dive.app"
        ));
        assert!(!translocated("/Applications/Dive.app"));
    }
}
