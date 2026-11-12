//! Dev-server discovery and the element inspector commands.

// Tauri commands receive their arguments by value; that is the IPC contract.
#![allow(clippy::needless_pass_by_value)]

use dive_core::TabId;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, State};

use super::cdp_for;
use crate::Runtime;
use crate::error::AppResult;
use crate::state::AppState;

/// Last element picked in a tab plus the live style experiment on it.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct InspectorSnapshot {
    /// The picked element, if the user has picked one in this document.
    pub pick: Option<crate::inspect::Pick>,
    /// Inline style changes made through the inspector.
    pub changes: Vec<crate::inspect::StyleChange>,
    /// Prompt-ready summary for handing the finding to an agent.
    pub description: Option<String>,
}

/// Dev servers listening on localhost, discovered from the OS socket table.
#[tauri::command]
#[specta::specta]
pub(crate) async fn dev_servers(
    state: State<'_, AppState>,
) -> AppResult<Vec<crate::devservers::DevServer>> {
    Ok(state.devservers.refresh().await.0)
}

/// Enable or disable low-frequency dev-server change events while a panel is open.
#[tauri::command]
#[specta::specta]
pub(crate) async fn dev_servers_watch(
    state: State<'_, AppState>,
    on: bool,
) -> AppResult<Vec<crate::devservers::DevServer>> {
    state.devservers.watch(on);
    if on {
        Ok(state.devservers.refresh().await.0)
    } else {
        Ok(state.devservers.current())
    }
}

/// Start the in-page element picker for a tab.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_inspect_start(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: TabId,
) -> AppResult<()> {
    let session = cdp_for(&state, id)?;
    crate::inspect::start(&app, id, &session).await
}

/// Cancel the in-page picker without discarding the last completed pick.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_inspect_cancel(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: TabId,
) -> AppResult<()> {
    let session = cdp_for(&state, id)?;
    crate::inspect::cancel(&app, id, &session).await
}

/// Return the latest pick and style experiment for a tab.
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_inspect_state(state: State<'_, AppState>, id: TabId) -> InspectorSnapshot {
    let pick = state.inspector.pick(id);
    let changes = state.inspector.changes(id);
    let description = pick
        .as_ref()
        .map(|picked| crate::inspect::describe(picked, &changes));
    InspectorSnapshot {
        pick,
        changes,
        description,
    }
}

/// Apply one temporary inline style to the picked element.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_inspect_style(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: TabId,
    property: String,
    value: String,
) -> AppResult<Vec<crate::inspect::StyleChange>> {
    let session = cdp_for(&state, id)?;
    crate::inspect::set_style(&app, id, &session, &property, &value).await
}

/// Revert every temporary style made through the picker.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_inspect_revert(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: TabId,
) -> AppResult<Vec<crate::inspect::StyleChange>> {
    let session = cdp_for(&state, id)?;
    crate::inspect::revert_styles(&app, id, &session).await
}

/// LAN URL and QR code for opening `url` on another device.
#[tauri::command]
#[specta::specta]
pub(crate) fn share_url(url: String) -> AppResult<crate::devservers::ShareInfo> {
    crate::devservers::share(&url)
}
