//! Closing the main window while other Dive windows are open.
//!
//! The main window hosts every tab's native view, so it is never destroyed
//! while a torn-off tab, a ⌘N window or an installed app's window is still
//! open: closing it used to quit Dive and take those windows with it. It is
//! hidden instead, and Dive quits once the last of the other windows closes.
//!
//! A private session closes the hidden window's tabs, which exist for this
//! session only. A normal profile keeps them: they belong to workspaces that
//! outlive any window and come back with the main window (a Dock click, "Open
//! in Dive", a new tab) or with the next launch. They are silenced while the
//! window is away, so a video left playing in it is not heard from a window
//! nobody can see.
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;

use crate::{MAIN_WINDOW, Runtime};

static MAIN_CLOSED: AtomicBool = AtomicBool::new(false);

/// Whether a close request for `label` should hide the main window: it is the
/// main window and some tab still has a window of its own.
fn hides_instead(label: &str, detached: usize) -> bool {
    label == MAIN_WINDOW && detached > 0
}

/// Handle a close request. Returns true when the main window was hidden and
/// the request must be refused.
pub fn close(window: &tauri::Window<Runtime>) -> bool {
    if window.label() != MAIN_WINDOW {
        return false;
    }
    let app = window.app_handle();
    let state = app.state::<crate::state::AppState>();
    let detached = crate::state::lock(&state.host)
        .as_ref()
        .map_or_else(Vec::new, crate::engine::TabHost::detached);
    if !hides_instead(window.label(), detached.len()) {
        return false;
    }
    let Some(main) = crate::engine::MainThread::here() else {
        return false;
    };
    if crate::private_session::is_private() {
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
    }
    if window.hide().is_err() {
        return false;
    }
    MAIN_CLOSED.store(true, Ordering::Release);
    if !crate::private_session::is_private()
        && let Some(host) = crate::state::lock(&state.host).as_ref()
    {
        host.quiet_main_tabs(true);
    }
    true
}

/// Show the main window again if it was closed. Returns whether it was, so
/// the caller can give its tabs their sound back.
pub fn reveal(window: &tauri::Window<Runtime>) -> tauri::Result<bool> {
    if MAIN_CLOSED.swap(false, Ordering::AcqRel) {
        window.show()?;
        return Ok(true);
    }
    Ok(false)
}

/// Bring the main window back if it was closed, from outside the tab host:
/// a Dock click, a link handed over by the system. The caller still raises
/// it. Must run on the main thread.
pub fn reopen(app: &tauri::AppHandle<Runtime>) {
    let state = app.state::<crate::state::AppState>();
    let host = crate::state::lock(&state.host);
    let result = match host.as_ref() {
        Some(host) => host.reveal_main(),
        None => app
            .get_window(MAIN_WINDOW)
            .map_or(Ok(false), |window| reveal(&window))
            .map(|_| ()),
    };
    if let Err(error) = result {
        tracing::warn!(%error, "could not show the main window again");
    }
}

/// Quit once the last window other than the closed main one is gone.
pub fn window_destroyed(app: &tauri::AppHandle<Runtime>) {
    if MAIN_CLOSED.load(Ordering::Acquire) && app.windows().keys().all(|label| label == MAIN_WINDOW)
    {
        app.exit(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_main_window_with_others_open_is_hidden() {
        assert!(hides_instead(MAIN_WINDOW, 1));
        // With nothing else open, closing the main window quits as always.
        assert!(!hides_instead(MAIN_WINDOW, 0));
        // A popout's own close request closes its tab.
        assert!(!hides_instead("pop-1-abc", 2));
    }
}
