//! backup commands.

// Tauri commands receive their arguments by value; that is the IPC contract.
#![allow(clippy::needless_pass_by_value)]

use dive_core::CoreEvent;
use tauri::AppHandle;

use super::{emit_state_changed, prefs_set};
use crate::Runtime;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// Write everything this profile knows to a file the person chooses.
/// Returns where it went, or `None` when the dialog was dismissed.
#[tauri::command]
#[specta::specta]
pub(crate) async fn backup_export(app: AppHandle<Runtime>) -> AppResult<Option<String>> {
    let backup = {
        use tauri::Manager as _;
        let state = app.state::<AppState>();
        crate::backup::export(&state)?
    };
    let suggested = format!(
        "dive-backup-{}.json",
        backup.exported_at.chars().take(10).collect::<String>()
    );
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("Save a backup of this profile")
        .set_file_name(&suggested)
        .add_filter("Dive backup", &["json"])
        .save_file()
        .await
    else {
        return Ok(None);
    };
    let text = serde_json::to_string_pretty(&backup).map_err(AppError::new)?;
    let path = file.path().to_owned();
    tokio::fs::write(&path, text)
        .await
        .map_err(|error| AppError::new(format!("could not write {}: {error}", path.display())))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Merge a backup file into this profile. `None` when the dialog was
/// dismissed; otherwise what it added.
#[tauri::command]
#[specta::specta]
pub(crate) async fn backup_restore(
    app: AppHandle<Runtime>,
    take_preferences: bool,
) -> AppResult<Option<crate::backup::RestoreSummary>> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("Restore a Dive backup")
        .add_filter("Dive backup", &["json"])
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let path = file.path().to_owned();
    let text = tokio::fs::read_to_string(&path)
        .await
        .map_err(|error| AppError::new(format!("could not read {}: {error}", path.display())))?;
    let backup = crate::backup::parse(&text)?;
    let mut summary = {
        use tauri::Manager as _;
        let state = app.state::<AppState>();
        let profile = crate::backup::scoped_profile(&lock(&state.store))?;
        crate::backup::restore(&state.store, profile, &backup)?
    };
    // Through the same path as a change in Settings. Written straight into
    // the store, the restored preferences sat behind the registry's cached
    // copy: the running browser never saw them, and the next change in
    // Settings wrote the old ones back over the restore.
    if take_preferences && let Some(preferences) = &backup.preferences {
        use tauri::Manager as _;
        let state = app.state::<AppState>();
        let incoming = crate::prefs::parse_stored(preferences);
        let restored = crate::prefs::restorable(&incoming, &state.prefs.snapshot(&state));
        prefs_set(state, restored).await?;
        summary.preferences = true;
    }
    // Restored workspaces and their tabs have to reach the chrome, which
    // draws from events rather than re-reading the store.
    if summary.workspaces > 0 {
        use tauri::Manager as _;
        let state = app.state::<AppState>();
        let restored: Vec<_> = {
            let store = lock(&state.store);
            store.workspaces()?
        };
        for workspace in restored {
            let tabs = {
                let store = lock(&state.store);
                store.tabs_for_workspace(workspace.id)?
            };
            emit_state_changed(&app, CoreEvent::WorkspaceUpserted(workspace.clone()))?;
            for tab in tabs
                .into_iter()
                .filter(|t| t.workspace_id == Some(workspace.id))
            {
                emit_state_changed(&app, CoreEvent::TabUpserted(tab))?;
            }
        }
    }
    Ok(Some(summary))
}
