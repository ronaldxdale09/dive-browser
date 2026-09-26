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

/// Commands a detached window's chrome carries out for the one page it
/// shows (`runDetachedCommand` in the chrome; the two lists must agree).
/// Anything else sent there was dropped on the floor -- after the keyboard
/// had already been taken from the page for it.
#[cfg(not(target_os = "windows"))]
const POPOUT_COMMANDS: [&str; 11] = [
    "tab.close",
    "tab.reload",
    "tab.back",
    "tab.forward",
    "tab.devtools",
    "zoom.in",
    "zoom.out",
    "zoom.reset",
    "page.save",
    "find.open",
    // A torn-off tab has an address bar; an app window does not.
    "address.focus",
];

/// Commands about the browser rather than about a page: a history list or
/// the palette means the same thing from any window, so from a detached one
/// they raise the main window, where they live.
#[cfg(not(target_os = "windows"))]
const BROWSER_COMMANDS: [&str; 10] = [
    "palette.open",
    "tabs.search",
    "history.open",
    "bookmarks.open",
    "downloads.open",
    "browsing-data.open",
    "shortcuts.open",
    "about.open",
    "workspace.new",
    "workspace.edit",
];

/// Where a menu command goes.
#[cfg(not(target_os = "windows"))]
#[derive(Debug, PartialEq, Eq)]
enum MenuTarget {
    /// The chrome of the focused window, main or detached.
    Focused,
    /// The main window's chrome, raising the window first.
    Main,
    /// Nowhere: a page command a detached window has no way to carry out.
    /// Sending it to the main window would act on a different page than the
    /// one in front of the person.
    Nowhere,
}

/// Route `command` given the focused detached window, if any: `Some(true)`
/// for an installed app's window, `Some(false)` for a torn-off tab.
#[cfg(not(target_os = "windows"))]
fn menu_target(command: &str, focused_popout: Option<bool>) -> MenuTarget {
    if main_window_command(command) {
        return MenuTarget::Main;
    }
    let Some(app_window) = focused_popout else {
        return MenuTarget::Focused;
    };
    if POPOUT_COMMANDS.contains(&command) && !(app_window && command == "address.focus") {
        MenuTarget::Focused
    } else if BROWSER_COMMANDS.contains(&command) {
        MenuTarget::Main
    } else {
        MenuTarget::Nowhere
    }
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
        .item(&item(app, "page.save", "Save Page As…", "CmdOrCtrl+S")?)
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
            "CmdOrCtrl+Alt+Shift+R",
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

/// Label of the chrome a menu command goes to, with the keyboard moved there
/// when the command types into it; `None` when it goes nowhere. A tab in its
/// own window has its own chrome, and while that window is focused the
/// shortcut is about it, not the main window's page.
#[cfg(not(target_os = "windows"))]
fn chrome_for_command(app: &tauri::AppHandle<Runtime>, id: &str) -> Option<String> {
    let state = app.state::<AppState>();
    let host = lock(&state.host);
    let Some(host) = host.as_ref() else {
        return Some(crate::CHROME_LABEL.to_owned());
    };
    let focused = host
        .focused_popout()
        .map(|tab| host.app_for_tab(tab).is_some());
    match menu_target(id, focused) {
        MenuTarget::Main => {
            if let Err(error) = host.focus_main_chrome() {
                tracing::warn!(%error, "focusing main window for menu failed");
                return None;
            }
            Some(crate::CHROME_LABEL.to_owned())
        }
        MenuTarget::Focused => {
            if FOCUS_CHROME.contains(&id) {
                host.focus_chrome_for_menu();
            }
            Some(host.chrome_for_menu())
        }
        MenuTarget::Nowhere => {
            tracing::debug!(
                command = id,
                "menu command has no page to act on in this window"
            );
            None
        }
    }
}

/// Build the menu and route its events to the chrome.
// Only the native menu bar uses this, and only macOS has one: Windows
// draws its controls in the chrome instead.
#[cfg(not(target_os = "windows"))]
#[allow(clippy::too_many_lines)] // The whole menu bar in reading order, as the user sees it.
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
        .item(&item(
            app,
            "tab.reloadHard",
            "Hard Reload",
            "CmdOrCtrl+Shift+R",
        )?)
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
        let Some(target) = chrome_for_command(app, &id) else {
            return;
        };
        native_input_receipt("menu-focus-returned", &id);
        native_input_receipt("menu-emit-begin", &id);
        let command = MenuCommand(id);
        let _ = command.emit_to(app, target.as_str());
        native_input_receipt("menu-emit-returned", &command.0);
    });
    Ok(())
}

#[cfg(all(test, not(target_os = "windows")))]
mod tests {
    use super::*;

    #[test]
    fn the_main_window_keeps_every_command() {
        for command in ["find.open", "bookmark.toggle", "history.open", "zoom.in"] {
            assert_eq!(menu_target(command, None), MenuTarget::Focused, "{command}");
        }
    }

    #[test]
    fn a_detached_window_gets_only_what_it_can_do_for_its_page() {
        for command in [
            "find.open",
            "zoom.in",
            "zoom.reset",
            "page.save",
            "tab.back",
            "address.focus",
        ] {
            assert_eq!(
                menu_target(command, Some(false)),
                MenuTarget::Focused,
                "{command}"
            );
        }
        // Page commands the window cannot carry out are not sent to the main
        // window either: they would act on a page nobody is looking at.
        for command in [
            "bookmark.toggle",
            "capture.fullpage",
            "sidecar.toggle",
            "tab.next",
        ] {
            assert_eq!(
                menu_target(command, Some(false)),
                MenuTarget::Nowhere,
                "{command}"
            );
        }
        for command in ["history.open", "palette.open", "about.open", "tab.new"] {
            assert_eq!(
                menu_target(command, Some(false)),
                MenuTarget::Main,
                "{command}"
            );
        }
    }

    #[test]
    fn an_app_window_has_no_address_bar_to_focus() {
        assert_eq!(
            menu_target("address.focus", Some(true)),
            MenuTarget::Nowhere
        );
        assert_eq!(menu_target("find.open", Some(true)), MenuTarget::Focused);
    }
}
