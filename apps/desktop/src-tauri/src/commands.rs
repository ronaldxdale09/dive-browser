//! IPC surface. Every function here is a Tauri command exported to
//! TypeScript by tauri-specta, plus the events the chrome subscribes to.

// Tauri commands receive their arguments by value; that is the IPC contract.
#![allow(clippy::needless_pass_by_value)]

use dive_core::{Command, CommandScope, CoreEvent, Tab, TabId, Workspace, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::{AppHandle, State};
use tauri_plugin_updater::UpdaterExt as _;
use tauri_specta::{Event, collect_commands, collect_events};

use crate::Runtime;
use crate::engine::{Bounds, MainThread, PaneBounds};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// Emitted whenever core state changes; carries the change itself.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct StateChanged(pub CoreEvent);

/// Everything the chrome needs to render on boot.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Snapshot {
    /// All workspaces in rail order.
    pub workspaces: Vec<Workspace>,
    /// Workspace shown in the chrome.
    pub active_workspace: Option<WorkspaceId>,
    /// Tabs of the active workspace plus essentials.
    pub tabs: Vec<Tab>,
    /// Focused tab, if any.
    pub active_tab: Option<TabId>,
    /// Tabs shown in their own windows.
    pub detached: Vec<TabId>,
    /// Every profile, in switcher order.
    pub profiles: Vec<dive_core::Profile>,
    /// The profile the active workspace belongs to.
    pub active_profile: Option<dive_core::ProfileId>,
}

/// A tab moved into its own window, or back into the main one.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct TabWindowChanged {
    /// The tab.
    pub tab: TabId,
    /// Whether it now lives in its own window.
    pub detached: bool,
}

/// A frozen viewport shown behind a chrome dialog while its native CEF view
/// is hidden. It is ephemeral and never written to disk.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ContentPreview {
    /// Tab whose viewport was captured.
    pub tab_id: TabId,
    /// JPEG data URL ready for an `<img>` in the chrome.
    pub data_url: String,
}

/// Which build this is, for the title bar's build badge.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct BuildInfo {
    /// `dev` for a debug build run from a checkout, `beta` for a release build.
    pub channel: String,
    /// Commits on the branch the build came from; grows with every commit.
    pub number: String,
    /// Short commit hash the build was made from.
    pub commit: String,
    /// When the binary was compiled, in seconds since the Unix epoch. A float
    /// because the bindings cannot carry a u64.
    pub built_at: f64,
}

/// Facts the Settings dialog shows.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AppInfo {
    /// Package version.
    pub version: String,
    /// Build identity.
    pub build: BuildInfo,
    /// Application data directory.
    pub data_dir: String,
    /// MCP endpoint, empty when disabled.
    pub mcp_url: String,
    /// Path of the bearer token file.
    pub mcp_token_path: String,
    /// Device preset to put the first tab on at startup, from `DIVE_SIMULATE`.
    /// Lets automation and smoke tests bring the simulator up without a
    /// click, the way `DIVE_OPEN_URL` opens a tab.
    pub simulate: Option<String>,
}

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

#[tauri::command]
#[specta::specta]
pub(crate) fn app_info() -> AppInfo {
    let port: u16 = std::env::var("DIVE_MCP_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(7391);
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
        mcp_url: if port == 0 {
            String::new()
        } else {
            format!("http://127.0.0.1:{port}/mcp")
        },
        mcp_token_path: crate::mcp::token_path().to_string_lossy().into_owned(),
        simulate: std::env::var("DIVE_SIMULATE")
            .ok()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty()),
    }
}

/// Toggle the bookmark for a tab's current URL; returns the new state.
#[tauri::command]
#[specta::specta]
pub(crate) fn bookmark_toggle(state: State<'_, AppState>, id: TabId) -> AppResult<bool> {
    let store = lock(&state.store);
    let tab = store.tab(id)?;
    if store.is_bookmarked(&tab.url)? {
        store.remove_bookmark(&tab.url)?;
        Ok(false)
    } else {
        store.add_bookmark(&tab.url, &tab.title, dive_core::Timestamp::now())?;
        Ok(true)
    }
}

/// Whether `url` is bookmarked.
#[tauri::command]
#[specta::specta]
pub(crate) fn bookmark_status(state: State<'_, AppState>, url: String) -> AppResult<bool> {
    Ok(lock(&state.store).is_bookmarked(&url)?)
}

/// Bookmarks matching `query`.
#[tauri::command]
#[specta::specta]
pub(crate) fn bookmarks_search(
    state: State<'_, AppState>,
    query: String,
    limit: u32,
) -> AppResult<Vec<dive_core::Bookmark>> {
    Ok(lock(&state.store)
        .search_bookmarks(&query, usize::try_from(limit.min(200)).unwrap_or(50))?)
}

/// Recent history matching `query`, newest first.
#[tauri::command]
#[specta::specta]
pub(crate) fn history_search(
    state: State<'_, AppState>,
    query: String,
    limit: u32,
) -> AppResult<Vec<dive_core::HistoryEntry>> {
    Ok(lock(&state.store).search_history(&query, usize::try_from(limit.min(200)).unwrap_or(50))?)
}

/// Forget every visit to `url`; true when there was one.
#[tauri::command]
#[specta::specta]
pub(crate) fn history_remove(state: State<'_, AppState>, url: String) -> AppResult<bool> {
    Ok(lock(&state.store).remove_history(&url)? > 0)
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

/// Current user preferences.
#[tauri::command]
#[specta::specta]
pub(crate) fn prefs_get(state: State<'_, AppState>) -> crate::prefs::Prefs {
    state.prefs.get(&state)
}

/// Store preferences and put them into force on every open tab. Returns the
/// stored form, which may differ where a value was out of range.
#[tauri::command]
#[specta::specta]
pub(crate) async fn prefs_set(
    state: State<'_, AppState>,
    prefs: crate::prefs::Prefs,
) -> AppResult<crate::prefs::Prefs> {
    let _update = state.prefs.begin_update().await;
    let previous = state.prefs.get(&state);
    let stored = state.prefs.set(&state, prefs)?;
    let sessions = {
        let host = lock(&state.host);
        let store = lock(&state.store);
        host.as_ref().map_or_else(Vec::new, |host| {
            host.sessions()
                .into_iter()
                .map(|(id, session)| {
                    let document_url = store.tab(id).map(|tab| tab.url).unwrap_or_default();
                    (id, session, document_url)
                })
                .collect()
        })
    };
    for (tab_id, session, document_url) in &sessions {
        crate::prefs::apply(session, &stored).await;
        crate::privacy::refresh_page_policy(&state, *tab_id, session, &stored).await;
        if privacy_site_state_changed(&previous, &stored, document_url)
            && let Err(error) = session.call0("Page.reload").await
        {
            tracing::debug!("DivePrivacy site pause reload failed open: {error}");
        }
    }
    reapply_interception(&state, None).await;
    match crate::prefs::prune_history(&state) {
        Ok(0) => {}
        Ok(n) => tracing::info!(n, "pruned history past the retention window"),
        Err(e) => tracing::warn!("history prune failed: {e}"),
    }
    Ok(stored)
}

fn privacy_site_state_changed(
    previous: &crate::prefs::Prefs,
    current: &crate::prefs::Prefs,
    document_url: &str,
) -> bool {
    let effective = |prefs: &crate::prefs::Prefs| {
        prefs.block_trackers && prefs.privacy_enabled_for(document_url)
    };
    effective(previous) != effective(current)
}

/// Delete browsing data; returns a one-line summary of what went.
#[tauri::command]
#[specta::specta]
pub(crate) async fn browsing_data_clear(
    state: State<'_, AppState>,
    what: crate::prefs::ClearRequest,
) -> AppResult<String> {
    crate::prefs::clear(&state, what).await
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
    reveal(&target)
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

#[tauri::command]
#[specta::specta]
/// Give the page keyboard focus again, after a chrome surface such as the
/// find bar closes; arrow keys and space then scroll the page as expected.
pub(crate) fn tab_focus(app: AppHandle<Runtime>, id: TabId) -> AppResult<()> {
    on_main(&app, move |_, _, state| {
        with_view(state, id, tauri::Webview::set_focus)?;
        Ok(())
    })
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
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(&target).status();
    #[cfg(target_os = "linux")]
    let status = std::process::Command::new("xdg-open").arg(&target).status();
    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("cmd")
        .args(["/C", "start", "", &target.display().to_string()])
        .status();
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(AppError::new(format!("could not open the file ({s})"))),
        Err(e) => Err(AppError::new(e)),
    }
}

/// Open `path` in the platform file manager, selecting it when it is a file.
fn reveal(path: &std::path::Path) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    let status = {
        let mut cmd = std::process::Command::new("open");
        if path.is_file() {
            cmd.arg("-R");
        }
        cmd.arg(path).status()
    };
    #[cfg(target_os = "linux")]
    let status = std::process::Command::new("xdg-open")
        .arg(if path.is_file() {
            path.parent().unwrap_or(path)
        } else {
            path
        })
        .status();
    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("explorer")
        .arg(if path.is_file() {
            format!("/select,{}", path.display())
        } else {
            path.display().to_string()
        })
        .status();
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(AppError::new(format!("file manager exited with {s}"))),
        Err(e) => Err(AppError::new(e)),
    }
}

/// Build the specta command/event collection.
#[allow(clippy::too_many_lines)] // The command list is the registry; one place to read it.
pub fn specta_builder() -> tauri_specta::Builder<Runtime> {
    tauri_specta::Builder::<Runtime>::new()
        .commands(collect_commands![
            crate::activity::keep_sites_list,
            crate::activity::keep_site_set,
            snapshot,
            tab_info,
            window_command,
            window_open,
            window_private,
            window_exit_private,
            window_close,
            popout_ready,
            workspace_activate,
            profiles_list,
            profile_create,
            profile_update,
            profile_activate,
            profile_delete,
            workspace_create,
            workspace_update,
            workspace_delete,
            workspace_reorder,
            workspace_tab_counts,
            tab_open,
            tab_close,
            tab_activate,
            tab_deactivate,
            ui_state_load,
            ui_state_set,
            browser_import_sources,
            browser_import_run,
            browser_import_open_privacy,
            tab_navigate,
            tab_reorder,
            tab_set_pinned,
            tab_back,
            tab_forward,
            crate::navigation::tab_history,
            crate::navigation::tab_history_navigate,
            tab_reload,
            tab_zoom,
            tab_stop,
            tab_print,
            tab_fill_video,
            tab_set_tier,
            bookmark_remove,
            passwords_list,
            passwords_for_url,
            passwords_save,
            passwords_reveal,
            passwords_delete,
            passwords_used,
            passwords_answer,
            passwords_fill,
            passwords_never,
            passwords_never_list,
            passwords_never_remove,
            passwords_pick_csv,
            passwords_import_csv,
            forms_list,
            forms_delete,
            forms_clear,
            bookmark_rename,
            permission_set,
            permission_reply,
            permissions_list,
            crate::extensions::extensions_list,
            crate::extensions::extension_pick,
            crate::extensions::extension_import,
            crate::extensions::extension_set_enabled,
            crate::extensions::extension_remove,
            crate::extensions::app_restart,
            update_check,
            update_install,
            default_browser_status,
            default_browser_set,
            subtitle_models,
            subtitle_model_download,
            subtitle_start,
            subtitle_stop,
            subtitle_running,
            tab_devtools,
            tab_screencast_start,
            tab_screencast_pause,
            tab_screencast_stop,
            tab_screencast_cancel,
            recording_capabilities,
            recording_read,
            recording_open,
            recording_delete,
            crate::screen::recordings_list,
            crate::screen::screen_media_info,
            crate::screen::screen_import_video,
            crate::screen::screen_import_path,
            crate::screen::screen_project_read,
            crate::screen::screen_project_write,
            crate::screen::file_read_chunk,
            crate::screen::file_size,
            crate::screen::screen_export_begin,
            crate::screen::screen_export_append,
            crate::screen::screen_export_finish,
            crate::screen::screen_export_cancel,
            tab_capture,
            capture_read,
            capture_save,
            tab_emulate,
            tab_environment,
            device_presets,
            tab_media,
            tab_throttle,
            rules_list,
            rules_set,
            tab_storage,
            tab_meta,
            tab_a11y,
            tab_a11y_reveal,
            tab_find,
            tab_vitals,
            resolve_frame,
            request_captured,
            request_detail,
            request_replay,
            tab_openapi,
            tab_har,
            tab_bug_report,
            tab_inspect_start,
            tab_inspect_cancel,
            tab_inspect_state,
            tab_inspect_style,
            tab_inspect_revert,
            tab_record_start,
            tab_record_stop,
            layout_set_content_bounds,
            layout_prepare_content_cover,
            layout_set_content_covered,
            layout_set_corner_radius,
            window_set_background,
            layout_set_overlay_regions,
            layout_set_panes,
            tab_detach,
            tab_attach,
            popout_set_bounds,
            commands_list,
            command_run,
            app_info,
            crate::privacy::privacy_info,
            prefs_get,
            prefs_set,
            browsing_data_clear,
            downloads_reveal,
            downloads_open,
            tab_focus,
            mcp_token,
            tab_storage_delete,
            dev_servers,
            dev_servers_watch,
            history_search,
            history_remove,
            bookmark_toggle,
            bookmark_status,
            bookmarks_search,
            share_url,
            crate::agent::agent_providers,
            crate::agent::agent_keys,
            crate::agent::agent_key_set,
            crate::agent::agent_key_present,
            crate::agent::agent_key_verify,
            crate::agent::agent_models,
            crate::agent::agent_send,
            crate::agent::agent_approve,
            crate::agent::agent_stop,
        ])
        .events(collect_events![
            crate::automation::AgentPointer,
            crate::crash::TabCrashed,
            crate::devservers::DevServersChanged,
            crate::inspect::InspectEvent,
            crate::recorder::RecorderEvent,
            crate::screencast::RecordingEvent,
            crate::menu::MenuCommand,
            StateChanged,
            TabWindowChanged,
            crate::console::ConsoleEntry,
            crate::network::NetworkEvent,
            crate::engine::DownloadNotice,
            crate::loading::TabLoad,
            crate::navigation::TabHistoryChanged,
            crate::permissions::PermissionAsked,
            crate::credential_fill::CredentialPrompt,
            crate::permissions::PermissionDismissed,
            crate::privacy::PrivacyEvent,
            crate::subtitles::SubtitleModelProgress,
            crate::subtitles::SubtitleCue,
            crate::subtitles::SubtitleState,
        ])
}

/// Emit a core event to the chrome.
pub fn emit_state_changed(app: &AppHandle<Runtime>, event: CoreEvent) -> tauri::Result<()> {
    StateChanged(event).emit(app)
}

/// Register commands that only touch core state. Engine-backed actions are
/// exposed as dedicated IPC commands; the registry lists them for the palette.
pub fn register_builtin(registry: &dive_core::CommandRegistry) {
    let builtin = [
        ("tab.new", "New tab", Some("mod+t"), CommandScope::Workspace),
        ("tab.close", "Close tab", Some("mod+w"), CommandScope::Tab),
        ("tab.reload", "Reload", Some("mod+r"), CommandScope::Tab),
        ("tab.home", "Home", Some("mod+shift+h"), CommandScope::Tab),
        (
            "tab.devtools",
            "Open DevTools",
            Some("mod+alt+i"),
            CommandScope::Tab,
        ),
        (
            "report.compose",
            "Copy bug report",
            Some("mod+shift+b"),
            CommandScope::Tab,
        ),
        (
            "screencast.toggle",
            "Record a video",
            Some("mod+shift+r"),
            CommandScope::Tab,
        ),
        ("zoom.in", "Zoom in", Some("mod+="), CommandScope::Tab),
        ("zoom.out", "Zoom out", Some("mod+-"), CommandScope::Tab),
        ("zoom.reset", "Reset zoom", Some("mod+0"), CommandScope::Tab),
        (
            "palette.open",
            "Command palette",
            Some("mod+k"),
            CommandScope::Global,
        ),
        (
            "sidecar.toggle",
            "Agent",
            Some("mod+j"),
            CommandScope::Global,
        ),
        (
            "dock.toggle",
            "Developer dock",
            Some("mod+shift+d"),
            CommandScope::Global,
        ),
        (
            "capture.fullpage",
            "Capture full page",
            Some("mod+shift+s"),
            CommandScope::Tab,
        ),
        (
            "simulator.toggle",
            "Device simulator",
            Some("mod+shift+m"),
            CommandScope::Tab,
        ),
    ];
    for (id, title, key, scope) in builtin {
        let cmd = Command {
            id: id.into(),
            title: title.into(),
            keybinding: key.map(Into::into),
            scope,
        };
        // These run in the chrome. Reaching this handler means the chrome's
        // dispatcher lost an id, so fail loudly instead of pretending.
        if let Err(e) =
            registry.register(cmd, |_| Err("handled by the chrome, not the core".into()))
        {
            tracing::warn!("{e}");
        }
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn snapshot(state: State<'_, AppState>) -> AppResult<Snapshot> {
    // Host before store: the main thread takes them in that order while it
    // activates or closes a tab, and this runs on a worker thread.
    let (active_tab, detached) = lock(&state.host)
        .as_ref()
        .map_or((None, Vec::new()), |h| (h.active(), h.detached()));
    let store = lock(&state.store);
    let active_workspace = *lock(&state.active_workspace);
    let tabs = match active_workspace {
        Some(id) => store.tabs_for_workspace(id)?,
        None => Vec::new(),
    };
    let workspaces = store.workspaces()?;
    let active_profile = active_workspace
        .and_then(|id| workspaces.iter().find(|w| w.id == id).map(|w| w.profile_id));
    Ok(Snapshot {
        workspaces,
        active_workspace,
        tabs,
        active_tab,
        detached,
        profiles: store.profiles()?,
        active_profile,
    })
}

/// A detached window reads its own page, independently of the main workspace.
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_info(state: State<'_, AppState>, id: TabId) -> AppResult<Tab> {
    Ok(lock(&state.store).tab(id)?)
}

/// Create a blank detached window using the authoritative current workspace.
#[tauri::command]
#[specta::specta]
pub(crate) async fn window_private(app: AppHandle<Runtime>) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || crate::private_session::open(&app))
        .await
        .map_err(AppError::new)?
}

#[tauri::command]
#[specta::specta]
pub(crate) fn window_open(app: AppHandle<Runtime>) -> AppResult<()> {
    if crate::private_session::is_private() {
        return crate::normal_window::open();
    }
    window_open_local(app)
}

/// Create a window in this process, retaining its current privacy boundary.
pub(crate) fn window_open_local(app: AppHandle<Runtime>) -> AppResult<()> {
    on_main(&app, move |main, app, state| {
        let workspace =
            (*lock(&state.active_workspace)).ok_or_else(|| AppError::new("no active workspace"))?;
        let tab = open_tab(main, app, state, workspace, "about:blank")?;
        detach_tab(main, app, state, tab.id, None)?;
        lock(&state.host)
            .as_mut()
            .ok_or_else(|| AppError::new("engine not ready"))?
            .request_popout_address_focus(tab.id)?;
        Ok(())
    })
}

/// End the whole off-the-record session, including any hidden host window.
#[tauri::command]
#[specta::specta]
pub(crate) fn window_exit_private(app: AppHandle<Runtime>) -> AppResult<()> {
    if !crate::private_session::is_private() {
        return Err(AppError::new("This is not a private session"));
    }
    app.exit(0);
    Ok(())
}

/// Close the requesting chrome's own window, including an empty private home.
#[tauri::command]
#[specta::specta]
pub(crate) fn window_close(webview: tauri::Webview<Runtime>) -> AppResult<()> {
    webview.window().close().map_err(AppError::new)
}

/// Only the current registered popout chrome can acknowledge its readiness.
#[tauri::command]
#[specta::specta]
pub(crate) fn popout_ready(
    app: AppHandle<Runtime>,
    webview: tauri::Webview<Runtime>,
    id: TabId,
) -> AppResult<bool> {
    on_main(&app, move |_, _, state| {
        Ok(lock(&state.host)
            .as_mut()
            .ok_or_else(|| AppError::new("engine not ready"))?
            .popout_ready(id, webview.label())?)
    })
}

/// Fixed window commands from trusted detached chrome; never arbitrary script.
#[tauri::command]
#[specta::specta]
pub(crate) fn window_command(app: AppHandle<Runtime>, command: String) -> AppResult<()> {
    if command == "window.new" {
        return window_open(app);
    }
    if !crate::menu::main_window_command(&command) {
        return Err(AppError::new("unsupported window command"));
    }
    on_main(&app, move |_, app, state| {
        {
            let host = lock(&state.host);
            host.as_ref()
                .ok_or_else(|| AppError::new("engine not ready"))?
                .focus_main_chrome()?;
        }
        crate::menu::MenuCommand(command).emit_to(app, crate::CHROME_LABEL)?;
        Ok(())
    })
}

#[tauri::command]
#[specta::specta]
pub(crate) fn workspace_activate(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: WorkspaceId,
) -> AppResult<()> {
    let last = {
        let store = lock(&state.store);
        let w = store.workspace(id)?;
        store.set_setting(crate::state::ACTIVE_WORKSPACE, &id.to_string())?;
        // Remembered per profile, so switching back to a profile lands on
        // the workspace it was last in.
        store.set_setting(&profile_workspace_key(w.profile_id), &id.to_string())?;
        store.last_active_tab(id)?
    };
    *lock(&state.active_workspace) = Some(id);
    if let Some(host) = lock(&state.host).as_mut() {
        host.deactivate_all()?;
    }
    state.bus.publish(CoreEvent::WorkspaceActivated(id));
    if let Some(tab) = last {
        let next = tab.id;
        on_main(&app, move |main, app, state| {
            activate_tab(main, app, state, next)
        })?;
    }
    Ok(())
}

/// How many tabs a workspace holds, for the rail.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WorkspaceTabs {
    /// The workspace.
    pub workspace_id: WorkspaceId,
    /// Open tabs in it, including discarded tabs.
    pub tabs: u32,
}

/// Open tab count of every workspace, including discarded tabs. The snapshot carries the active
/// workspace's tabs, so the rail asks for the rest separately.
#[tauri::command]
#[specta::specta]
pub(crate) fn workspace_tab_counts(state: State<'_, AppState>) -> AppResult<Vec<WorkspaceTabs>> {
    Ok(lock(&state.store)
        .tab_counts()?
        .into_iter()
        .map(|(workspace_id, tabs)| WorkspaceTabs { workspace_id, tabs })
        .collect())
}

/// Persist a new rail order. Ids not listed keep their relative order after
/// the listed ones, so a reorder never has to name every workspace.
#[tauri::command]
#[specta::specta]
pub(crate) fn workspace_reorder(
    state: State<'_, AppState>,
    ordered: Vec<WorkspaceId>,
) -> AppResult<()> {
    let updated = {
        let store = lock(&state.store);
        let mut workspaces = store.workspaces()?;
        workspaces.sort_by_key(|w| {
            ordered
                .iter()
                .position(|id| *id == w.id)
                .unwrap_or(usize::MAX)
        });
        let mut updated = Vec::new();
        for (i, workspace) in workspaces.iter_mut().enumerate() {
            let position = i32::try_from(i).unwrap_or(i32::MAX);
            if workspace.position != position {
                workspace.position = position;
                store.upsert_workspace(workspace)?;
                updated.push(workspace.clone());
            }
        }
        updated
    };
    for workspace in updated {
        state.bus.publish(CoreEvent::WorkspaceUpserted(workspace));
    }
    Ok(())
}

/// Fields the chrome may set on a workspace.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WorkspaceDraft {
    /// Display name.
    pub name: String,
    /// CSS color.
    pub color: String,
    /// Icon identifier the chrome resolves to a glyph.
    pub icon: String,
}

#[tauri::command]
#[specta::specta]
pub(crate) fn workspace_create(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    draft: WorkspaceDraft,
    separate_container: bool,
) -> AppResult<Workspace> {
    let name = clean_name(&draft.name)?;
    // Validate every user field before creating a separate container. A bad
    // color or icon must not leave an orphan profile row behind.
    let color = clean_color(&draft.color)?;
    let icon = clean_icon(&draft.icon)?;
    let workspace = {
        let store = lock(&state.store);
        // A new workspace joins the profile you are in and browses in that
        // profile's container, unless it asks for cookies of its own.
        let profile = active_profile(&store, *lock(&state.active_workspace))?;
        let container = if separate_container {
            let c = dive_core::Container::new(&name);
            store.upsert_container(&c)?;
            c.id
        } else {
            profile.container_id
        };
        let position =
            i32::try_from(store.workspaces_for_profile(profile.id)?.len()).unwrap_or(i32::MAX);
        let mut w = Workspace::new(name, container, profile.id, position);
        w.color = color;
        w.icon = icon;
        store.upsert_workspace(&w)?;
        w
    };
    state
        .bus
        .publish(CoreEvent::WorkspaceUpserted(workspace.clone()));
    workspace_activate(app, state, workspace.id)?;
    Ok(workspace)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn workspace_update(
    state: State<'_, AppState>,
    id: WorkspaceId,
    draft: WorkspaceDraft,
) -> AppResult<Workspace> {
    let workspace = {
        let store = lock(&state.store);
        let mut w = store.workspace(id)?;
        w.name = clean_name(&draft.name)?;
        w.color = clean_color(&draft.color)?;
        w.icon = clean_icon(&draft.icon)?;
        store.upsert_workspace(&w)?;
        w
    };
    state
        .bus
        .publish(CoreEvent::WorkspaceUpserted(workspace.clone()));
    Ok(workspace)
}

/// Delete a workspace and its tabs. Refuses to delete the last one; if the
/// active workspace goes, the first remaining one becomes active.
#[tauri::command]
#[specta::specta]
pub(crate) fn workspace_delete(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: WorkspaceId,
) -> AppResult<()> {
    let (tab_ids, next) = {
        let store = lock(&state.store);
        let profile = store.workspace(id)?.profile_id;
        let all = store.workspaces_for_profile(profile)?;
        if all.len() <= 1 {
            return Err(AppError::new(
                "a profile keeps at least one workspace; delete the profile instead",
            ));
        }
        let tabs = store.tabs_for_workspace(id)?;
        let next = all.iter().find(|w| w.id != id).map(|w| w.id);
        (
            tabs.into_iter()
                .filter(|t| t.workspace_id == Some(id))
                .map(|t| t.id)
                .collect::<Vec<_>>(),
            next,
        )
    };
    if let Some(host) = lock(&state.host).as_mut() {
        for tab in &tab_ids {
            host.close(*tab)?;
        }
    }
    lock(&state.store).remove_workspace(id)?;
    for tab in tab_ids {
        state.bus.publish(CoreEvent::TabClosed(tab));
    }
    state.bus.publish(CoreEvent::WorkspaceRemoved(id));
    let was_active = *lock(&state.active_workspace) == Some(id);
    if was_active && let Some(next) = next {
        workspace_activate(app, state, next)?;
    }
    Ok(())
}

/// Setting key remembering the last workspace of a profile.
fn profile_workspace_key(profile: dive_core::ProfileId) -> String {
    format!("profile_workspace:{profile}")
}

/// The profile of the active workspace, else the first profile.
fn active_profile(
    store: &dive_core::Store,
    active: Option<WorkspaceId>,
) -> AppResult<dive_core::Profile> {
    if let Some(id) = active
        && let Ok(w) = store.workspace(id)
    {
        return Ok(store.profile(w.profile_id)?);
    }
    store
        .profiles()?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::new("no profile"))
}

/// What a profile is made of, from the profile dialog.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ProfileDraft {
    pub name: String,
    pub color: String,
    /// Avatar seed.
    pub avatar: String,
    pub note: String,
}

fn clean_profile(draft: &ProfileDraft) -> AppResult<(String, String, String, String)> {
    let name = clean_name(&draft.name)?;
    let color = clean_color(&draft.color)?;
    let avatar = draft.avatar.trim();
    if avatar.is_empty() || avatar.chars().count() > 64 {
        return Err(AppError::new("pick an avatar"));
    }
    let note = draft.note.trim();
    if note.chars().count() > 80 {
        return Err(AppError::new("the note is too long"));
    }
    Ok((name, color, avatar.to_owned(), note.to_owned()))
}

/// Every profile, in switcher order.
#[tauri::command]
#[specta::specta]
pub(crate) fn profiles_list(state: State<'_, AppState>) -> AppResult<Vec<dive_core::Profile>> {
    Ok(lock(&state.store).profiles()?)
}

/// Create a profile with a container of its own and a first workspace, and
/// switch to it.
#[tauri::command]
#[specta::specta]
pub(crate) fn profile_create(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    draft: ProfileDraft,
) -> AppResult<dive_core::Profile> {
    let (name, color, avatar, note) = clean_profile(&draft)?;
    let (profile, workspace) = {
        let store = lock(&state.store);
        let container = dive_core::Container::new(&name);
        store.upsert_container(&container)?;
        let position = i32::try_from(store.profiles()?.len()).unwrap_or(i32::MAX);
        let mut p = dive_core::Profile::new(name, container.id, position);
        p.color = color;
        p.avatar = avatar;
        p.note = note;
        store.upsert_profile(&p)?;
        let w = Workspace::new("Home", container.id, p.id, 0);
        store.upsert_workspace(&w)?;
        (p, w)
    };
    state
        .bus
        .publish(CoreEvent::ProfileUpserted(profile.clone()));
    state
        .bus
        .publish(CoreEvent::WorkspaceUpserted(workspace.clone()));
    workspace_activate(app, state, workspace.id)?;
    Ok(profile)
}

/// Rename or restyle a profile.
#[tauri::command]
#[specta::specta]
pub(crate) fn profile_update(
    state: State<'_, AppState>,
    id: dive_core::ProfileId,
    draft: ProfileDraft,
) -> AppResult<dive_core::Profile> {
    let (name, color, avatar, note) = clean_profile(&draft)?;
    let profile = {
        let store = lock(&state.store);
        let mut p = store.profile(id)?;
        p.name = name;
        p.color = color;
        p.avatar = avatar;
        p.note = note;
        store.upsert_profile(&p)?;
        p
    };
    state
        .bus
        .publish(CoreEvent::ProfileUpserted(profile.clone()));
    Ok(profile)
}

/// Switch to a profile: its last workspace, or its first.
#[tauri::command]
#[specta::specta]
pub(crate) fn profile_activate(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: dive_core::ProfileId,
) -> AppResult<()> {
    let target = {
        let store = lock(&state.store);
        store.profile(id)?;
        let workspaces = store.workspaces_for_profile(id)?;
        let remembered = store
            .setting(&profile_workspace_key(id))?
            .and_then(|s| s.parse::<WorkspaceId>().ok())
            .filter(|w| workspaces.iter().any(|x| x.id == *w));
        remembered
            .or_else(|| workspaces.first().map(|w| w.id))
            .ok_or_else(|| AppError::new("this profile has no workspace"))?
    };
    state.bus.publish(CoreEvent::ProfileActivated(id));
    workspace_activate(app, state, target)
}

/// Delete a profile with all its workspaces and tabs. Refuses to delete
/// the last profile; if the active one goes, another takes over.
#[tauri::command]
#[specta::specta]
pub(crate) fn profile_delete(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: dive_core::ProfileId,
) -> AppResult<()> {
    let (workspaces, tab_ids, next) = {
        let store = lock(&state.store);
        let profiles = store.profiles()?;
        if profiles.len() <= 1 {
            return Err(AppError::new("cannot delete the last profile"));
        }
        let workspaces = store.workspaces_for_profile(id)?;
        let mut tabs = Vec::new();
        for w in &workspaces {
            tabs.extend(
                store
                    .tabs_for_workspace(w.id)?
                    .into_iter()
                    .filter(|t| t.workspace_id == Some(w.id))
                    .map(|t| t.id),
            );
        }
        let next = profiles.iter().find(|p| p.id != id).map(|p| p.id);
        (workspaces, tabs, next)
    };
    if let Some(host) = lock(&state.host).as_mut() {
        for tab in &tab_ids {
            host.close(*tab)?;
        }
    }
    let was_active = {
        let active = *lock(&state.active_workspace);
        workspaces.iter().any(|w| Some(w.id) == active)
    };
    {
        let store = lock(&state.store);
        for w in &workspaces {
            store.remove_workspace(w.id)?;
        }
        store.remove_profile(id)?;
    }
    for tab in tab_ids {
        state.bus.publish(CoreEvent::TabClosed(tab));
    }
    for w in &workspaces {
        state.bus.publish(CoreEvent::WorkspaceRemoved(w.id));
    }
    state.bus.publish(CoreEvent::ProfileRemoved(id));
    if was_active && let Some(next) = next {
        profile_activate(app, state, next)?;
    }
    Ok(())
}

fn clean_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 40 {
        return Err(AppError::new("workspace name must be 1-40 characters"));
    }
    Ok(name.to_owned())
}

/// Accept only `#rgb` / `#rrggbb` so the value is safe to inject as CSS.
fn clean_color(color: &str) -> AppResult<String> {
    let c = color.trim();
    let hex = c.strip_prefix('#').unwrap_or("");
    if matches!(hex.len(), 3 | 6) && hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        Ok(c.to_ascii_uppercase())
    } else {
        Err(AppError::new("color must be a hex value like #4FC1C8"))
    }
}

/// Accept an icon identifier the chrome will be able to resolve.
///
/// The name seeds the workspace's generated mark in the chrome, so any name
/// draws something and one written by an older build still works. The shape is
/// all this side can check: lowercase, dashes, and short enough that it is a
/// name rather than smuggled markup.
fn clean_icon(icon: &str) -> AppResult<String> {
    let name = icon.trim().to_ascii_lowercase();
    if name.is_empty() {
        return Ok(Workspace::default_icon().to_owned());
    }
    if name.len() <= 32 && name.chars().all(|c| c.is_ascii_lowercase() || c == '-') {
        Ok(name)
    } else {
        Err(AppError::new("icon must be a lowercase icon name"))
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn tab_open(
    app: AppHandle<Runtime>,
    workspace_id: WorkspaceId,
    url: String,
) -> AppResult<Tab> {
    on_main(&app, move |main, app, state| {
        open_tab(main, app, state, workspace_id, &url)
    })
}

/// Create, persist, show and announce a new tab. Shared by the IPC command
/// and startup URL handling.
pub fn open_tab(
    main: &MainThread,
    app: &AppHandle<Runtime>,
    state: &AppState,
    workspace_id: WorkspaceId,
    url: &str,
) -> AppResult<Tab> {
    open_tab_with(main, app, state, workspace_id, url, true)
}

/// Open a tab, bringing it forward only when `activate` is set: a link
/// opened with a middle click loads behind the page it came from.
pub fn open_tab_with(
    main: &MainThread,
    app: &AppHandle<Runtime>,
    state: &AppState,
    workspace_id: WorkspaceId,
    url: &str,
    activate: bool,
) -> AppResult<Tab> {
    let url = normalize_url_with(url, state.prefs.get(state).search_template())?;
    let (tab, container) = {
        let store = lock(&state.store);
        let workspace = store.workspace(workspace_id)?;
        let container = store.container(workspace.container_id)?;
        let position =
            i32::try_from(store.tabs_for_workspace(workspace_id)?.len()).unwrap_or(i32::MAX);
        let mut tab = Tab::new(workspace_id, url.as_str(), position);
        // A built-in page has no document to name it; the chrome's name for
        // it is the title from the start.
        if url.scheme() == crate::engine::INTERNAL_SCHEME {
            tab.title = internal_title(&url);
        }
        store.upsert_tab(&tab)?;
        (tab, container)
    };
    let opened = {
        let mut host = lock(&state.host);
        match host.as_mut() {
            Some(host) => match host.open(main, app, &tab, &container) {
                Ok(()) if !activate => Ok(()),
                Ok(()) => host.activate(main, tab.id).map_err(|error| {
                    let _ = host.close(tab.id);
                    AppError::from(error)
                }),
                Err(error) => Err(AppError::from(error)),
            },
            None => Err(AppError::new("engine not ready")),
        }
    };
    if let Err(error) = opened {
        // Persistence precedes view creation so engine callbacks can safely
        // update the row. Compensate if the native view could not be created.
        if let Err(rollback) = lock(&state.store).remove_tab(tab.id) {
            tracing::warn!(id = %tab.id, "failed to roll back unopened tab: {rollback}");
        }
        return Err(error);
    }
    state.bus.publish(CoreEvent::TabUpserted(tab.clone()));
    if activate {
        lock(&state.store).set_setting(crate::state::ACTIVE_TAB, &tab.id.to_string())?;
        state.bus.publish(CoreEvent::TabActivated(tab.id));
    }
    Ok(tab)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn tab_close(app: AppHandle<Runtime>, id: TabId) -> AppResult<()> {
    use tauri::Manager as _;
    on_main(&app, move |main, app, state| {
        let was_detached = lock(&state.host)
            .as_ref()
            .is_some_and(|host| host.is_detached(id));
        close_tab(main, app, state, id)?;
        if crate::private_session::is_private() && !was_detached {
            let detached = lock(&state.host)
                .as_ref()
                .map_or_else(Vec::new, crate::engine::TabHost::detached);
            let has_attached = {
                let store = lock(&state.store);
                store.workspaces()?.iter().any(|workspace| {
                    store
                        .tabs_for_workspace(workspace.id)
                        .is_ok_and(|tabs| tabs.iter().any(|tab| !detached.contains(&tab.id)))
                })
            };
            if !has_attached && let Some(window) = app.get_window(crate::MAIN_WINDOW) {
                window.close()?;
            }
        }
        Ok(())
    })
}

/// Close `id`: destroy its view (and its window, if it had one of its own),
/// forget it, and move on to the workspace's previous tab if it was showing.
pub fn close_tab(
    main: &MainThread,
    app: &AppHandle<Runtime>,
    state: &AppState,
    id: TabId,
) -> AppResult<()> {
    crate::subtitles::stop_tab(app, id);
    let (was_active, workspace) = {
        let mut host = lock(&state.host);
        let store = lock(&state.store);
        let tab = store.tab(id)?;
        let was_active = host.as_ref().and_then(crate::engine::TabHost::active) == Some(id);
        if let Some(host) = host.as_mut() {
            host.close(id)?;
        }
        store.remove_tab(id)?;
        (
            was_active,
            tab.workspace_id.or(*lock(&state.active_workspace)),
        )
    };
    state.buffers.drop_tab(id);
    state.inspector.drop_tab(id);
    state.crashes.drop_tab(id);
    state.privacy_pages.drop_tab(id);
    state.screencast.discard(id);
    state.bus.publish(CoreEvent::TabClosed(id));
    // Picked in its own statement so the store guard is released before
    // `activate_tab` takes the store again. Inside an `if let` chain the
    // guard lives through the body, and the second lock never returns:
    // closing the active tab froze the main thread.
    let next = match workspace {
        Some(ws) if was_active => lock(&state.store).last_active_tab(ws)?,
        _ => None,
    };
    if let Some(next) = next {
        activate_tab(main, app, state, next.id)?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn tab_activate(app: AppHandle<Runtime>, id: TabId) -> AppResult<()> {
    on_main(&app, move |main, app, state| {
        activate_tab(main, app, state, id)
    })
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
    let (added_bookmarks, added_history, added_forms, profile) = {
        let store = lock(&state.store);
        let profile = active_profile(&store, *lock(&state.active_workspace))?;
        (
            store.import_bookmarks(&harvest.bookmarks)?,
            store.import_history(&harvest.history)?,
            store.import_form_entries(profile.id, &harvest.forms)?,
            profile,
        )
    };
    let known = crate::passwords::list(&state, profile.id)?;
    let mut added_passwords = 0u32;
    for login in &harvest.passwords {
        if known
            .iter()
            .any(|c| c.origin == login.origin && c.username == login.username)
        {
            continue;
        }
        if crate::passwords::save(
            &state,
            profile.id,
            &login.origin,
            &login.username,
            &login.password,
        )
        .is_ok()
        {
            added_passwords += 1;
        }
    }
    Ok(crate::browser_import::ImportSummary {
        bookmarks: u32::try_from(added_bookmarks).unwrap_or(u32::MAX),
        history: u32::try_from(added_history).unwrap_or(u32::MAX),
        passwords: added_passwords,
        forms: u32::try_from(added_forms).unwrap_or(u32::MAX),
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

/// Show the workspace's welcome screen: hide every tab view without closing
/// or forgetting any tab. The next snapshot reports no active tab, and
/// clicking a tab brings its page back.
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_deactivate(app: AppHandle<Runtime>) -> AppResult<()> {
    on_main(&app, move |_, _, state| {
        if let Some(host) = lock(&state.host).as_mut() {
            host.deactivate_all()?;
        }
        Ok(())
    })
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

/// Run `f` on the main thread and wait for its result.
///
/// Under the CEF runtime Tauri hands every IPC command to a worker thread,
/// and native views may only be created, shown or moved from the main
/// thread, so engine-facing commands hop there. Call this before taking any
/// lock the closure will need, or the hop waits on itself.
fn on_main<T: Send + 'static>(
    app: &AppHandle<Runtime>,
    f: impl FnOnce(&MainThread, &AppHandle<Runtime>, &AppState) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    use tauri::Manager;
    if let Some(main) = MainThread::here() {
        let state = app.state::<AppState>();
        return f(&main, app, &state);
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = match MainThread::here() {
            Some(main) => {
                let state = handle.state::<AppState>();
                f(&main, &handle, &state)
            }
            None => Err(AppError::new("main-thread hop landed on another thread")),
        };
        let _ = tx.send(result);
    })?;
    rx.recv()
        .map_err(|_| AppError::new("the main thread dropped the command"))?
}

/// Show `id` (recreating its view if it was discarded), persist it as the
/// active tab and announce the change.
pub fn activate_tab(
    main: &MainThread,
    app: &AppHandle<Runtime>,
    state: &AppState,
    id: TabId,
) -> AppResult<()> {
    // Lock order everywhere: host, then store. Holding both here closes the
    // window in which a concurrent `tab_close` could delete the row while we
    // recreate its view.
    let tab = {
        let mut host = lock(&state.host);
        let host = host
            .as_mut()
            .ok_or_else(|| AppError::new("engine not ready"))?;
        // A tab in its own window is "activated" by raising that window; the
        // main window's page does not change.
        if host.is_detached(id) {
            host.focus_popout(id)?;
            return Ok(());
        }
        let store = lock(&state.store);
        let mut tab = store.tab(id)?;
        if !host.has(id) {
            let ws = tab
                .workspace_id
                .or(*lock(&state.active_workspace))
                .ok_or_else(|| AppError::new("tab has no workspace"))?;
            let container = store.container(store.workspace(ws)?.container_id)?;
            host.open(main, app, &tab, &container)?;
            crate::housekeeping::restore_scroll(app.clone(), id);
        }
        host.activate(main, id)?;
        tab.last_active_at = dive_core::Timestamp::now();
        tab.state = dive_core::TabState::Active;
        store.upsert_tab(&tab)?;
        store.set_setting(crate::state::ACTIVE_TAB, &id.to_string())?;
        tab
    };
    state.bus.publish(CoreEvent::TabUpserted(tab));
    state.bus.publish(CoreEvent::TabActivated(id));
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn tab_navigate(state: State<'_, AppState>, id: TabId, url: String) -> AppResult<()> {
    let url = normalize_url_with(&url, state.prefs.get(&state).search_template())?;
    let host = lock(&state.host);
    host.as_ref()
        .ok_or_else(|| AppError::new("engine not ready"))?
        .navigate(id, url)?;
    Ok(())
}

/// What a `dive://` page is called in the strip.
pub fn internal_title(url: &url::Url) -> String {
    match url.host_str() {
        Some("screen") => "DiveScreen".into(),
        Some("capture") => "Dive Capture".into(),
        Some(other) => format!("Dive {other}"),
        None => "Dive".into(),
    }
}

/// Persist a new order for the tabs of `workspace_id`. Ids not listed keep
/// their relative order after the listed ones.
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_reorder(
    state: State<'_, AppState>,
    workspace_id: WorkspaceId,
    ordered: Vec<TabId>,
) -> AppResult<()> {
    let updated = {
        let store = lock(&state.store);
        let mut tabs: Vec<Tab> = store
            .tabs_for_workspace(workspace_id)?
            .into_iter()
            .filter(|t| t.workspace_id == Some(workspace_id))
            .collect();
        tabs.sort_by_key(|t| {
            ordered
                .iter()
                .position(|id| *id == t.id)
                .unwrap_or(usize::MAX)
        });
        let mut updated = Vec::new();
        for (i, tab) in tabs.iter_mut().enumerate() {
            let position = i32::try_from(i).unwrap_or(i32::MAX);
            if tab.position != position {
                tab.position = position;
                store.upsert_tab(tab)?;
                updated.push(tab.clone());
            }
        }
        updated
    };
    for tab in updated {
        state.bus.publish(CoreEvent::TabUpserted(tab));
    }
    Ok(())
}

/// Move a tab between the pinned and today tiers.
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_set_pinned(state: State<'_, AppState>, id: TabId, pinned: bool) -> AppResult<()> {
    let tab = {
        let store = lock(&state.store);
        let mut tab = store.tab(id)?;
        tab.tier = if pinned {
            dive_core::TabTier::Pinned
        } else {
            dive_core::TabTier::Today
        };
        store.upsert_tab(&tab)?;
        tab
    };
    state.bus.publish(CoreEvent::TabUpserted(tab));
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn tab_back(state: State<'_, AppState>, id: TabId) -> AppResult<()> {
    with_view(&state, id, tauri::Webview::go_back)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn tab_forward(state: State<'_, AppState>, id: TabId) -> AppResult<()> {
    with_view(&state, id, tauri::Webview::go_forward)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn tab_reload(state: State<'_, AppState>, id: TabId) -> AppResult<()> {
    with_view(&state, id, tauri::Webview::reload)
}

/// Open Chromium's `DevTools` window for a tab.
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_devtools(state: State<'_, AppState>, id: TabId) -> AppResult<()> {
    with_view(&state, id, |v| {
        v.open_devtools();
        Ok(())
    })
}

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

/// Stop recording and encode the file; returns what was written.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_screencast_stop(
    state: State<'_, AppState>,
    id: TabId,
) -> AppResult<crate::screencast::RecordingResult> {
    let session = cdp_for(&state, id)?;
    state.screencast.stop(id, &session).await
}

/// Throw a recording away without encoding it.
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
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(&file).status();
    #[cfg(target_os = "linux")]
    let status = std::process::Command::new("xdg-open").arg(&file).status();
    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("cmd")
        .args(["/C", "start", ""])
        .arg(&file)
        .status();
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(AppError::new(format!("could not open the file ({s})"))),
        Err(e) => Err(AppError::new(e)),
    }
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

/// Zoom levels the chrome steps through; `1.0` is the default.
pub const ZOOM_STEPS: &[f64] = &[
    0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0,
];

/// Set a tab's zoom factor (clamped to the step range).
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_zoom(state: State<'_, AppState>, id: TabId, factor: f64) -> AppResult<()> {
    let factor = factor.clamp(ZOOM_STEPS[0], ZOOM_STEPS[ZOOM_STEPS.len() - 1]);
    with_view(&state, id, |v| v.set_zoom(factor))?;
    // Zoom is a per-site preference, as in every browser: remember it for
    // the origin so the next visit opens at the same size.
    let origin = lock(&state.store)
        .tab(id)
        .ok()
        .and_then(|t| dive_core::origin_of(&t.url));
    if let Some(origin) = origin {
        let key = format!("{}{origin}", crate::engine::SITE_ZOOM_PREFIX);
        let store = lock(&state.store);
        if (factor - state.prefs.get(&state).default_zoom).abs() < f64::EPSILON {
            store.remove_setting(&key)?;
        } else {
            store.set_setting(&key, &factor.to_string())?;
        }
    }
    Ok(())
}

/// Stop the tab's current load.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_stop(state: State<'_, AppState>, id: TabId) -> AppResult<()> {
    let session = lock(&state.host)
        .as_ref()
        .and_then(|h| h.cdp(id))
        .ok_or_else(|| AppError::new("no devtools session"))?;
    session
        .call0("Page.stopLoading")
        .await
        .map_err(|e| AppError::new(e.to_string()))?;
    Ok(())
}

/// Fill the tab with the page's video, or leave that state. Returns what
/// the page did: `filled`, `exited`, `no-video` or `unavailable`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_fill_video(state: State<'_, AppState>, id: TabId) -> AppResult<String> {
    let session = lock(&state.host)
        .as_ref()
        .and_then(|h| h.cdp(id))
        .ok_or_else(|| AppError::new("no devtools session"))?;
    Ok(crate::filltab::toggle(&session).await)
}

/// Open the system print dialog for the tab's page.
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_print(app: AppHandle<Runtime>, id: TabId) -> AppResult<()> {
    on_main(&app, move |_, _, state| {
        with_view(state, id, tauri::Webview::print)
    })
}

/// Move a tab between the Essential, Pinned and Today strips.
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_set_tier(
    state: State<'_, AppState>,
    id: TabId,
    tier: dive_core::TabTier,
) -> AppResult<()> {
    let tab = {
        let store = lock(&state.store);
        let mut tab = store.tab(id)?;
        tab.tier = tier;
        store.upsert_tab(&tab)?;
        tab
    };
    state.bus.publish(CoreEvent::TabUpserted(tab));
    Ok(())
}

/// Every login saved in the active profile.
#[tauri::command]
#[specta::specta]
pub(crate) fn passwords_list(state: State<'_, AppState>) -> AppResult<Vec<dive_core::Credential>> {
    let profile = active_profile(&lock(&state.store), *lock(&state.active_workspace))?;
    crate::passwords::list(&state, profile.id)
}

/// Logins saved for the site of `url`, most used first.
#[tauri::command]
#[specta::specta]
pub(crate) fn passwords_for_url(
    state: State<'_, AppState>,
    url: String,
) -> AppResult<Vec<dive_core::Credential>> {
    let profile = active_profile(&lock(&state.store), *lock(&state.active_workspace))?;
    crate::passwords::for_url(&state, profile.id, &url)
}

/// Save a login for the site of `url` in the active profile.
#[tauri::command]
#[specta::specta]
pub(crate) fn passwords_save(
    state: State<'_, AppState>,
    url: String,
    username: String,
    password: String,
) -> AppResult<dive_core::Credential> {
    let profile = active_profile(&lock(&state.store), *lock(&state.active_workspace))?;
    crate::passwords::save(&state, profile.id, &url, &username, &password)
}

/// The password behind a saved login.
#[tauri::command]
#[specta::specta]
pub(crate) fn passwords_reveal(state: State<'_, AppState>, id: String) -> AppResult<String> {
    let profile = active_profile(&lock(&state.store), *lock(&state.active_workspace))?;
    crate::passwords::reveal(&state, profile.id, &id)
}

/// Note that a saved login was just filled, so the site's most used login
/// comes first next time.
#[tauri::command]
#[specta::specta]
pub(crate) fn passwords_used(state: State<'_, AppState>, id: String) -> AppResult<()> {
    crate::passwords::touch(&state, &id)
}

/// Answer a save or update prompt: save the submitted login, or let it go.
#[tauri::command]
#[specta::specta]
pub(crate) fn passwords_answer(
    state: State<'_, AppState>,
    token: String,
    save: bool,
) -> AppResult<Option<dive_core::Credential>> {
    crate::credential_fill::answer(&state, &token, save)
}

/// Answer a save prompt with "never for this site"; returns the origin.
#[tauri::command]
#[specta::specta]
pub(crate) fn passwords_never(state: State<'_, AppState>, token: String) -> AppResult<String> {
    crate::credential_fill::never(&state, &token)
}

/// Sites the active profile never wants a save offered for.
#[tauri::command]
#[specta::specta]
pub(crate) fn passwords_never_list(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    let profile = active_profile(&lock(&state.store), *lock(&state.active_workspace))?;
    crate::passwords::never_list(&state, profile.id)
}

/// Offer to save again for `origin`.
#[tauri::command]
#[specta::specta]
pub(crate) fn passwords_never_remove(
    state: State<'_, AppState>,
    origin: String,
) -> AppResult<bool> {
    let profile = active_profile(&lock(&state.store), *lock(&state.active_workspace))?;
    crate::passwords::never_remove(&state, profile.id, &origin)
}

/// Fill the chosen saved login into the tab's login form.
#[tauri::command]
#[specta::specta]
pub(crate) async fn passwords_fill(
    app: AppHandle<Runtime>,
    tab_id: TabId,
    id: String,
) -> AppResult<()> {
    crate::credential_fill::fill_into(app, tab_id, id).await
}

/// Ask for a password CSV export to import; `None` when the person cancels.
#[tauri::command]
#[specta::specta]
pub(crate) async fn passwords_pick_csv() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Import passwords from a CSV export")
        .add_filter("CSV", &["csv", "txt"])
        .pick_file()
        .await
        .map(|file| file.path().to_string_lossy().into_owned())
}

/// Import the logins in a CSV export into the active profile.
#[tauri::command]
#[specta::specta]
pub(crate) fn passwords_import_csv(
    state: State<'_, AppState>,
    path: String,
) -> AppResult<crate::passwords::CsvImportSummary> {
    let text = std::fs::read_to_string(&path)
        .map_err(|e| AppError::new(format!("could not read {path}: {e}")))?;
    let profile = active_profile(&lock(&state.store), *lock(&state.active_workspace))?;
    crate::passwords::import_csv(&state, profile.id, &text)
}

/// Forget a saved login.
#[tauri::command]
#[specta::specta]
pub(crate) fn passwords_delete(state: State<'_, AppState>, id: String) -> AppResult<bool> {
    let profile = active_profile(&lock(&state.store), *lock(&state.active_workspace))?;
    crate::passwords::delete(&state, profile.id, &id)
}

/// Every form entry remembered in the active profile.
#[tauri::command]
#[specta::specta]
pub(crate) fn forms_list(state: State<'_, AppState>) -> AppResult<Vec<dive_core::FormEntry>> {
    let store = lock(&state.store);
    let profile = active_profile(&store, *lock(&state.active_workspace))?;
    Ok(store.form_entries(profile.id)?)
}

/// Forget one form entry.
#[tauri::command]
#[specta::specta]
pub(crate) fn forms_delete(state: State<'_, AppState>, id: String) -> AppResult<bool> {
    let store = lock(&state.store);
    let profile = active_profile(&store, *lock(&state.active_workspace))?;
    let owned = store.form_entries(profile.id)?.iter().any(|e| e.id == id);
    if !owned {
        return Ok(false);
    }
    Ok(store.remove_form_entry(&id)?)
}

/// Forget every form entry in the active profile; returns how many went.
#[tauri::command]
#[specta::specta]
pub(crate) fn forms_clear(state: State<'_, AppState>) -> AppResult<u32> {
    let store = lock(&state.store);
    let profile = active_profile(&store, *lock(&state.active_workspace))?;
    Ok(u32::try_from(store.clear_form_entries(profile.id)?).unwrap_or(u32::MAX))
}

/// Forget a bookmark by URL.
#[tauri::command]
#[specta::specta]
pub(crate) fn bookmark_remove(state: State<'_, AppState>, url: String) -> AppResult<bool> {
    Ok(lock(&state.store).remove_bookmark(&url)?)
}

/// Give a bookmark a new title, keeping its URL and creation time. A blank
/// title is refused rather than erasing the one on record.
#[tauri::command]
#[specta::specta]
pub(crate) fn bookmark_rename(
    state: State<'_, AppState>,
    url: String,
    title: String,
) -> AppResult<()> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::new("a bookmark needs a title"));
    }
    lock(&state.store).add_bookmark(&url, title, dive_core::Timestamp::now())?;
    Ok(())
}

/// Remember or forget a permission in the selected profile and real container.
#[tauri::command]
#[specta::specta]
pub(crate) fn permission_set(
    app: AppHandle<Runtime>,
    webview: tauri::Webview<Runtime>,
    scope: crate::permissions::Scope,
    origin: String,
    kind: String,
    decision: crate::permissions::Decision,
) -> AppResult<()> {
    on_main(&app, move |_, app, state| {
        crate::permissions::require_chrome(&webview)?;
        crate::permissions::set(app, state, &scope, &origin, &kind, decision)
    })
}
/// Resolve the original native request; its opaque ID carries trusted provenance.
#[tauri::command]
#[specta::specta]
pub(crate) fn permission_reply(
    app: AppHandle<Runtime>,
    webview: tauri::Webview<Runtime>,
    tab_id: TabId,
    request_id: String,
    decision: crate::permissions::Decision,
    duration: crate::permissions::Duration,
) -> AppResult<()> {
    on_main(&app, move |_, _, state| {
        crate::permissions::require_chrome(&webview)?;
        crate::permissions::reply(state, tab_id, &request_id, decision, duration)
    })
}
/// Remembered permissions in the active profile and container.
#[tauri::command]
#[specta::specta]
pub(crate) fn permissions_list(
    app: AppHandle<Runtime>,
    webview: tauri::Webview<Runtime>,
) -> AppResult<crate::permissions::PermissionList> {
    on_main(&app, move |_, _, state| {
        crate::permissions::require_chrome(&webview)?;
        Ok(crate::permissions::all(state)?)
    })
}

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

/// Ask the release channel for a newer build. `None` when this build has
/// no updater (development) or is current.
#[tauri::command]
#[specta::specta]
pub(crate) async fn update_check(app: AppHandle<Runtime>) -> AppResult<Option<UpdateInfo>> {
    if !updater_configured(option_env!("DIVE_UPDATER_PUBKEY")) {
        return Ok(None);
    }
    let Ok(updater) = app.updater() else {
        return Ok(None);
    };
    let found = updater
        .check()
        .await
        .map_err(|e| AppError::new(e.to_string()))?;
    Ok(found.map(|u| UpdateInfo {
        version: u.version.clone(),
        notes: u.body.clone(),
    }))
}

/// Download and install the offered update; the app restarts when done.
#[tauri::command]
#[specta::specta]
pub(crate) async fn update_install(app: AppHandle<Runtime>) -> AppResult<()> {
    if !updater_configured(option_env!("DIVE_UPDATER_PUBKEY")) {
        return Err(AppError::new("this build has no updater"));
    }
    let updater = app
        .updater()
        .map_err(|_| AppError::new("this build has no updater"))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|e| AppError::new(e.to_string()))?
    else {
        return Err(AppError::new("already up to date"));
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| AppError::new(e.to_string()))?;
    app.restart();
}

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

/// Emulate `device` on a tab, or clear emulation with `None`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_emulate(
    state: State<'_, AppState>,
    id: TabId,
    device: Option<crate::emulate::Device>,
    reload: bool,
) -> AppResult<()> {
    let session = cdp_for(&state, id)?;
    crate::emulate::apply(&session, crate::emulate::device_calls(device.as_ref())).await?;
    // Remembered so an agent's page_resize can tell whether the user agent
    // moved from what the chrome last applied, and reload only then.
    state.buffers.set_device(id, device);
    // Metrics take effect live; the user agent does not. The chrome asks for
    // a reload only when the UA changed, so rotating or zooming a phone does
    // not throw the page's state away.
    if reload {
        session.call0("Page.reload").await.map_err(AppError::new)?;
    }
    Ok(())
}

/// Override where and when the page thinks it is: geolocation, time zone,
/// locale. Unset fields clear their override.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_environment(
    state: State<'_, AppState>,
    id: TabId,
    environment: crate::emulate::Environment,
) -> AppResult<()> {
    let session = cdp_for(&state, id)?;
    crate::emulate::apply(&session, crate::emulate::environment_calls(&environment)).await
}

/// The device catalog, for the picker and for anything scripting Dive.
#[tauri::command]
#[specta::specta]
pub(crate) fn device_presets() -> Vec<crate::emulate::Preset> {
    crate::emulate::presets()
}

/// Override media features (color scheme, reduced motion, media type).
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_media(
    state: State<'_, AppState>,
    id: TabId,
    media: crate::emulate::MediaOverrides,
) -> AppResult<()> {
    let session = cdp_for(&state, id)?;
    let (method, params) = crate::emulate::media_call(&media);
    session.call(method, params).await.map_err(AppError::new)?;
    state.buffers.set_media(id, media);
    Ok(())
}

/// Mock and rewrite rules of a workspace.
#[tauri::command]
#[specta::specta]
pub(crate) fn rules_list(
    state: State<'_, AppState>,
    workspace: WorkspaceId,
) -> Vec<crate::rules::Rule> {
    state.rules.list(&state, workspace)
}

/// Replace a workspace's rules and re-apply interception on its open tabs.
#[tauri::command]
#[specta::specta]
pub(crate) async fn rules_set(
    state: State<'_, AppState>,
    workspace: WorkspaceId,
    rules: Vec<crate::rules::Rule>,
) -> AppResult<()> {
    state.rules.set(&state, workspace, rules)?;
    reapply_interception(&state, Some(workspace)).await;
    Ok(())
}

#[derive(Default)]
struct ReapplySummary {
    dead: Vec<TabId>,
    failed: Vec<(TabId, String)>,
}

async fn apply_interception_targets(
    targets: Vec<(TabId, Vec<crate::rules::Rule>, dive_cdp::CdpSession)>,
    prefs: &crate::prefs::Prefs,
) -> ReapplySummary {
    let mut summary = ReapplySummary::default();
    for (tab_id, rules, session) in targets {
        if session.is_closed() {
            summary.dead.push(tab_id);
            continue;
        }
        if let Err(error) = crate::rules::apply(&session, &rules, prefs).await {
            summary.failed.push((tab_id, error.message));
        }
    }
    summary
}

/// Reapply shared Fetch interception on all tabs, or those owned by one workspace.
pub(crate) async fn reapply_interception(state: &AppState, workspace: Option<WorkspaceId>) {
    let prefs = state.prefs.get(state);
    let sessions: Vec<(TabId, Option<WorkspaceId>, dive_cdp::CdpSession)> = {
        let host = lock(&state.host);
        let store = lock(&state.store);
        host.as_ref().map_or_else(Vec::new, |host| {
            host.sessions()
                .into_iter()
                .filter_map(|(id, session)| {
                    let owner = store.tab(id).ok()?.workspace_id;
                    (workspace.is_none() || owner == workspace).then_some((id, owner, session))
                })
                .collect()
        })
    };
    // Rule cache misses read the store, so resolve them only after releasing
    // the host/store snapshot locks above.
    let targets = sessions
        .into_iter()
        .map(|(id, owner, session)| {
            let rules = owner.map_or_else(Vec::new, |id| state.rules.list(state, id));
            (id, rules, session)
        })
        .collect();
    let summary = apply_interception_targets(targets, &prefs).await;
    for tab_id in &summary.dead {
        tracing::debug!(%tab_id, "pruning closed interception session");
        state.privacy_pages.drop_tab(*tab_id);
    }
    for (tab_id, error) in &summary.failed {
        tracing::warn!(%tab_id, %error, "could not reapply interception to tab");
    }
    let pruned = lock(&state.host)
        .as_mut()
        .map_or_else(Vec::new, crate::engine::TabHost::prune_closed_sessions);
    for tab_id in pruned {
        tracing::debug!(%tab_id, "pruned closed CDP session after interception reapply");
        state.privacy_pages.drop_tab(tab_id);
    }
}

/// Reapply interception after an existing workspace-rules integration writes rules.
pub(crate) async fn reapply_rules(state: &AppState, workspace: WorkspaceId) -> AppResult<()> {
    reapply_interception(state, Some(workspace)).await;
    Ok(())
}

/// Throttle a tab's network, or clear throttling with `None`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_throttle(
    state: State<'_, AppState>,
    id: TabId,
    profile: Option<crate::emulate::NetworkProfile>,
) -> AppResult<()> {
    let session = cdp_for(&state, id)?;
    let (method, params) = crate::emulate::network_call(profile);
    session.call(method, params).await.map_err(AppError::new)?;
    Ok(())
}

/// Cookies and web storage for a tab.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_storage(
    state: State<'_, AppState>,
    id: TabId,
) -> AppResult<crate::storage::StorageSnapshot> {
    let url = lock(&state.store).tab(id)?.url;
    let session = cdp_for(&state, id)?;
    crate::storage::snapshot(&session, &url).await
}

/// Remove a cookie or a web-storage key from the Storage panel.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_storage_delete(
    state: State<'_, AppState>,
    id: TabId,
    section: String,
    key: String,
    domain: Option<String>,
    path: Option<String>,
) -> AppResult<()> {
    let url = lock(&state.store).tab(id)?.url;
    let session = cdp_for(&state, id)?;
    crate::storage::delete(
        &session,
        &url,
        &section,
        &key,
        domain.as_deref(),
        path.as_deref(),
    )
    .await
}

/// Find in page: select match `index` (1-based, wraps) of `query`; empty query clears.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_find(
    state: State<'_, AppState>,
    id: TabId,
    query: String,
    index: i32,
) -> AppResult<crate::find::FindResult> {
    let session = cdp_for(&state, id)?;
    crate::find::find(&session, &query, index).await
}

/// Web Vitals from buffered performance entries.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_vitals(
    state: State<'_, AppState>,
    id: TabId,
) -> AppResult<crate::vitals::Vitals> {
    let session = cdp_for(&state, id)?;
    crate::vitals::read(&session).await
}

/// Map a script location to its original source through source maps.
#[tauri::command]
#[specta::specta]
pub(crate) async fn resolve_frame(
    state: State<'_, AppState>,
    tab_id: TabId,
    url: String,
    line: u32,
    column: Option<u32>,
) -> AppResult<Option<crate::sourcemaps::Original>> {
    let page_url = lock(&state.store).tab(tab_id)?.url;
    Ok(state
        .sourcemaps
        .resolve(&page_url, &url, line, column.unwrap_or(1))
        .await)
}

/// The captured request as an editable replay draft.
#[tauri::command]
#[specta::specta]
pub(crate) fn request_captured(
    state: State<'_, AppState>,
    tab_id: TabId,
    request_id: String,
) -> AppResult<crate::replay::ReplayRequest> {
    let r = state
        .buffers
        .request(tab_id, &request_id)
        .ok_or_else(|| AppError::new("request no longer in the buffer"))?;
    let captured_host = url::Url::parse(&r.url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_default();
    Ok(crate::replay::ReplayRequest {
        method: r.method,
        url: r.url,
        headers: r.headers,
        body: r.post_data,
        with_cookies: true,
        captured_host,
    })
}

/// What was sent and what came back, for reading rather than editing.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct RequestDetail {
    pub method: String,
    pub url: String,
    pub status: Option<u16>,
    pub mime_type: String,
    pub request_headers: std::collections::BTreeMap<String, String>,
    pub request_body: Option<String>,
    pub response_headers: std::collections::BTreeMap<String, String>,
    /// The body when it was captured (JSON within the budget).
    pub response_body: Option<String>,
    /// Why the body is absent, when it is.
    pub response_body_note: Option<String>,
}

/// The captured request and response for the Network panel's detail pane.
#[tauri::command]
#[specta::specta]
pub(crate) fn request_detail(
    state: State<'_, AppState>,
    tab_id: TabId,
    request_id: String,
) -> AppResult<RequestDetail> {
    let r = state
        .buffers
        .request(tab_id, &request_id)
        .ok_or_else(|| AppError::new("request no longer in the buffer"))?;
    Ok(RequestDetail {
        method: r.method,
        url: r.url,
        status: r.status,
        mime_type: r.mime_type,
        request_headers: r.headers,
        request_body: r.post_data,
        response_headers: r.response_headers,
        response_body: r.response_body,
        response_body_note: r.response_body_note,
    })
}

/// Replay a (possibly edited) request, optionally with the tab's cookies.
#[tauri::command]
#[specta::specta]
pub(crate) async fn request_replay(
    state: State<'_, AppState>,
    tab_id: TabId,
    request: crate::replay::ReplayRequest,
) -> AppResult<crate::replay::ReplayResponse> {
    let cookie = if crate::replay::cookies_allowed(&request) {
        let session = cdp_for(&state, tab_id)?;
        crate::replay::cookie_header(&session, &request.url).await
    } else {
        None
    };
    crate::replay::send(&request, cookie).await
}

/// `OpenAPI` 3.1 JSON inferred from the tab's captured traffic; also saved
/// under captures and copied to the clipboard.
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_openapi(state: State<'_, AppState>, id: TabId) -> AppResult<String> {
    let page_url = lock(&state.store).tab(id)?.url;
    let requests = state.buffers.requests(id, 1000);
    let spec = crate::openapi::from_requests(&page_url, &requests);
    let text = serde_json::to_string_pretty(&spec).map_err(AppError::new)?;
    let path = stamped_capture(&page_url, "openapi", "json")?;
    std::fs::write(&path, &text)?;
    if let Ok(mut cb) = arboard::Clipboard::new() {
        let _ = cb.set_text(text);
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Export the captured requests of a tab as a HAR 1.2 file; returns its path.
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_har(state: State<'_, AppState>, id: TabId) -> AppResult<String> {
    let tab = lock(&state.store).tab(id)?;
    let requests = state.buffers.requests(id, 1000);
    let har = crate::har::from_requests(&tab.url, &tab.title, &requests);
    let path = stamped_capture(&tab.url, "requests", "har")?;
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&har).map_err(AppError::new)?,
    )?;
    Ok(path.to_string_lossy().into_owned())
}

/// Compose a Markdown bug report for a tab (viewport screenshot, console
/// errors, failed requests), copy it to the clipboard and save it; returns
/// the report path.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_bug_report(state: State<'_, AppState>, id: TabId) -> AppResult<String> {
    let shot = capture_tab(&state, id, false).await.ok();
    let tab = lock(&state.store).tab(id)?;
    let console = state.buffers.console_tail(id, 500);
    let requests = state.buffers.requests(id, 1000);
    let text = crate::report::compose(&tab, &console, &requests, shot.as_deref());
    let path = stamped_capture(&tab.url, "bug report", "md")?;
    std::fs::write(&path, &text)?;
    if let Ok(mut cb) = arboard::Clipboard::new() {
        let _ = cb.set_text(text);
    }
    Ok(path.to_string_lossy().into_owned())
}

/// `<captures>/<prefix>-<timestamp>.<ext>`.
fn stamped_capture(page_url: &str, kind: &str, ext: &str) -> AppResult<std::path::PathBuf> {
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

/// Start recording the person's interactions in a tab.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_record_start(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: TabId,
) -> AppResult<()> {
    let session = cdp_for(&state, id)?;
    crate::recorder::start(app, id, session).await
}

/// Stop recording and return the steps.
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_record_stop(
    state: State<'_, AppState>,
    id: TabId,
) -> Vec<crate::recorder::RecordedStep> {
    let (steps, script_id) = state.buffers.finish_recording(id);
    if let Ok(session) = cdp_for(&state, id) {
        tauri::async_runtime::spawn(crate::recorder::stop(session, script_id));
    }
    steps
}

/// Head metadata for the Meta panel.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_meta(
    state: State<'_, AppState>,
    id: TabId,
) -> AppResult<crate::meta::MetaSnapshot> {
    let session = cdp_for(&state, id)?;
    crate::meta::snapshot(&session).await
}

/// Run axe-core (source supplied by the chrome) and return violations.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_a11y(
    state: State<'_, AppState>,
    id: TabId,
    axe_source: String,
) -> AppResult<crate::a11y::A11yReport> {
    let session = cdp_for(&state, id)?;
    crate::a11y::run(&session, &axe_source).await
}

/// Scroll to the first element matching `selector` and flash it.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_a11y_reveal(
    state: State<'_, AppState>,
    id: TabId,
    selector: String,
) -> AppResult<bool> {
    let session = cdp_for(&state, id)?;
    crate::a11y::reveal(&session, &selector).await
}

fn cdp_for(state: &AppState, id: TabId) -> AppResult<dive_cdp::CdpSession> {
    lock(&state.host)
        .as_ref()
        .and_then(|h| h.cdp(id))
        .ok_or_else(|| AppError::new("no devtools session for this tab"))
}

pub(crate) fn with_view(
    state: &AppState,
    id: TabId,
    f: impl FnOnce(&tauri::Webview<Runtime>) -> tauri::Result<()>,
) -> AppResult<()> {
    let host = lock(&state.host);
    host.as_ref()
        .ok_or_else(|| AppError::new("engine not ready"))?
        .with_view(id, f)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn layout_set_content_bounds(app: AppHandle<Runtime>, bounds: Bounds) -> AppResult<()> {
    // Native show/hide/move messages sent from a worker thread can overtake
    // the ones a main-thread command issues inline, so every visibility
    // change originates on the main thread.
    on_main(&app, move |_, _, state| {
        if let Some(host) = lock(&state.host).as_mut() {
            host.set_bounds(bounds)?;
        }
        Ok(())
    })
}

/// Freeze every page shown in the main window before a DOM overlay hides its
/// native child view. Unlike a user capture, these previews stay in memory and
/// never touch the captures folder or clipboard.
#[tauri::command]
#[specta::specta]
pub(crate) async fn layout_prepare_content_cover(
    webview: tauri::Webview<Runtime>,
    state: State<'_, AppState>,
) -> AppResult<Vec<ContentPreview>> {
    use base64::Engine as _;
    use futures_util::future::join_all;

    let sessions = lock(&state.host).as_ref().map_or_else(Vec::new, |host| {
        host.covered_sessions_for_chrome(webview.label())
    });
    let captures = join_all(sessions.into_iter().map(|(tab_id, session)| async move {
        let result = dive_cdp::page::capture_screenshot(
            &session,
            dive_cdp::page::ScreenshotOptions {
                format: dive_cdp::page::ImageFormat::Jpeg,
                quality: Some(82),
                ..Default::default()
            },
        )
        .await;
        (tab_id, result)
    }))
    .await;

    Ok(captures
        .into_iter()
        .filter_map(|(tab_id, result)| match result {
            Ok(bytes) => Some(ContentPreview {
                tab_id,
                data_url: format!(
                    "data:image/jpeg;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                ),
            }),
            Err(error) => {
                tracing::debug!(%tab_id, %error, "could not freeze page for chrome overlay");
                None
            }
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
/// Paint the window itself in the chrome's ground colour, so what shows
/// through a page view's rounded corners, or during a resize, is not black.
pub(crate) fn window_set_background(app: AppHandle<Runtime>, hex: String) -> AppResult<()> {
    use tauri::Manager as _;
    let digits = hex.trim().trim_start_matches('#');
    let parse = |i: usize| u8::from_str_radix(digits.get(i..i + 2).unwrap_or("zz"), 16);
    let (6, Ok(r), Ok(g), Ok(b)) = (digits.len(), parse(0), parse(2), parse(4)) else {
        return Err(AppError::new(format!("not a colour: {hex}")));
    };
    if let Some(window) = app.get_window(crate::MAIN_WINDOW) {
        window.set_background_color(Some(tauri::utils::config::Color(r, g, b, 0xFF)))?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
/// Round the corners of the page views to match the chrome's corner
/// preference; zero makes them square again.
pub(crate) fn layout_set_corner_radius(app: AppHandle<Runtime>, radius: f64) -> AppResult<()> {
    let radius = if radius.is_finite() {
        radius.clamp(0.0, 24.0)
    } else {
        0.0
    };
    on_main(&app, move |_, _, state| {
        if let Some(host) = lock(&state.host).as_mut() {
            host.set_corner_radius(radius);
        }
        Ok(())
    })
}

#[tauri::command]
#[specta::specta]
/// Hide the native content view while a DOM overlay (dialog, menu, popover)
/// is on screen, since child webviews always paint above the main webview.
pub(crate) fn layout_set_content_covered(
    app: AppHandle<Runtime>,
    webview: tauri::Webview<Runtime>,
    covered: bool,
) -> AppResult<()> {
    on_main(&app, move |_, _, state| {
        if let Some(host) = lock(&state.host).as_mut() {
            host.set_chrome_covered(webview.label(), covered)?;
        }
        Ok(())
    })
}

/// Regions belong to trusted chrome and use CSS logical pixels.
#[tauri::command]
#[specta::specta]
pub(crate) fn layout_set_overlay_regions(
    app: AppHandle<Runtime>,
    webview: tauri::Webview<Runtime>,
    regions: Vec<Bounds>,
    active: bool,
) -> AppResult<()> {
    if regions.len() > 64
        || regions.iter().any(|b| {
            [b.x, b.y, b.width, b.height].iter().any(|n| !n.is_finite())
                || b.width < 0.0
                || b.height < 0.0
        })
    {
        return Err(AppError::new("invalid overlay geometry"));
    }
    on_main(&app, move |_, _, state| {
        if let Some(host) = lock(&state.host).as_mut() {
            host.set_live_overlay(webview.label(), regions, active)?;
        }
        Ok(())
    })
}

/// Make sure `id` has a live view, recreating one if it was discarded. The
/// host and store guards are the caller's, in that lock order.
fn ensure_view(
    main: &MainThread,
    app: &AppHandle<Runtime>,
    state: &AppState,
    host: &mut crate::engine::TabHost,
    store: &dive_core::Store,
    id: TabId,
) -> AppResult<Tab> {
    let mut tab = store.tab(id)?;
    if !host.has(id) {
        let ws = tab
            .workspace_id
            .or(*lock(&state.active_workspace))
            .ok_or_else(|| AppError::new("tab has no workspace"))?;
        let container = store.container(store.workspace(ws)?.container_id)?;
        host.open(main, app, &tab, &container)?;
        crate::housekeeping::restore_scroll(app.clone(), id);
        if tab.state != dive_core::TabState::Active {
            tab.state = dive_core::TabState::Active;
            store.upsert_tab(&tab)?;
            state.bus.publish(CoreEvent::TabUpserted(tab.clone()));
        }
    }
    Ok(tab)
}

#[tauri::command]
#[specta::specta]
/// Show these tabs side by side at these rectangles; an empty list returns
/// to a single page. Sleeping tabs are woken so every pane has a page.
pub(crate) fn layout_set_panes(app: AppHandle<Runtime>, panes: Vec<PaneBounds>) -> AppResult<()> {
    on_main(&app, move |main, app, state| {
        let mut host = lock(&state.host);
        let Some(host) = host.as_mut() else {
            return Ok(());
        };
        {
            let store = lock(&state.store);
            for pane in &panes {
                ensure_view(main, app, state, host, &store, pane.tab)?;
            }
        }
        host.set_panes(panes)?;
        Ok(())
    })
}

#[tauri::command]
#[specta::specta]
/// Tear `id` off into its own window. `at` is where the pointer let go,
/// relative to the main window; `None` lets the system place the window.
pub(crate) fn tab_detach(
    app: AppHandle<Runtime>,
    id: TabId,
    at: Option<(f64, f64)>,
) -> AppResult<()> {
    on_main(&app, move |main, app, state| {
        detach_tab(main, app, state, id, at)
    })
}

fn detach_tab(
    main: &MainThread,
    app: &AppHandle<Runtime>,
    state: &AppState,
    id: TabId,
    at: Option<(f64, f64)>,
) -> AppResult<()> {
    let (was_active, workspace) = {
        let mut host = lock(&state.host);
        let host = host
            .as_mut()
            .ok_or_else(|| AppError::new("engine not ready"))?;
        let store = lock(&state.store);
        let tab = ensure_view(main, app, state, host, &store, id)?;
        let was_active = host.active() == Some(id);
        host.detach(app, id, &tab.title, at)?;
        (
            was_active,
            tab.workspace_id.or(*lock(&state.active_workspace)),
        )
    };
    let _ = TabWindowChanged {
        tab: id,
        detached: true,
    }
    .emit(app);
    // The main window needs a page again; pick the workspace's most recent
    // tab that is still in it.
    if was_active && let Some(ws) = workspace {
        let next = {
            let host = lock(&state.host);
            let store = lock(&state.store);
            let mut tabs = store.tabs_for_workspace(ws)?;
            tabs.retain(|t| t.id != id && !host.as_ref().is_some_and(|h| h.is_detached(t.id)));
            tabs.into_iter()
                .max_by_key(|t| t.last_active_at)
                .map(|t| t.id)
        };
        // With nothing left the chrome shows its welcome page; it learns
        // that from the detach event itself.
        if let Some(next) = next {
            activate_tab(main, app, state, next)?;
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
/// Bring `id` back from its own window and show it in the main one.
pub(crate) fn tab_attach(app: AppHandle<Runtime>, id: TabId) -> AppResult<()> {
    on_main(&app, move |main, app, state| {
        let workspace = {
            let mut host = lock(&state.host);
            let host = host
                .as_mut()
                .ok_or_else(|| AppError::new("engine not ready"))?;
            let store = lock(&state.store);
            let tab = store.tab(id)?;
            host.attach(id)?;
            let workspace =
                persist_reattach_workspace(&store, &tab, *lock(&state.active_workspace))?;
            if workspace.is_some() {
                host.deactivate_all()?;
            }
            workspace
        };
        if let Some((workspace, tabs)) = workspace {
            *lock(&state.active_workspace) = Some(workspace);
            state.bus.publish(CoreEvent::WorkspaceActivated(workspace));
            for tab in tabs {
                state.bus.publish(CoreEvent::TabUpserted(tab));
            }
        }
        let _ = TabWindowChanged {
            tab: id,
            detached: false,
        }
        .emit(app);
        activate_tab(main, app, state, id)
    })
}

/// Reattachment selects the owning workspace without moving the page. Global
/// essentials remain visible in the current workspace and do not select one.
fn persist_reattach_workspace(
    store: &dive_core::Store,
    tab: &Tab,
    active: Option<WorkspaceId>,
) -> AppResult<Option<(WorkspaceId, Vec<Tab>)>> {
    if tab.tier == dive_core::TabTier::Essential {
        return Ok(None);
    }
    let Some(id) = tab.workspace_id.filter(|id| Some(*id) != active) else {
        return Ok(None);
    };
    let workspace = store.workspace(id)?;
    let tabs = store.tabs_for_workspace(id)?;
    store.set_setting(crate::state::ACTIVE_WORKSPACE, &id.to_string())?;
    store.set_setting(
        &profile_workspace_key(workspace.profile_id),
        &id.to_string(),
    )?;
    Ok(Some((id, tabs)))
}

#[tauri::command]
#[specta::specta]
/// The chrome of a popout window reports where its page sits.
pub(crate) fn popout_set_bounds(
    app: AppHandle<Runtime>,
    id: TabId,
    bounds: Bounds,
) -> AppResult<()> {
    on_main(&app, move |_, _, state| {
        if let Some(host) = lock(&state.host).as_mut() {
            host.set_popout_bounds(id, bounds)?;
        }
        Ok(())
    })
}

#[tauri::command]
#[specta::specta]
pub(crate) fn commands_list(state: State<'_, AppState>) -> Vec<Command> {
    state.commands.list()
}

#[tauri::command]
#[specta::specta]
/// Run a registry command. `args_json` and the result are JSON text because
/// tauri-specta cannot export `serde_json::Value` in a function signature.
pub(crate) fn command_run(
    state: State<'_, AppState>,
    id: String,
    args_json: Option<String>,
) -> AppResult<String> {
    let args = match args_json {
        Some(text) => serde_json::from_str(&text).map_err(AppError::new)?,
        None => Value::Null,
    };
    let out = state.commands.run(&id, args)?;
    serde_json::to_string(&out).map_err(AppError::new)
}

/// Turn what the user typed into a navigable URL: bare hosts get `https://`,
/// anything with spaces or no dot becomes a search.
#[cfg(test)]
fn normalize_url(input: &str) -> AppResult<url::Url> {
    normalize_url_with(input, crate::prefs::ENGINES[0].1)
}

/// Normalize user input, using `template` for anything that is not a URL.
/// The template is a URL carrying a `{query}` placeholder.
pub fn normalize_url_with(input: &str, template: &str) -> AppResult<url::Url> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AppError::new("empty url"));
    }
    if let Ok(url) = url::Url::parse(trimmed)
        && matches!(
            url.scheme(),
            "http"
                | "https"
                | "file"
                | "about"
                | "data"
                | "blob"
                | "view-source"
                | crate::engine::INTERNAL_SCHEME
        )
    {
        return Ok(url);
    }
    let looks_like_host = !trimmed.contains(' ')
        && (trimmed.contains('.')
            || trimmed.starts_with("localhost")
            || trimmed.starts_with("127."));
    if looks_like_host {
        let host = trimmed.split_once(':').map_or(trimmed, |(host, _)| host);
        let local = trimmed.starts_with("localhost")
            || trimmed.starts_with("127.")
            || trimmed.starts_with("[::1]")
            || trimmed.starts_with("0.0.0.0")
            || host
                .rsplit_once('.')
                .is_some_and(|(_, suffix)| suffix.eq_ignore_ascii_case("local"));
        let scheme = if local { "http" } else { "https" };
        return url::Url::parse(&format!("{scheme}://{trimmed}")).map_err(Into::into);
    }
    let query: String = url::form_urlencoded::byte_serialize(trimmed.as_bytes()).collect();
    url::Url::parse(&template.replace("{query}", &query)).map_err(Into::into)
}

#[cfg(test)]
mod tests {
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

    use super::*;

    #[test]
    fn reattachment_selects_owner_and_remembers_profile_without_moving_tabs() {
        let store = dive_core::Store::in_memory().unwrap();
        let profile = store.ensure_default_profile().unwrap();
        let owner = Workspace::new("Home", profile.container_id, profile.id, 0);
        let other_profile = dive_core::Profile::new("Other profile", profile.container_id, 1);
        store.upsert_profile(&other_profile).unwrap();
        let other = Workspace::new("Other", profile.container_id, other_profile.id, 1);
        store.upsert_workspace(&owner).unwrap();
        store.upsert_workspace(&other).unwrap();
        let tab = Tab::new(owner.id, "https://owner.test", 0);
        store.upsert_tab(&tab).unwrap();
        let sibling = Tab::new(owner.id, "https://sibling.test", 1);
        store.upsert_tab(&sibling).unwrap();
        let foreign = Tab::new(other.id, "https://foreign.test", 0);
        store.upsert_tab(&foreign).unwrap();
        let mut global = Tab::new(owner.id, "https://global.test", 0);
        global.tier = dive_core::TabTier::Essential;
        global.workspace_id = None;
        store.upsert_tab(&global).unwrap();
        store
            .set_setting(crate::state::ACTIVE_WORKSPACE, &other.id.to_string())
            .unwrap();
        store
            .set_setting(
                &profile_workspace_key(other_profile.id),
                &other.id.to_string(),
            )
            .unwrap();
        assert_eq!(
            persist_reattach_workspace(&store, &tab, Some(other.id)).unwrap(),
            Some((owner.id, vec![global, tab.clone(), sibling]))
        );
        assert_eq!(
            store.setting(crate::state::ACTIVE_WORKSPACE).unwrap(),
            Some(owner.id.to_string())
        );
        assert_eq!(
            store.setting(&profile_workspace_key(profile.id)).unwrap(),
            Some(owner.id.to_string())
        );
        assert_eq!(store.tab(tab.id).unwrap(), tab);
        assert_eq!(store.workspace(owner.id).unwrap(), owner);
        assert_eq!(store.workspace(other.id).unwrap(), other);
        assert_eq!(
            store
                .setting(&profile_workspace_key(other_profile.id))
                .unwrap(),
            Some(other.id.to_string())
        );
        assert_eq!(
            persist_reattach_workspace(&store, &tab, Some(owner.id)).unwrap(),
            None
        );

        let mut essential = tab.clone();
        essential.tier = dive_core::TabTier::Essential;
        assert_eq!(
            persist_reattach_workspace(&store, &essential, Some(other.id)).unwrap(),
            None
        );
        essential.workspace_id = None;
        store
            .set_setting(crate::state::ACTIVE_WORKSPACE, &other.id.to_string())
            .unwrap();
        assert_eq!(
            persist_reattach_workspace(&store, &essential, Some(other.id)).unwrap(),
            None
        );
        assert_eq!(
            store.setting(crate::state::ACTIVE_WORKSPACE).unwrap(),
            Some(other.id.to_string())
        );
    }

    #[test]
    fn updater_calls_are_skipped_when_the_plugin_was_not_built() {
        assert!(!updater_configured(None));
        assert!(!updater_configured(Some("")));
        assert!(!updater_configured(Some("   ")));
        assert!(updater_configured(Some("release-public-key")));
    }

    #[test]
    fn normalizes_user_input() {
        assert_eq!(
            normalize_url("https://a.dev/x").unwrap().as_str(),
            "https://a.dev/x"
        );
        assert_eq!(
            normalize_url("example.com").unwrap().as_str(),
            "https://example.com/"
        );
        assert_eq!(
            normalize_url("localhost:5173").unwrap().as_str(),
            "http://localhost:5173/"
        );
        assert!(
            normalize_url("how to center a div")
                .unwrap()
                .as_str()
                .starts_with("https://duckduckgo.com/?q=")
        );
        assert!(normalize_url("   ").is_err());
    }

    #[test]
    fn validates_workspace_fields() {
        assert_eq!(clean_color(" #abc ").unwrap(), "#ABC");
        assert!(clean_color("red").is_err());
        assert!(clean_color("#12345").is_err());
        assert_eq!(clean_name("  Work ").unwrap(), "Work");
        assert!(clean_name("   ").is_err());
        assert_eq!(clean_icon(" Book-Open ").unwrap(), "book-open");
        assert_eq!(clean_icon("  ").unwrap(), Workspace::default_icon());
        assert!(clean_icon("<img onerror=x>").is_err());
        assert!(clean_icon(&"a".repeat(33)).is_err());
    }

    #[test]
    fn privacy_reload_is_reserved_for_site_pause_transitions() {
        let previous = crate::prefs::Prefs {
            block_trackers: true,
            ..crate::prefs::Prefs::default()
        };
        let mut youtube_changed = previous.clone();
        youtube_changed.youtube_protection = false;
        assert!(!privacy_site_state_changed(
            &previous,
            &youtube_changed,
            "https://www.youtube.com/watch?v=abc",
        ));

        let mut paused = previous.clone();
        paused.privacy_exceptions = vec!["www.youtube.com".into()];
        assert!(privacy_site_state_changed(
            &previous,
            &paused,
            "https://www.youtube.com/watch?v=abc",
        ));
        assert!(!privacy_site_state_changed(
            &previous,
            &paused,
            "https://example.com/",
        ));

        let globally_off = crate::prefs::Prefs::default();
        let mut off_with_removed_exception = globally_off.clone();
        off_with_removed_exception.privacy_exceptions = vec!["www.youtube.com".into()];
        assert!(
            !privacy_site_state_changed(
                &off_with_removed_exception,
                &globally_off,
                "https://www.youtube.com/watch?v=abc",
            ),
            "changing an inert exception must not reload while global protection is off",
        );
    }

    #[derive(Clone)]
    struct AckTransport {
        sent: std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
        session: std::sync::Arc<std::sync::Mutex<Option<dive_cdp::CdpSession>>>,
    }

    impl dive_cdp::Transport for AckTransport {
        fn send(&self, message: &str) -> Result<(), dive_cdp::CdpError> {
            let message: Value = serde_json::from_str(message).expect("outgoing CDP JSON");
            let id = message["id"].as_u64().expect("CDP call id");
            self.sent
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(message);
            self.session
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_ref()
                .expect("session installed")
                .handle_incoming(&serde_json::json!({"id": id, "result": {}}).to_string())?;
            Ok(())
        }
    }

    fn acknowledged_session() -> (
        dive_cdp::CdpSession,
        std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
    ) {
        let sent = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let holder = std::sync::Arc::new(std::sync::Mutex::new(None));
        let session = dive_cdp::CdpSession::new(AckTransport {
            sent: std::sync::Arc::clone(&sent),
            session: std::sync::Arc::clone(&holder),
        });
        *holder
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(session.clone());
        (session, sent)
    }

    #[tokio::test]
    async fn interception_reapply_prunes_a_dead_first_session_and_updates_the_next() {
        let dead_id = TabId::new();
        let live_id = TabId::new();
        let (dead, _) = acknowledged_session();
        dead.close();
        let (live, sent) = acknowledged_session();
        let prefs = crate::prefs::Prefs {
            block_trackers: true,
            ..crate::prefs::Prefs::default()
        };

        let summary = apply_interception_targets(
            vec![(dead_id, Vec::new(), dead), (live_id, Vec::new(), live)],
            &prefs,
        )
        .await;

        assert_eq!(summary.dead, vec![dead_id]);
        assert!(summary.failed.is_empty());
        let sent = sent
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["method"], "Fetch.enable");
    }

    #[test]
    fn export_bindings() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/generated/bindings.ts");
        specta_builder()
            .export(
                specta_typescript::Typescript::default()
                    .header("// @ts-nocheck\n/* eslint-disable */"),
                path,
            )
            .expect("export bindings");
        // Specta currently leaves spaces after multiline union separators.
        // Keep generated output deterministic and friendly to `git diff --check`.
        let generated = std::fs::read_to_string(path).expect("read generated bindings");
        let generated = generated
            .lines()
            .map(str::trim_end)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        std::fs::write(path, generated).expect("normalize generated bindings");
        assert!(std::path::Path::new(path).exists());
    }
}
