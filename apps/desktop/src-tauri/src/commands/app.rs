//! App-level commands: build info, the MCP token, default browser, updater state, browser import and chrome UI state.

// Tauri commands receive their arguments by value; that is the IPC contract.
#![allow(clippy::needless_pass_by_value)]

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use super::{AppInfo, BuildInfo};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

#[tauri::command]
#[specta::specta]
pub(crate) fn app_info() -> AppInfo {
    let private = crate::private_session::is_private();
    let mcp = crate::mcp::current_status();
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        build: BuildInfo {
            channel: if cfg!(debug_assertions) {
                "dev"
            } else {
                "beta"
            }
            .to_owned(),
            number: env!("DIVE_BUILD_NUMBER").to_owned(),
            commit: env!("DIVE_BUILD_COMMIT").to_owned(),
            #[allow(clippy::cast_precision_loss)]
            built_at: env!("DIVE_BUILD_UNIX").parse::<u64>().unwrap_or(0) as f64,
        },
        data_dir: crate::state::data_root().to_string_lossy().into_owned(),
        mcp_url: crate::mcp::advertised_url(&mcp, private),
        mcp_error: Some(crate::mcp::failure(&mcp, private)).filter(|reason| !reason.is_empty()),
        mcp_token_path: if private {
            String::new()
        } else {
            crate::mcp::token_path().to_string_lossy().into_owned()
        },
        simulate: std::env::var("DIVE_SIMULATE")
            .ok()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty()),
        updater: updater_configured(option_env!("DIVE_UPDATER_PUBKEY")),
    }
}

#[tauri::command]
#[specta::specta]
/// The MCP bearer token, for a client whose configuration cannot read a
/// file (Cursor's mcp.json). The chrome is the only caller; pages never
/// reach commands.
pub(crate) fn mcp_token() -> AppResult<String> {
    let path = crate::mcp::token_path();
    let token = std::fs::read_to_string(&path)
        .map_err(|e| AppError::new(format!("could not read the MCP token: {e}")))?;
    Ok(token.trim().to_owned())
}

/// Browsers on this Mac whose bookmarks and history can be brought in.
#[tauri::command]
#[specta::specta]
pub(crate) async fn browser_import_sources() -> AppResult<Vec<crate::browser_import::ImportSource>>
{
    tauri::async_runtime::spawn_blocking(crate::browser_import::sources)
        .await
        .map_err(AppError::new)
}

/// Bring bookmarks, history and/or saved passwords in from one source.
/// Passwords land in the active profile; a login Dive already has for the
/// same site and username is left as it is.
#[tauri::command]
#[specta::specta]
pub(crate) async fn browser_import_run(
    state: State<'_, AppState>,
    id: String,
    choice: crate::browser_import::ImportChoice,
) -> AppResult<crate::browser_import::ImportSummary> {
    let source = crate::browser_import::find(&id)?;
    let harvest = tauri::async_runtime::spawn_blocking(move || {
        crate::browser_import::harvest(&source, choice)
    })
    .await
    .map_err(AppError::new)??;
    // Merged a chunk at a time: another browser's history can be a hundred
    // thousand rows, and the store is not ours alone for that long.
    let profile = crate::backup::scoped_profile(&lock(&state.store))?;
    let added_bookmarks = crate::backup::merge_in_chunks(
        &state.store,
        profile,
        &harvest.bookmarks,
        |store, chunk| Ok(store.import_bookmarks(chunk)?),
    )?;
    let added_history =
        crate::backup::merge_in_chunks(&state.store, profile, &harvest.history, |store, chunk| {
            Ok(store.import_history(chunk)?)
        })?;
    let added_forms =
        crate::backup::merge_in_chunks(&state.store, profile, &harvest.forms, |store, chunk| {
            Ok(store.import_form_entries(profile, chunk)?)
        })?;
    let known = crate::passwords::list(&state, profile)?;
    let mut added_passwords = 0u32;
    let mut unsaved = 0usize;
    let mut first_refusal = None;
    for login in &harvest.passwords {
        if known
            .iter()
            .any(|c| c.origin == login.origin && c.username == login.username)
        {
            continue;
        }
        match crate::passwords::save(
            &state,
            profile,
            &login.origin,
            &login.username,
            &login.password,
        ) {
            Ok(_) => added_passwords += 1,
            Err(e) => {
                unsaved += 1;
                first_refusal.get_or_insert(e.message);
            }
        }
    }
    let mut warnings = harvest.warnings;
    // Counted and said: these used to vanish, and the summary read as if
    // the browser simply had fewer logins.
    if let Some(reason) = first_refusal {
        let logins = if unsaved == 1 { "login" } else { "logins" };
        warnings.push(format!("{unsaved} {logins} could not be saved: {reason}"));
    }
    Ok(crate::browser_import::ImportSummary {
        bookmarks: u32::try_from(added_bookmarks).unwrap_or(u32::MAX),
        history: u32::try_from(added_history).unwrap_or(u32::MAX),
        passwords: added_passwords,
        forms: u32::try_from(added_forms).unwrap_or(u32::MAX),
        warnings,
    })
}

/// Open System Settings on the Full Disk Access list, the other way in.
#[tauri::command]
#[specta::specta]
pub(crate) fn browser_import_open_privacy() -> AppResult<()> {
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
        .status()
        .map_err(AppError::new)?;
    Ok(())
}

/// Settings keys for chrome-side state.
const UI_PREFIX: &str = "ui.";

/// Chrome-side state (panel sizes, the chosen subtitles model, avatar
/// artwork) lives in the profile store rather than the chrome's own web
/// storage: the chrome webview runs off-the-record so extensions cannot
/// reach it, which leaves it no storage of its own.
#[tauri::command]
#[specta::specta]
pub(crate) fn ui_state_load(state: State<'_, AppState>) -> AppResult<Vec<(String, String)>> {
    Ok(lock(&state.store)
        .settings_with_prefix(UI_PREFIX)?
        .into_iter()
        .map(|(key, value)| (key[UI_PREFIX.len()..].to_owned(), value))
        .collect())
}

/// Write one chrome-side value, or remove it with `None`.
#[tauri::command]
#[specta::specta]
pub(crate) fn ui_state_set(
    state: State<'_, AppState>,
    key: String,
    value: Option<String>,
) -> AppResult<()> {
    if key.is_empty() || key.len() > 128 || key.chars().any(char::is_whitespace) {
        return Err(AppError::new("ui state keys are short and have no spaces"));
    }
    let full = format!("{UI_PREFIX}{key}");
    let store = lock(&state.store);
    match value {
        Some(value) => store.set_setting(&full, &value)?,
        None => {
            store.remove_setting(&full)?;
        }
    }
    Ok(())
}

/// Whether Dive is the system's default browser.
#[tauri::command]
#[specta::specta]
pub(crate) fn default_browser_status() -> crate::default_browser::DefaultBrowserStatus {
    crate::default_browser::status()
}

/// Ask the system to make Dive the default browser.
#[tauri::command]
#[specta::specta]
pub(crate) async fn default_browser_set() -> AppResult<crate::default_browser::DefaultBrowserStatus>
{
    // Launch Services may block on the system's own confirmation sheet;
    // keep that off the IPC and main threads.
    tauri::async_runtime::spawn_blocking(crate::default_browser::make_default)
        .await
        .map_err(|e| AppError::new(e.to_string()))?
        .map_err(AppError::new)
}

/// An update the release channel offers.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct UpdateInfo {
    /// Version string of the update.
    pub version: String,
    /// Release notes, if the manifest carried any.
    pub notes: Option<String>,
}

/// Whether this binary registered the updater plugin during startup.
///
/// `UpdaterExt::updater` currently panics before it can return an error when
/// the plugin state was never managed, so every command must guard the call.
pub(crate) fn updater_configured(public_key: Option<&str>) -> bool {
    public_key.is_some_and(|key| !key.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updater_calls_are_skipped_when_the_plugin_was_not_built() {
        assert!(!updater_configured(None));
        assert!(!updater_configured(Some("")));
        assert!(!updater_configured(Some("   ")));
        assert!(updater_configured(Some("release-public-key")));
    }

    #[test]
    fn app_info_reports_whether_the_updater_is_configured() {
        assert_eq!(
            app_info().updater,
            updater_configured(option_env!("DIVE_UPDATER_PUBKEY")),
        );
    }
}
