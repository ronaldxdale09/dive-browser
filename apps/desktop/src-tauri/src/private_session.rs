//! Private browsing is a separate process with an in-memory application store
//! and a CEF off-the-record context. The normal profile never receives its events.
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::{MAIN_WINDOW, Runtime};

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static MAIN_CLOSED: AtomicBool = AtomicBool::new(false);
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
        match built {
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
        }
    })
    .clone()
}

pub fn cleanup() {
    if let Some(root) = ROOT.get() {
        let _ = std::fs::remove_dir_all(root);
    }
}

/// Startup extension loading and all credential-bearing/background services are
/// disabled as well as these UI commands. The policy is enforced before dispatch.
pub fn allows_command(command: &str) -> bool {
    ![
        "agent_",
        "extensions_",
        "extension_",
        "profile_",
        "subtitle_model_",
        "update_",
    ]
    .iter()
    .any(|prefix| command.starts_with(prefix))
        && !matches!(
            command,
            "bookmark_toggle"
                | "bookmark_remove"
                | "bookmark_rename"
                | "default_browser_set"
                | "workspace_create"
        )
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

/// Keep the private context alive in the hidden trusted chrome while another
/// private window is open. Closing the last visible window terminates the session.
pub fn close_main(window: &tauri::Window<Runtime>) -> bool {
    if !is_private() || window.label() != MAIN_WINDOW {
        return false;
    }
    let app = window.app_handle();
    let state = app.state::<crate::state::AppState>();
    let detached = crate::state::lock(&state.host)
        .as_ref()
        .map_or_else(Vec::new, crate::engine::TabHost::detached);
    if detached.is_empty() {
        return false;
    }
    let Some(main) = crate::engine::MainThread::here() else {
        return false;
    };
    let attached = {
        let store = crate::state::lock(&state.store);
        store
            .workspaces()
            .unwrap_or_default()
            .into_iter()
            .flat_map(|workspace| store.tabs_for_workspace(workspace.id).unwrap_or_default())
            .filter(|tab| !detached.contains(&tab.id))
            .map(|tab| tab.id)
            .collect::<std::collections::HashSet<_>>()
    };
    for tab in attached {
        let _ = crate::commands::close_tab(&main, app, &state, tab);
    }
    if window.hide().is_err() {
        return false;
    }
    MAIN_CLOSED.store(true, Ordering::Release);
    true
}

pub fn reveal_main(window: &tauri::Window<Runtime>) -> tauri::Result<()> {
    if is_private() && MAIN_CLOSED.swap(false, Ordering::AcqRel) {
        window.show()?;
    }
    Ok(())
}

pub fn window_destroyed(app: &AppHandle<Runtime>) {
    if is_private()
        && MAIN_CLOSED.load(Ordering::Acquire)
        && app.windows().keys().all(|label| label == MAIN_WINDOW)
    {
        app.exit(0);
    }
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
            "agent_set_key",
            "extension_load",
            "extensions_list",
            "profile_create",
            "bookmark_toggle",
            "default_browser_set",
            "update_install",
        ] {
            assert!(!allows_command(command), "{command}");
        }
        for command in [
            "snapshot",
            "tab_open",
            "tab_reload",
            "window_private",
            "privacy_info",
            "screen_export",
            "download_open",
        ] {
            assert!(allows_command(command), "{command}");
        }
    }
}
