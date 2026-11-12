//! Window, popout and layout commands: the chrome's geometry and the tab views it owns.

// Tauri commands receive their arguments by value; that is the IPC contract.
#![allow(clippy::needless_pass_by_value)]

use dive_core::{CoreEvent, Tab, TabId, WorkspaceId};
use tauri::{AppHandle, State};
use tauri_specta::Event;

use super::{
    ContentPreview, Snapshot, TabWindowChanged, activate_tab, on_main, open_tab,
    profile_workspace_key,
};
use crate::Runtime;
use crate::engine::{Bounds, MainThread, OverlayRegion, PaneBounds};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

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
    open_private_window(&app).await
}

/// Open the private session's window off the calling thread.
pub(crate) async fn open_private_window(app: &AppHandle<Runtime>) -> AppResult<()> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || crate::private_session::open(&app))
        .await
        .map_err(AppError::new)?
}

#[tauri::command]
#[specta::specta]
pub(crate) fn window_open(app: AppHandle<Runtime>) -> AppResult<()> {
    open_window(&app)
}

/// Open a window: a normal one from a private session, else in this process.
pub(crate) fn open_window(app: &AppHandle<Runtime>) -> AppResult<()> {
    if crate::private_session::is_private() {
        return crate::normal_window::open();
    }
    window_open_local(app.clone())
}

/// Create a window in this process, retaining its current privacy boundary.
pub(crate) fn window_open_local(app: AppHandle<Runtime>) -> AppResult<()> {
    on_main(&app, move |main, app, state| {
        let workspace =
            (*lock(&state.active_workspace)).ok_or_else(|| AppError::new("no active workspace"))?;
        let tab = open_tab(main, app, state, workspace, "about:blank")?;
        detach_tab(main, app, state, tab.id, None, None)?;
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
    exit_private_session(&app)
}

/// End the private session by exiting the process.
pub(crate) fn exit_private_session(app: &AppHandle<Runtime>) -> AppResult<()> {
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
/// A page capture for the overlay must not outrun the click that asked for
/// it; past this the dialog opens over the live page instead.
const COVER_CAPTURE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);

#[tauri::command]
#[specta::specta]
pub(crate) async fn layout_prepare_content_cover(
    webview: tauri::Webview<Runtime>,
    state: State<'_, AppState>,
) -> AppResult<Vec<ContentPreview>> {
    use futures_util::future::join_all;

    let sessions = lock(&state.host).as_ref().map_or_else(Vec::new, |host| {
        host.covered_sessions_for_chrome(webview.label())
    });
    let captures = join_all(sessions.into_iter().map(|(tab_id, session)| async move {
        // Base64 straight through: the result becomes a `data:` URL, and
        // decoding it here only to encode it again costs two passes over the
        // image while the dialog's backdrop waits to paint. The quality is low
        // because what the person sees is this image behind a heavy blur.
        // Bound the capture: it stands between a click and a blurred dialog,
        // and `Page.captureScreenshot` on a busy renderer -- a playing video
        // -- can take the session's full default timeout. Past this the
        // dialog opens over the live page instead of a frozen one, which the
        // chrome handles, rather than the click appearing to hang.
        let capture = dive_cdp::page::capture_screenshot_base64(
            &session,
            dive_cdp::page::ScreenshotOptions {
                format: dive_cdp::page::ImageFormat::Jpeg,
                quality: Some(50),
                ..Default::default()
            },
        );
        let result = match tokio::time::timeout(COVER_CAPTURE_TIMEOUT, capture).await {
            Ok(result) => result,
            Err(_) => Err(dive_cdp::CdpError::Timeout {
                method: "Page.captureScreenshot".to_owned(),
            }),
        };
        (tab_id, result)
    }))
    .await;

    Ok(captures
        .into_iter()
        .filter_map(|(tab_id, result)| match result {
            Ok(data) => Some(ContentPreview {
                tab_id,
                data_url: format!("data:image/jpeg;base64,{data}"),
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

/// The chrome document has booted. A chrome reloaded after its renderer died
/// (or after a hot reload in development) starts with no dialogs and no
/// menus, so any cover or overlay mask its previous document left over the
/// pages is taken down; otherwise the page stayed hidden under a dialog that
/// no longer existed, with nothing left to close it.
#[tauri::command]
#[specta::specta]
pub(crate) fn chrome_ready(
    app: AppHandle<Runtime>,
    webview: tauri::Webview<Runtime>,
) -> AppResult<()> {
    let label = webview.label().to_owned();
    on_main(&app, move |_, _, state| {
        if let Some(host) = lock(&state.host).as_mut() {
            host.reset_chrome_cover(&label)?;
        }
        Ok(())
    })
}

/// Something went wrong inside the chrome's own code: a component that
/// threw, an uncaught error, a rejected promise nobody awaited. The chrome
/// shows what it can; the log keeps the rest, where a bug report finds it.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri hands command arguments over by value.
pub(crate) fn log_chrome_error(
    webview: tauri::Webview<Runtime>,
    kind: String,
    message: String,
    stack: Option<String>,
) {
    /// Enough for any real stack; a runaway string must not flood the log.
    const LIMIT: usize = 8 * 1024;
    let clip = |text: &str| -> String { text.chars().take(LIMIT).collect() };
    let kind = clip(&kind);
    let stack = clip(stack.as_deref().unwrap_or_default());
    // The chrome tags a failure it deliberately swallows ("ignored: ...") so
    // it leaves a trace without reading as a fault in a bug report.
    if kind.starts_with("ignored") {
        tracing::debug!(
            chrome = %webview.label(),
            kind = %kind,
            stack = %stack,
            "chrome error: {}",
            clip(&message)
        );
    } else {
        tracing::error!(
            chrome = %webview.label(),
            kind = %kind,
            stack = %stack,
            "chrome error: {}",
            clip(&message)
        );
    }
}

/// Regions belong to trusted chrome and use CSS logical pixels. `take_focus`
/// is false when every overlay is passive (tooltips, the save-login card), so
/// the page keeps the keyboard under them.
#[tauri::command]
#[specta::specta]
pub(crate) fn layout_set_overlay_regions(
    app: AppHandle<Runtime>,
    webview: tauri::Webview<Runtime>,
    regions: Vec<OverlayRegion>,
    active: bool,
    modal: bool,
    take_focus: bool,
) -> AppResult<()> {
    if regions.len() > 64
        || regions.iter().any(|b| {
            [b.x, b.y, b.width, b.height, b.radius]
                .iter()
                .any(|n| !n.is_finite())
                || b.width < 0.0
                || b.height < 0.0
                || b.radius < 0.0
        })
    {
        return Err(AppError::new("invalid overlay geometry"));
    }
    on_main(&app, move |_, _, state| {
        if let Some(host) = lock(&state.host).as_mut() {
            host.set_live_overlay(webview.label(), regions, active, modal, take_focus)?;
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
            // One pane that cannot wake must not leave every other pane of
            // the split unplaced; its rectangle is kept and its page goes
            // there once a view for it exists.
            for pane in &panes {
                if let Err(e) = ensure_view(main, app, state, host, &store, pane.tab) {
                    tracing::warn!(tab = %pane.tab, "split pane could not be woken: {e}");
                }
            }
        }
        let shown: Vec<TabId> = panes.iter().map(|pane| pane.tab).collect();
        host.set_panes(panes)?;
        // A pane is on screen as much as the active tab is: one that crashed
        // in the background is owed its reload now.
        for tab in shown {
            let _ = host.with_view(tab, |view| {
                crate::crash::reload_if_deferred(&state.crashes, tab, view)
            });
        }
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
    pop_out_tab(&app, id, at)
}

/// `detach_tab` from any thread: hops to the main thread first.
pub(crate) fn pop_out_tab(
    app: &AppHandle<Runtime>,
    id: TabId,
    at: Option<(f64, f64)>,
) -> AppResult<()> {
    on_main(app, move |main, app, state| {
        detach_tab(main, app, state, id, at, None)
    })
}

pub(crate) fn detach_tab(
    main: &MainThread,
    app: &AppHandle<Runtime>,
    state: &AppState,
    id: TabId,
    at: Option<(f64, f64)>,
    web_app: Option<&crate::engine::AppWindowSpec>,
) -> AppResult<()> {
    let (was_active, workspace) = {
        let mut host = lock(&state.host);
        let host = host
            .as_mut()
            .ok_or_else(|| AppError::new("engine not ready"))?;
        let store = lock(&state.store);
        let tab = ensure_view(main, app, state, host, &store, id)?;
        let was_active = host.active() == Some(id);
        host.detach(app, id, &tab.title, at, web_app)?;
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
    attach_tab(&app, id)
}

/// Bring `id` back from its own window, from any thread.
pub(crate) fn attach_tab(app: &AppHandle<Runtime>, id: TabId) -> AppResult<()> {
    on_main(app, move |main, app, state| {
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

#[cfg(test)]
mod tests {
    use super::*;
    use dive_core::Workspace;

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
}
