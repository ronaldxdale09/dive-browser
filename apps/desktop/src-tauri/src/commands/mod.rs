//! IPC surface. Every function here is a Tauri command exported to
//! TypeScript by tauri-specta, plus the events the chrome subscribes to.

// Tauri commands receive their arguments by value; that is the IPC contract.
#![allow(clippy::needless_pass_by_value)]

use dive_core::{CoreEvent, Tab, TabId, Workspace, WorkspaceId};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;
use tauri_specta::{Event, collect_commands, collect_events};

use crate::Runtime;
use crate::engine::MainThread;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

mod app;
mod backup;
mod capture;
mod dev_servers;
mod devtools;
mod downloads;
mod library;
mod page;
mod palette;
mod passwords;
mod prefs_commands;
mod prompts;
mod recording;
mod subtitles;
mod tabs;
mod windows;
mod workspaces;

pub use app::UpdateInfo;
pub(crate) use app::updater_configured;
pub use capture::capture_tab;
use capture::stamped_capture;
pub(crate) use capture::{capture_stem, captures_dir};
pub(crate) use devtools::{reapply_interception, reapply_rules};
pub use palette::register_builtin;
pub(crate) use prefs_commands::prefs_set;
pub use tabs::{activate_tab, close_tab, open_tab, open_tab_with};
pub(crate) use tabs::{
    focus_page, page_agreed_to_close, rebuild_failed_protocol, request_tab_close, tab_activate,
    tab_back, tab_close, tab_forward, tab_navigate,
};
pub(crate) use windows::detach_tab;
pub(crate) use windows::{
    tab_attach, tab_detach, window_exit_private, window_open, window_open_local, window_private,
};
pub use workspaces::WorkspaceDraft;
pub(crate) use workspaces::{
    active_profile, forget_tab_state, workspace_activate, workspace_create, workspace_delete,
};
use workspaces::{profile_workspace_key, workspace_tab_key, workspace_tab_to_show};

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
    /// MCP endpoint, empty when the server is off, could not start, or this
    /// window is private. Always the address the server really bound.
    pub mcp_url: String,
    /// Why the MCP server is not running when it was meant to be, such as
    /// its port being taken by another program.
    #[specta(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_error: Option<String>,
    /// Path of the bearer token file.
    pub mcp_token_path: String,
    /// Device preset to put the first tab on at startup, from `DIVE_SIMULATE`.
    /// Lets automation and smoke tests bring the simulator up without a
    /// click, the way `DIVE_OPEN_URL` opens a tab.
    pub simulate: Option<String>,
    /// Whether this binary registered the updater. A release-channel label
    /// without a pubkey still cannot check; About must not say we are current.
    pub updater: bool,
}

/// Build the specta command/event collection.
#[allow(clippy::too_many_lines)] // The command list is the registry; one place to read it.
pub fn specta_builder() -> tauri_specta::Builder<Runtime> {
    tauri_specta::Builder::<Runtime>::new()
        .commands(collect_commands![
            crate::activity::keep_sites_list,
            crate::activity::keep_site_set,
            windows::snapshot,
            windows::tab_info,
            windows::window_command,
            windows::window_open,
            windows::window_private,
            windows::window_exit_private,
            windows::window_close,
            windows::popout_ready,
            crate::webapp::webapp_probe,
            crate::webapp::webapp_install,
            crate::webapp::webapps_list,
            crate::webapp::webapp_open,
            crate::webapp::webapp_uninstall,
            crate::webapp::webapp_for_tab,
            crate::webapp::webapp_for_window,
            crate::webapp::webapp_icon,
            crate::stack::tab_stack,
            crate::color::tab_palette,
            crate::color::tab_eyedropper,
            workspaces::workspace_activate,
            workspaces::profiles_list,
            workspaces::profile_create,
            workspaces::profile_update,
            workspaces::profile_activate,
            workspaces::profile_delete,
            workspaces::workspace_create,
            workspaces::workspace_update,
            workspaces::workspace_delete,
            workspaces::workspace_reorder,
            workspaces::workspace_tab_counts,
            workspaces::workspace_other_tabs,
            tabs::tab_open,
            tabs::tab_close,
            tabs::tab_activate,
            tabs::tab_deactivate,
            app::ui_state_load,
            app::ui_state_set,
            app::browser_import_sources,
            app::browser_import_run,
            app::browser_import_open_privacy,
            tabs::tab_navigate,
            tabs::tab_reorder,
            tabs::tab_set_pinned,
            tabs::tab_back,
            tabs::tab_forward,
            crate::navigation::tab_history,
            crate::navigation::tab_history_navigate,
            tabs::tab_reload,
            tabs::tab_reload_hard,
            tabs::tab_zoom,
            tabs::tab_stop,
            tabs::tab_print,
            tabs::tab_fill_video,
            tabs::tab_set_tier,
            tabs::tab_move_to_workspace,
            library::bookmark_remove,
            passwords::passwords_list,
            passwords::passwords_for_url,
            passwords::passwords_save,
            passwords::passwords_reveal,
            passwords::passwords_copy,
            passwords::passwords_edit,
            passwords::passwords_export,
            passwords::passwords_delete,
            passwords::passwords_used,
            passwords::addresses_list,
            passwords::address_save,
            passwords::address_delete,
            passwords::address_fill,
            passwords::cards_list,
            passwords::card_save,
            passwords::card_delete,
            passwords::card_fill,
            backup::backup_export,
            backup::backup_restore,
            page::page_reader,
            page::page_reader_leave,
            page::page_reader_open,
            page::page_translate,
            page::page_translate_restore,
            page::page_translate_state,
            page::tasks_list,
            page::page_save,
            page::search_suggest,
            page::tab_set_muted,
            page::tab_audio_state,
            page::external_link_open,
            page::external_link_dismiss,
            passwords::passwords_answer,
            passwords::passwords_fill,
            passwords::passwords_never,
            passwords::passwords_never_list,
            passwords::passwords_never_remove,
            passwords::passwords_pick_csv,
            passwords::passwords_import_csv,
            passwords::forms_list,
            passwords::forms_delete,
            passwords::forms_clear,
            library::bookmark_rename,
            library::bookmark_restore,
            prompts::permission_set,
            prompts::permission_reply,
            prompts::js_dialog_pending,
            prompts::js_dialog_answer,
            prompts::http_auth_pending,
            prompts::http_auth_answer,
            prompts::permissions_list,
            crate::extensions::extensions_list,
            crate::extensions::extension_pick,
            crate::extensions::extension_import,
            crate::extensions::extension_set_enabled,
            crate::extensions::extension_remove,
            crate::extensions::app_restart,
            crate::updater::update_check,
            crate::updater::update_install,
            crate::updater::update_cancel,
            crate::recovery::session_recovery_status,
            crate::recovery::session_recovery_resolve,
            crate::diagnostics::diagnostics_export,
            crate::diagnostics::diagnostics_reveal_logs,
            app::default_browser_status,
            app::default_browser_set,
            subtitles::subtitle_models,
            subtitles::subtitle_model_download,
            subtitles::subtitle_model_cancel,
            subtitles::subtitle_model_delete,
            subtitles::subtitle_start,
            subtitles::subtitle_stop,
            subtitles::subtitle_running,
            tabs::tab_devtools,
            recording::tab_screencast_start,
            recording::tab_screencast_pause,
            recording::tab_screencast_stop,
            recording::tab_screencast_cancel,
            recording::recording_capabilities,
            recording::recording_read,
            recording::recording_open,
            recording::recording_delete,
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
            capture::tab_capture,
            capture::tab_capture_png,
            capture::capture_read,
            capture::capture_save,
            capture::clipboard_write_png,
            devtools::tab_emulate,
            devtools::tab_environment,
            devtools::device_presets,
            devtools::tab_media,
            devtools::tab_throttle,
            devtools::rules_list,
            devtools::rules_set,
            devtools::tab_storage,
            devtools::tab_meta,
            devtools::tab_a11y,
            devtools::tab_a11y_reveal,
            devtools::tab_find,
            devtools::tab_vitals,
            devtools::resolve_frame,
            devtools::request_captured,
            devtools::request_detail,
            devtools::request_replay,
            devtools::tab_openapi,
            devtools::tab_har,
            devtools::tab_console_clear,
            devtools::tab_network_clear,
            devtools::tab_storage_value,
            devtools::tab_bug_report,
            dev_servers::tab_inspect_start,
            dev_servers::tab_inspect_cancel,
            dev_servers::tab_inspect_state,
            dev_servers::tab_inspect_style,
            dev_servers::tab_inspect_revert,
            devtools::tab_record_start,
            devtools::tab_record_stop,
            windows::layout_set_content_bounds,
            windows::layout_prepare_content_cover,
            windows::layout_set_content_covered,
            windows::chrome_ready,
            windows::log_chrome_error,
            prompts::tab_unresponsive_answer,
            prompts::cert_error_answer,
            prompts::cert_error_pending,
            windows::layout_set_corner_radius,
            windows::window_set_background,
            windows::layout_set_overlay_regions,
            windows::layout_set_panes,
            windows::tab_detach,
            windows::tab_attach,
            windows::popout_set_bounds,
            palette::commands_list,
            palette::command_run,
            app::app_info,
            crate::privacy::privacy_info,
            prefs_commands::prefs_get,
            prefs_commands::prefs_set,
            prefs_commands::pages_scheme,
            capture::clipboard_write_text,
            capture::clipboard_write_secret,
            tabs::tab_scroll_position,
            tabs::tab_restore_scroll,
            prefs_commands::browsing_data_clear,
            downloads::downloads_reveal,
            downloads::downloads_open,
            downloads::downloads_cancel,
            downloads::downloads_resume,
            downloads::downloads_clear,
            tabs::tab_focus,
            app::mcp_token,
            devtools::tab_storage_delete,
            dev_servers::dev_servers,
            dev_servers::dev_servers_watch,
            library::history_search,
            prefs_commands::history_prune_count,
            prefs_commands::network_restart_needed,
            downloads::download_dir_pick,
            downloads::downloads_history,
            downloads::download_forget,
            downloads::downloads_history_clear,
            downloads::downloads_missing,
            downloads::download_start,
            library::history_remove,
            library::bookmark_toggle,
            library::bookmark_status,
            library::bookmarks_search,
            dev_servers::share_url,
            library::favicons_for,
            library::favicon_get,
            crate::agent::agent_providers,
            crate::agent::agent_keys,
            crate::agent::agent_key_set,
            crate::agent::agent_key_present,
            crate::agent::agent_key_verify,
            crate::agent::agent_models,
            crate::agent::agent_send,
            crate::agent::agent_approve,
            crate::agent::agent_stop,
            tabs::tab_picture_in_picture,
            prefs_commands::https_only_upgraded,
            prefs_commands::https_only_allow,
            crate::agent::agent_thread_load,
            crate::agent::agent_thread_save,
            crate::agent::agent_thread_clear,
        ])
        .events(collect_events![
            crate::agent_presence::AgentPresence,
            crate::crash::TabCrashed,
            crate::crash::TabUnresponsive,
            crate::crash::TabResponsive,
            crate::cert_error::CertErrorAsked,
            crate::cert_error::CertErrorClosed,
            crate::devservers::DevServersChanged,
            crate::rules::RulesChanged,
            crate::inspect::InspectEvent,
            crate::recorder::RecorderEvent,
            crate::screencast::RecordingEvent,
            crate::menu::MenuCommand,
            StateChanged,
            TabWindowChanged,
            crate::console::ConsoleBatch,
            crate::network::NetworkEventBatch,
            crate::engine::DownloadNotice,
            crate::loading::TabLoad,
            crate::navigation::TabHistoryChanged,
            crate::permissions::PermissionAsked,
            crate::credential_fill::CredentialPrompt,
            crate::external_link::ExternalLinkAsked,
            crate::external_link::ExternalLinkClosed,
            crate::tab_audio::TabAudio,
            crate::permissions::PermissionDismissed,
            crate::js_dialog::JsDialogAsked,
            crate::http_auth::HttpAuthAsked,
            crate::http_auth::HttpAuthClosed,
            crate::js_dialog::JsDialogClosed,
            crate::privacy::PrivacyEvent,
            crate::subtitles::SubtitleModelProgress,
            crate::subtitles::SubtitleCue,
            crate::subtitles::SubtitleState,
            crate::emulate::DeviceEmulated,
            crate::engine::DownloadProgress,
            crate::updater::UpdateProgress,
            crate::engine::TabZoom,
            crate::prefs::PrefsChanged,
        ])
}

/// Emit a core event to the chrome.
pub fn emit_state_changed(app: &AppHandle<Runtime>, event: CoreEvent) -> tauri::Result<()> {
    StateChanged(event).emit(app)
}

/// Run `f` on the main thread and wait for its result.
///
/// Under the CEF runtime Tauri hands every IPC command to a worker thread,
/// and native views may only be created, shown or moved from the main
/// thread, so engine-facing commands hop there. Call this before taking any
/// lock the closure will need, or the hop waits on itself.
pub(crate) fn on_main<T: Send + 'static>(
    app: &AppHandle<Runtime>,
    f: impl FnOnce(&MainThread, &AppHandle<Runtime>, &AppState) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    use tauri::Manager;
    if let Some(main) = MainThread::here() {
        let state = app.state::<AppState>();
        return f(&main, app, &state);
    }
    match crate::main_hop::blocking(app, crate::main_hop::BUDGET, move |handle| {
        match MainThread::here() {
            Some(main) => {
                let state = handle.state::<AppState>();
                f(&main, handle, &state)
            }
            None => Err(AppError::new("main-thread hop landed on another thread")),
        }
    }) {
        Ok(result) => result,
        Err(crate::main_hop::HopError::Queue(e)) => Err(AppError::new(e)),
        Err(crate::main_hop::HopError::TimedOut(budget)) => Err(AppError::new(format!(
            "the main thread did not answer within {}s",
            budget.as_secs()
        ))),
        Err(crate::main_hop::HopError::Dropped) => {
            Err(AppError::new("the main thread dropped the command"))
        }
    }
}

pub(crate) fn cdp_for(state: &AppState, id: TabId) -> AppResult<dive_cdp::CdpSession> {
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

/// Turn what the user typed into a navigable URL: bare hosts get `https://`,
/// anything with spaces or no dot becomes a search.
#[cfg(test)]
fn normalize_url(input: &str) -> AppResult<url::Url> {
    normalize_url_with(input, crate::prefs::ENGINES[0].1)
}

/// Normalize user input, using `template` for anything that is not a URL.
/// The template is a URL carrying a `{query}` placeholder. What counts as a
/// URL is `omnibox::classify`'s call, shared with the chrome's labels.
pub fn normalize_url_with(input: &str, template: &str) -> AppResult<url::Url> {
    match crate::omnibox::classify(input) {
        None => Err(AppError::new("empty url")),
        Some(crate::omnibox::Typed::Address(url)) => Ok(url),
        Some(crate::omnibox::Typed::Search(words)) => {
            let query: String = url::form_urlencoded::byte_serialize(words.as_bytes()).collect();
            url::Url::parse(&template.replace("{query}", &query)).map_err(Into::into)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
