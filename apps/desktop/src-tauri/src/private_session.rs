//! Private browsing is a separate process with an in-memory application store
//! and a CEF off-the-record context. The normal profile never receives its events.
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::AppHandle;

use crate::Runtime;
use crate::error::{AppError, AppResult};

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static ROOT: OnceLock<PathBuf> = OnceLock::new();
/// Kept alive for the life of the process so the directory is not removed out
/// from under the session; `cleanup` deletes it explicitly on the way out.
static TEMP_ROOT: OnceLock<tempfile::TempDir> = OnceLock::new();
struct Session {
    input: ChildStdin,
    alive: Arc<AtomicBool>,
    replies: std::sync::mpsc::Receiver<(String, bool)>,
}

pub fn is_private() -> bool {
    std::env::var_os("DIVE_PRIVATE_SESSION").is_some_and(|value| value == "1")
}

/// Never accept `DIVE_DATA_DIR` as a private root: accidentally pointing it at a
/// real profile must neither read that profile nor delete it on shutdown.
pub fn data_root() -> PathBuf {
    ROOT.get_or_init(|| {
        let built = tempfile::Builder::new()
            .prefix(&format!(
                "dive-private-{}-",
                std::env::var("DIVE_PRIVATE_LAUNCH_TOKEN").unwrap_or_default()
            ))
            .tempdir();
        let root = match built {
            Ok(dir) => {
                let path = dir.path().to_owned();
                let _ = TEMP_ROOT.set(dir);
                path
            }
            // A full or unwritable temp directory used to abort the process
            // here, before any window existed, because this runs while the app
            // is still being built. A private window with a less exotic
            // location is a better answer than no browser at all.
            Err(e) => {
                tracing::warn!(
                    "no temporary directory for the private session ({e}); using the data root"
                );
                let path = crate::state::default_data_root()
                    .join(format!("private-{}", std::process::id()));
                if let Err(e) = std::fs::create_dir_all(&path) {
                    tracing::warn!("could not create {}: {e}", path.display());
                }
                path
            }
        };
        hold_session_lock(&root);
        root
    })
    .clone()
}

/// The lock a private session holds on its folder while it runs.
const SESSION_LOCK: &str = "session.lock";

/// Held for the life of the process: the lock is released only when the
/// process ends, however it ends, which is what tells a later sweep that
/// the folder is no longer anyone's.
static SESSION_LOCK_FILE: OnceLock<std::fs::File> = OnceLock::new();

fn hold_session_lock(root: &std::path::Path) {
    let held = std::fs::File::create(root.join(SESSION_LOCK)).and_then(|file| {
        file.try_lock().map_err(std::io::Error::other)?;
        Ok(file)
    });
    match held {
        Ok(file) => {
            let _ = SESSION_LOCK_FILE.set(file);
        }
        Err(e) => tracing::warn!("could not lock the private session folder: {e}"),
    }
}

/// Whether a leftover private folder can go: nobody holds its lock, or, for
/// a folder from before the lock existed, it has not changed for a day.
fn abandoned(dir: &std::path::Path) -> bool {
    let lock = dir.join(SESSION_LOCK);
    if lock.exists() {
        return std::fs::File::open(&lock).is_ok_and(|file| file.try_lock().is_ok());
    }
    std::fs::metadata(dir)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|at| at.elapsed().ok())
        .is_some_and(|age| age > std::time::Duration::from_hours(24))
}

/// Remove private-session folders left behind by sessions that crashed.
///
/// A private session deletes its folder on the way out, and the normal
/// process deletes it when the child dies while it watches. A crash of both,
/// or a force quit, left the folder -- cookies and cache of a session that
/// was meant to leave nothing -- in the temporary directory for good. The
/// normal process sweeps them at startup, skipping any a live session holds.
pub fn sweep_stale() {
    if is_private() {
        return;
    }
    let places = [
        (std::env::temp_dir(), "dive-private-"),
        (crate::state::default_data_root(), "private-"),
    ];
    std::thread::spawn(move || {
        for (dir, prefix) in places {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let is_dir = entry
                    .file_type()
                    .is_ok_and(|t| t.is_dir() && !t.is_symlink());
                if !is_dir || !entry.file_name().to_string_lossy().starts_with(prefix) {
                    continue;
                }
                let path = entry.path();
                if abandoned(&path) {
                    match std::fs::remove_dir_all(&path) {
                        Ok(()) => {
                            tracing::info!(path = %path.display(), "removed a stale private session folder");
                        }
                        Err(e) => {
                            tracing::warn!(path = %path.display(), "could not remove a stale private session folder: {e}");
                        }
                    }
                }
            }
        }
    });
}

pub fn cleanup() {
    if let Some(root) = ROOT.get() {
        let _ = std::fs::remove_dir_all(root);
    }
}

/// Commands a private window may run. Everything else is refused before
/// dispatch, so a command added later stays off in Private Mode until
/// someone decides otherwise (the test below makes them decide).
const PRIVATE_ALLOWED: &[&str] = &[
    "address_delete",
    "address_fill",
    "address_save",
    "addresses_list",
    "backup_export",
    "backup_restore",
    "bookmark_restore",
    "bookmark_status",
    "bookmarks_search",
    "browser_import_open_privacy",
    "browser_import_run",
    "browser_import_sources",
    "browsing_data_clear",
    "capture_read",
    "capture_save",
    "card_delete",
    "card_fill",
    "card_save",
    "cards_list",
    "cert_error_answer",
    "chrome_ready",
    "clipboard_write_png",
    "clipboard_write_secret",
    "clipboard_write_text",
    "command_run",
    "dev_servers",
    "dev_servers_watch",
    "diagnostics_export",
    "diagnostics_reveal_logs",
    "download_dir_pick",
    "download_forget",
    "download_start",
    "downloads_cancel",
    "downloads_clear",
    "downloads_history",
    "downloads_history_clear",
    "downloads_missing",
    "downloads_open",
    "downloads_resume",
    "downloads_reveal",
    "external_link_open",
    "favicon_get",
    "file_read_chunk",
    "file_size",
    "forms_clear",
    "forms_delete",
    "forms_list",
    "history_prune_count",
    "history_remove",
    "history_search",
    "http_auth_answer",
    "http_auth_pending",
    "https_only_allow",
    "js_dialog_answer",
    "js_dialog_pending",
    "keep_site_set",
    "keep_sites_list",
    "layout_prepare_content_cover",
    "layout_set_content_bounds",
    "layout_set_content_covered",
    "layout_set_corner_radius",
    "layout_set_overlay_regions",
    "layout_set_panes",
    "mcp_token",
    "page_reader",
    "page_reader_leave",
    "page_reader_open",
    "page_save",
    "page_translate",
    "page_translate_restore",
    "page_translate_state",
    "pages_scheme",
    "passwords_answer",
    "passwords_copy",
    "passwords_delete",
    "passwords_edit",
    "passwords_export",
    "passwords_fill",
    "passwords_for_url",
    "passwords_import_csv",
    "passwords_list",
    "passwords_never",
    "passwords_never_list",
    "passwords_never_remove",
    "passwords_reveal",
    "passwords_save",
    "passwords_used",
    "permission_reply",
    "permission_set",
    "permissions_list",
    "popout_ready",
    "popout_set_bounds",
    "prefs_set",
    "profiles_list",
    "recording_capabilities",
    "recording_delete",
    "recording_open",
    "recording_read",
    "recordings_list",
    "report_startup_milestone",
    "request_captured",
    "request_detail",
    "request_replay",
    "resolve_frame",
    "rules_set",
    "screen_export_append",
    "screen_export_begin",
    "screen_export_cancel",
    "screen_export_finish",
    "screen_import_path",
    "screen_import_video",
    "screen_media_info",
    "screen_project_read",
    "screen_project_write",
    "search_suggest",
    "session_recovery_resolve",
    "share_url",
    "snapshot",
    "subtitle_start",
    "tab_a11y",
    "tab_a11y_reveal",
    "tab_activate",
    "tab_attach",
    "tab_back",
    "tab_bug_report",
    "tab_capture",
    "tab_capture_png",
    "tab_close",
    "tab_deactivate",
    "tab_detach",
    "tab_devtools",
    "tab_emulate",
    "tab_environment",
    "tab_eyedropper",
    "tab_fill_video",
    "tab_find",
    "tab_focus",
    "tab_forward",
    "tab_har",
    "tab_history",
    "tab_history_navigate",
    "tab_info",
    "tab_inspect_cancel",
    "tab_inspect_revert",
    "tab_inspect_start",
    "tab_inspect_style",
    "tab_media",
    "tab_meta",
    "tab_move_to_workspace",
    "tab_navigate",
    "tab_open",
    "tab_openapi",
    "tab_palette",
    "tab_picture_in_picture",
    "tab_print",
    "tab_record_start",
    "tab_reload",
    "tab_reload_hard",
    "tab_reorder",
    "tab_restore_scroll",
    "tab_screencast_cancel",
    "tab_screencast_pause",
    "tab_screencast_start",
    "tab_screencast_stop",
    "tab_scroll_position",
    "tab_set_muted",
    "tab_set_pinned",
    "tab_set_tier",
    "tab_stack",
    "tab_stop",
    "tab_storage",
    "tab_storage_delete",
    "tab_storage_value",
    "tab_throttle",
    "tab_unresponsive_answer",
    "tab_vitals",
    "tab_zoom",
    "tasks_list",
    "ui_state_load",
    "ui_state_set",
    "webapp_for_tab",
    "webapp_for_window",
    "webapp_icon",
    "webapp_open",
    "webapp_probe",
    "webapp_uninstall",
    "webapps_list",
    "window_close",
    "window_command",
    "window_exit_private",
    "window_open",
    "window_private",
    "window_set_background",
    "workspace_activate",
    "workspace_delete",
    "workspace_other_tabs",
    "workspace_reorder",
    "workspace_tab_counts",
    "workspace_update",
];

/// Commands a private window refuses: they persist something the session
/// promises not to keep, or reach credentials, extensions, other profiles
/// or updates. Startup extension loading and all credential-bearing or
/// background services are disabled as well. Installing a web app writes a
/// launcher to disk that outlives the session and opens a window with no
/// private context behind it, so it is refused. Listed so the test can tell
/// "refused" from "forgotten".
#[cfg(test)]
const PRIVATE_REFUSED: &[&str] = &[
    "agent_approve",
    "agent_key_present",
    "agent_key_set",
    "agent_key_verify",
    "agent_models",
    "agent_send",
    "agent_stop",
    "agent_thread_clear",
    "agent_thread_load",
    "agent_thread_save",
    "bookmark_remove",
    "bookmark_rename",
    "bookmark_toggle",
    "default_browser_set",
    "extension_import",
    "extension_remove",
    "extension_set_enabled",
    "extensions_list",
    "profile_activate",
    "profile_create",
    "profile_delete",
    "profile_update",
    "subtitle_model_delete",
    "subtitle_model_download",
    "update_check",
    "update_install",
    "webapp_install",
    "workspace_create",
];

pub fn allows_command(command: &str) -> bool {
    PRIVATE_ALLOWED.binary_search(&command).is_ok()
}

pub fn open(app: &AppHandle<Runtime>) -> AppResult<()> {
    if is_private() {
        return crate::commands::window_open_local(app.clone());
    }
    let mut session = crate::state::lock(&SESSION);
    if let Some(current) = session.as_mut()
        && current.alive.load(Ordering::Acquire)
    {
        let id = dive_core::TabId::new().to_string();
        if writeln!(current.input, "new-window:{id}").is_ok() {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                match current
                    .replies
                    .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                {
                    Ok((reply, ok)) if reply == id => {
                        return if ok {
                            Ok(())
                        } else {
                            Err(AppError::new(
                                "The private window could not be created. Your existing private session is still open.",
                            ))
                        };
                    }
                    Ok(_) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        return Err(AppError::new(
                            "The private session is still responding slowly. Please try New Private Window again.",
                        ));
                    }
                }
            }
        }
    }
    *session = Some(spawn_session()?);
    Ok(())
}

fn spawn_session() -> AppResult<Session> {
    // Do not inherit automation, profile, launch URL, or credential settings.
    let mut command = Command::new(std::env::current_exe().map_err(AppError::new)?);
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("DIVE_") {
            command.env_remove(key);
        }
    }
    let token = dive_core::TabId::new().to_string();
    command
        .env("DIVE_PRIVATE_LAUNCH_TOKEN", &token)
        .env("DIVE_PRIVATE_SESSION", "1")
        .env("DIVE_NORMAL_DATA_DIR", crate::state::data_root())
        .env("DIVE_USE_MOCK_KEYCHAIN", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if std::env::var_os("DIVE_USE_MOCK_KEYCHAIN").is_some() {
        command.env("DIVE_NORMAL_MOCK_KEYCHAIN", "1");
    }
    #[cfg(target_os = "macos")]
    command.args([
        "-ApplePersistenceIgnoreState",
        "YES",
        "-ApplePersistence",
        "-1",
    ]);
    if let Some(flag) = child_debug_port(std::env::args().skip(1)) {
        command.arg(flag);
    }
    let mut child = command.spawn().map_err(AppError::new)?;
    let input = child
        .stdin
        .take()
        .ok_or_else(|| AppError::new("private session channel unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::new("private startup channel unavailable"))?;
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (reply_tx, replies) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stdout);
        let mut line = String::new();
        // The child emits no browsing information on this channel. Keep
        // draining after readiness so a native diagnostic cannot block it.
        let ready = reader
            .read_line(&mut line)
            .ok()
            .filter(|size| *size < 4096)
            .and_then(|_| {
                line.trim()
                    .strip_prefix("DIVE_PRIVATE_READY:")
                    .map(PathBuf::from)
            });
        let _ = ready_tx.send(ready);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(reply) = line.strip_prefix("DIVE_PRIVATE_WINDOW:")
                && let Some((id, status)) = reply.split_once(':')
            {
                let _ = reply_tx.send((id.to_owned(), status == "ok"));
            }
        }
    });
    let root = match ready_rx.recv_timeout(std::time::Duration::from_secs(15)) {
        Ok(Some(root)) if owned_root(&root, &token) => root,
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::new(
                "Private Window could not start safely. Please try again.",
            ));
        }
    };
    let alive = Arc::new(AtomicBool::new(true));
    let watched = alive.clone();
    std::thread::spawn(move || {
        let _ = child.wait();
        watched.store(false, Ordering::Release);
        // Covers crashes/forced termination while the normal parent is alive.
        // The root is random, launch-bound, and outside the real profile.
        if owned_root(&root, &token) {
            let _ = std::fs::remove_dir_all(root);
        }
    });
    Ok(Session {
        input,
        alive,
        replies,
    })
}

fn owned_root(root: &std::path::Path, token: &str) -> bool {
    !token.is_empty()
        && root.file_name().is_some_and(|name| {
            name.to_string_lossy()
                .starts_with(&format!("dive-private-{token}-"))
        })
        && root.parent().and_then(|parent| parent.canonicalize().ok())
            == std::env::temp_dir().canonicalize().ok()
        && root
            .symlink_metadata()
            .is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink())
}

pub fn ready() {
    if is_private() {
        println!("DIVE_PRIVATE_READY:{}", data_root().display());
    }
}

pub fn start_window_channel(app: AppHandle<Runtime>) {
    if !is_private() {
        return;
    }
    // Only the parent has the writing end. No network listener, session token
    // file, or private URLs in a command line. Parent exit leaves windows usable.
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if let Some(id) = line.strip_prefix("new-window:") {
                let status = if crate::commands::window_open_local(app.clone()).is_ok() {
                    "ok"
                } else {
                    "error"
                };
                println!("DIVE_PRIVATE_WINDOW:{id}:{status}");
            }
        }
    });
}

/// A developer who launched Dive with `--remote-debugging-port=P` gets the
/// private process on `P + 1`, so both chromes can be inspected. A normal
/// launch has no such flag and the private process gets none either.
fn child_debug_port(args: impl IntoIterator<Item = String>) -> Option<String> {
    args.into_iter()
        .find_map(|arg| {
            arg.strip_prefix("--remote-debugging-port=")
                .and_then(|port| port.parse::<u16>().ok())
        })
        .and_then(|port| port.checked_add(1))
        .map(|port| format!("--remote-debugging-port={port}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_process_debugs_on_the_next_port_only_when_the_parent_does() {
        let args = |list: &[&str]| list.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert_eq!(
            child_debug_port(args(&["--remote-debugging-port=9345"])),
            Some("--remote-debugging-port=9346".to_owned())
        );
        assert_eq!(child_debug_port(args(&["https://example.com"])), None);
        assert_eq!(
            child_debug_port(args(&["--remote-debugging-port=65535"])),
            None
        );
    }
    #[test]
    fn private_policy_blocks_persistent_and_credential_actions() {
        for command in [
            "agent_send",
            "agent_key_set",
            "extension_import",
            "extensions_list",
            "profile_create",
            "bookmark_toggle",
            "default_browser_set",
            "update_install",
            "webapp_install",
            "definitely_not_a_command",
        ] {
            assert!(!allows_command(command), "{command}");
        }
        for command in [
            "snapshot",
            "tab_open",
            "tab_reload",
            "window_private",
            "screen_export_begin",
            "downloads_open",
            "report_startup_milestone",
            "card_save",
        ] {
            assert!(allows_command(command), "{command}");
        }
    }

    #[test]
    fn every_command_has_a_private_mode_decision() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bindings.ts");
        crate::commands::specta_builder()
            .export(specta_typescript::Typescript::default(), &path)
            .expect("export bindings");
        let generated = std::fs::read_to_string(&path).unwrap();
        let marker = "__TAURI_INVOKE(\"";
        let mut names: Vec<&str> = generated
            .split(marker)
            .skip(1)
            .filter_map(|rest| rest.split('"').next())
            .collect();
        names.push("report_startup_milestone");
        names.sort_unstable();
        names.dedup();
        assert!(names.len() > 100, "found only {} commands", names.len());

        for list in [PRIVATE_ALLOWED, PRIVATE_REFUSED] {
            assert!(
                list.windows(2).all(|pair| pair[0] < pair[1]),
                "private-mode lists must be strictly sorted"
            );
            for name in list {
                assert!(
                    names.binary_search(name).is_ok(),
                    "{name} is not a command; remove it from the private-mode lists"
                );
            }
        }
        for name in &names {
            let allowed = PRIVATE_ALLOWED.binary_search(name).is_ok();
            let refused = PRIVATE_REFUSED.binary_search(name).is_ok();
            assert!(
                allowed || refused,
                "{name} has no private-mode decision: add it to PRIVATE_ALLOWED or PRIVATE_REFUSED in private_session.rs"
            );
            assert!(
                !(allowed && refused),
                "{name} is in both private-mode lists"
            );
        }
    }

    #[test]
    fn a_folder_is_abandoned_once_no_session_holds_its_lock() {
        let dir = tempfile::tempdir().unwrap();
        let lock = std::fs::File::create(dir.path().join(SESSION_LOCK)).unwrap();
        lock.try_lock().unwrap();
        assert!(!abandoned(dir.path()), "a live session's folder stays");
        drop(lock);
        assert!(abandoned(dir.path()));
        // A folder from before the lock existed goes only once it is old.
        let legacy = tempfile::tempdir().unwrap();
        assert!(!abandoned(legacy.path()));
    }
}
