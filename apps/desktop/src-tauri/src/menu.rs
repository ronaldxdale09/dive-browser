//! The native menu bar, and with it the browser's keyboard shortcuts.
//!
//! The chrome listens for chords in the DOM, but the DOM only sees a key while
//! the chrome webview has focus — which it does not while a page is open, since
//! the page is its own native webview and holds first responder. Menu
//! accelerators are handled by the window before either webview sees the key,
//! so every browser-level chord is registered here and forwarded to the chrome,
//! which owns what the command actually does.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

// Everything below this line builds the native menu bar, which only exists
// where `install` runs. `MenuCommand` carries chrome and page-menu commands
// on every platform and needs none of it.
#[cfg(not(target_os = "windows"))]
use crate::Runtime;
#[cfg(not(target_os = "windows"))]
use crate::state::{AppState, lock};
#[cfg(feature = "cef")]
#[cfg(not(target_os = "windows"))]
use crate::ui_probe::native_input_receipt;
#[cfg(not(target_os = "windows"))]
use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder, Submenu, SubmenuBuilder};
#[cfg(not(target_os = "windows"))]
use tauri::{App, Manager};

#[cfg(not(feature = "cef"))]
fn native_input_receipt(_stage: &'static str, _command: &str) {}

/// A menu item the chrome owns; the payload is a command id from `UI_COMMANDS`.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct MenuCommand(pub String);

/// Commands whose point is to type into the chrome. The page keeps keyboard
/// focus while it is visible, so focus has to move before the command lands or
/// the first keystrokes would go to the page.
// Only the native menu bar uses this, and only macOS has one: Windows
// draws its controls in the chrome instead.
#[cfg(not(target_os = "windows"))]
const FOCUS_CHROME: [&str; 12] = [
    "palette.open",
    "tabs.search",
    "tab.new",
    "find.open",
    "address.focus",
    "bookmarks.open",
    "history.open",
    "downloads.open",
    "browsing-data.open",
    "workspace.new",
    "workspace.edit",
    "shortcuts.open",
];

/// These commands create browser chrome in the main workspace window.
pub(crate) fn main_window_command(command: &str) -> bool {
    matches!(command, "tab.new" | "window.new")
}

/// One chrome-owned menu item with its accelerator.
// Only the native menu bar uses this, and only macOS has one: Windows
// draws its controls in the chrome instead.
#[cfg(not(target_os = "windows"))]
fn item(app: &App<Runtime>, id: &str, text: &str, accel: &str) -> tauri::Result<MenuItem<Runtime>> {
    MenuItemBuilder::with_id(id, text)
        .accelerator(accel)
        .build(app)
}

// Only the native menu bar uses this, and only macOS has one: Windows
// draws its controls in the chrome instead.
#[cfg(not(target_os = "windows"))]
fn open_window_from_menu(app: tauri::AppHandle<Runtime>, private: bool) {
    tauri::async_runtime::spawn(async move {
        let result = if private {
            crate::commands::window_private(app).await
        } else {
            tauri::async_runtime::spawn_blocking(move || crate::commands::window_open(app))
                .await
                .map_err(crate::AppError::new)
                .and_then(std::convert::identity)
        };
        if let Err(error) = result {
            rfd::AsyncMessageDialog::new()
                .set_title(if private {
                    "Private Window"
                } else {
                    "New Window"
                })
                .set_description(error.to_string())
                .set_buttons(rfd::MessageButtons::Ok)
                .show()
                .await;
        }
    });
}

/// The File menu: the tab and chrome commands people reach for first.
#[cfg(not(target_os = "windows"))]
fn file_menu(app: &App<Runtime>) -> tauri::Result<Submenu<Runtime>> {
    let mut file = SubmenuBuilder::new(app, "File");
    if crate::private_session::is_private() {
        file = file
            .item(&MenuItemBuilder::with_id("private.exit", "Exit Private Mode").build(app)?)
            .separator();
    }
    file.item(&item(app, "window.new", "New Window", "CmdOrCtrl+N")?)
        .item(&item(
            app,
            "window.private",
            "New Private Window",
            "CmdOrCtrl+Shift+N",
        )?)
        .item(&item(app, "tab.new", "New Tab", "CmdOrCtrl+T")?)
        .item(&item(app, "tab.close", "Close Tab", "CmdOrCtrl+W")?)
        .separator()
        .item(&item(
            app,
            "address.focus",
            "Open Location…",
            "CmdOrCtrl+L",
        )?)
        .item(&item(
            app,
            "palette.open",
            "Command Palette…",
            "CmdOrCtrl+K",
        )?)
        .item(&item(app, "find.open", "Find in Page…", "CmdOrCtrl+F")?)
        .item(&item(
            app,
            "bookmark.toggle",
            "Bookmark This Page",
            "CmdOrCtrl+D",
        )?)
        .separator()
        .item(&item(
            app,
            "capture.fullpage",
            "Capture Full Page",
            "CmdOrCtrl+Shift+S",
        )?)
        .item(&item(
            app,
            "screencast.toggle",
            "Record Tab as GIF",
            "CmdOrCtrl+Shift+R",
        )?)
        .item(&item(
            app,
            "report.compose",
            "Copy Bug Report",
            "CmdOrCtrl+Shift+B",
        )?)
        .build()
}

/// Workspaces earn a menu of their own: it is where someone who has never
/// used one finds out they exist, and the numbered chords are the fastest way
/// between them once they have a few.
#[cfg(not(target_os = "windows"))]
fn workspaces_menu(app: &App<Runtime>) -> tauri::Result<Submenu<Runtime>> {
    let mut menu = SubmenuBuilder::new(app, "Workspaces")
        .item(&item(
            app,
            "workspace.new",
            "New Workspace…",
            "CmdOrCtrl+Alt+Shift+N",
        )?)
        .item(&item(
            app,
            "workspace.edit",
            "Edit Workspace…",
            "CmdOrCtrl+Shift+E",
        )?)
        .separator();
    for n in 1..=9 {
        menu = menu.item(&item(
            app,
            &format!("workspace.jump.{n}"),
            &format!("Workspace {n}"),
            &format!("CmdOrCtrl+{n}"),
        )?);
    }
    menu.build()
}

/// Page history, tab traversal and the Chrome-compatible library shortcuts.
#[cfg(not(target_os = "windows"))]
fn history_menu(app: &App<Runtime>) -> tauri::Result<Submenu<Runtime>> {
    SubmenuBuilder::new(app, "History")
        .item(&item(app, "tab.back", "Back", "CmdOrCtrl+BracketLeft")?)
        .item(&item(
            app,
            "tab.forward",
            "Forward",
            "CmdOrCtrl+BracketRight",
        )?)
        .separator()
        .item(&item(
            app,
            "tab.prev",
            "Previous Tab",
            "CmdOrCtrl+Shift+BracketLeft",
        )?)
        .item(&item(
            app,
            "tab.next",
            "Next Tab",
            "CmdOrCtrl+Shift+BracketRight",
        )?)
        .separator()
        .item(&item(
            app,
            "tabs.search",
            "Search Tabs…",
            "CmdOrCtrl+Shift+A",
        )?)
        .item(&item(app, "history.open", "Show History", "CmdOrCtrl+Y")?)
        .item(&item(
            app,
            "bookmarks.open",
            "Show Bookmarks",
            "CmdOrCtrl+Alt+B",
        )?)
        .item(&item(
            app,
            "downloads.open",
            "Show Downloads",
            "CmdOrCtrl+Shift+J",
        )?)
        .item(&item(
            app,
            "browsing-data.open",
            "Delete Browsing Data…",
            "CmdOrCtrl+Shift+Backspace",
        )?)
        .build()
}

/// Build the menu and route its events to the chrome.
// Only the native menu bar uses this, and only macOS has one: Windows
// draws its controls in the chrome instead.
#[cfg(not(target_os = "windows"))]
pub fn install(app: &App<Runtime>) -> tauri::Result<()> {
    // "About" opens Dive's own About section rather than the stock panel,
    // so the version, engine and update check are all in one place.
    let app_menu = SubmenuBuilder::new(app, "Dive")
        .item(&MenuItemBuilder::with_id("about.open", "About Dive").build(app)?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file = file_menu(app)?;

    // Predefined items only: macOS routes cut/copy/paste through the menu, so
    // without them the chrome's own text fields lose clipboard support.
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item(app, "tab.reload", "Reload Page", "CmdOrCtrl+R")?)
        .separator()
        .item(&item(app, "zoom.in", "Zoom In", "CmdOrCtrl+Equal")?)
        .item(&item(app, "zoom.out", "Zoom Out", "CmdOrCtrl+Minus")?)
        .item(&item(app, "zoom.reset", "Actual Size", "CmdOrCtrl+0")?)
        .separator()
        .item(&item(
            app,
            "dock.toggle",
            "Developer Dock",
            "CmdOrCtrl+Shift+D",
        )?)
        .item(&item(app, "sidecar.toggle", "Agent", "CmdOrCtrl+J")?)
        .item(&item(app, "tab.devtools", "DevTools", "CmdOrCtrl+Alt+I")?)
        .build()?;

    let history = history_menu(app)?;

    let workspaces = workspaces_menu(app)?;

    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .fullscreen()
        .separator()
        .close_window()
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &file,
            &edit,
            &view,
            &history,
            &workspaces,
            &window,
        ])
        .build()?;
    app.set_menu(menu)?;

    app.on_menu_event(|app, event| {
        let id = event.id().0.clone();
        native_input_receipt("menu-received", &id);
        if matches!(id.as_str(), "window.private" | "window.new") {
            open_window_from_menu(app.clone(), id == "window.private");
            return;
        }
        if id == "private.exit" {
            let _ = crate::commands::window_exit_private(app.clone());
            return;
        }
        // A tab in its own window has its own chrome; while that window is
        // focused the shortcut is about it, not the main window's page.
        let target = {
            let state = app.state::<AppState>();
            let host = lock(&state.host);
            match host.as_ref() {
                Some(host) => {
                    if main_window_command(&id) {
                        if let Err(error) = host.focus_main_chrome() {
                            tracing::warn!(%error, "focusing main window for menu failed");
                            return;
                        }
                        crate::CHROME_LABEL.to_owned()
                    } else {
                        if FOCUS_CHROME.contains(&id.as_str()) {
                            host.focus_chrome_for_menu();
                        }
                        host.chrome_for_menu()
                    }
                }
                None => crate::CHROME_LABEL.to_owned(),
            }
        };
        native_input_receipt("menu-focus-returned", &id);
        native_input_receipt("menu-emit-begin", &id);
        let command = MenuCommand(id);
        let _ = command.emit_to(app, target.as_str());
        native_input_receipt("menu-emit-returned", &command.0);
    });
    Ok(())
}
