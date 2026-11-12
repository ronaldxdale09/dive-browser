//! The command palette: the built-in command table and running a command by id.

// Tauri commands receive their arguments by value; that is the IPC contract.
#![allow(clippy::needless_pass_by_value)]

use dive_core::{Command, CommandScope};
use serde_json::Value;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Register commands that only touch core state. Engine-backed actions are
/// exposed as dedicated IPC commands; the registry lists them for the palette.
#[allow(clippy::too_many_lines)] // The built-in command table; one list to read.
pub fn register_builtin(registry: &dive_core::CommandRegistry) {
    let builtin = [
        ("tab.new", "New tab", Some("mod+t"), CommandScope::Workspace),
        ("tab.close", "Close tab", Some("mod+w"), CommandScope::Tab),
        ("tab.reload", "Reload", Some("mod+r"), CommandScope::Tab),
        (
            "tab.reloadHard",
            "Hard reload",
            Some("mod+shift+r"),
            CommandScope::Tab,
        ),
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
            Some("mod+alt+shift+r"),
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
            "page.save",
            "Save page as a file",
            Some("mod+s"),
            CommandScope::Tab,
        ),
        (
            "video.pip",
            "Picture in picture: float this page's video",
            None,
            CommandScope::Tab,
        ),
        (
            "tasks.open",
            "Task manager: what each tab is costing",
            Some("shift+escape"),
            CommandScope::Global,
        ),
        (
            "page.reader",
            "Reader view",
            Some("mod+shift+i"),
            CommandScope::Tab,
        ),
        (
            "page.translate",
            "Translate this page",
            None,
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
