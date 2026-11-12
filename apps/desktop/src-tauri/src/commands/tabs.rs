//! Tab commands: opening, closing, activating, navigating and moving tabs.

// Tauri commands receive their arguments by value; that is the IPC contract.
#![allow(clippy::needless_pass_by_value)]

use dive_core::{CoreEvent, Tab, TabId, Workspace, WorkspaceId};
use tauri::{AppHandle, State};
use tauri_specta::Event;

use super::{
    cdp_for, forget_tab_state, normalize_url_with, on_main, with_view, workspace_tab_key,
    workspace_tab_to_show,
};
use crate::Runtime;
use crate::engine::MainThread;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// Where a tab's page is scrolled, for remembering a tab about to close.
/// A page that cannot say in time -- or a sleeping tab, which has no page
/// to ask -- answers with where it was last kept; `None` when neither knows.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_scroll_position(
    state: State<'_, AppState>,
    id: TabId,
) -> AppResult<Option<(i32, i32)>> {
    if let Ok(session) = cdp_for(&state, id)
        && let Some(live) = crate::housekeeping::page_scroll(&session).await
    {
        return Ok(Some(live));
    }
    let store = lock(&state.store);
    let Ok(tab) = store.tab(id) else {
        return Ok(None);
    };
    Ok(store.scroll(id, &tab.url)?)
}

/// Scroll a freshly opened tab to where its closed predecessor was, once its
/// page has loaded.
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_restore_scroll(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: TabId,
    x: i32,
    y: i32,
) -> AppResult<()> {
    {
        let store = lock(&state.store);
        let tab = store.tab(id)?;
        store.set_scroll(id, &tab.url, x, y)?;
    }
    crate::housekeeping::restore_scroll(app, id);
    Ok(())
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

/// Recent background opens, to tell a burst from the odd link opened behind.
struct Burst {
    opens: std::sync::Mutex<std::collections::VecDeque<std::time::Instant>>,
}

impl Burst {
    /// Background opens inside [`Burst::WINDOW`] that still load at once.
    const LIMIT: usize = 5;
    const WINDOW: std::time::Duration = std::time::Duration::from_secs(10);

    const fn new() -> Self {
        Self {
            opens: std::sync::Mutex::new(std::collections::VecDeque::new()),
        }
    }

    /// Count an open at `now`; true when it is past the first few of a burst.
    fn burst(&self, now: std::time::Instant) -> bool {
        let mut opens = lock(&self.opens);
        while opens
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) >= Self::WINDOW)
        {
            opens.pop_front();
        }
        opens.push_back(now);
        opens.len() > Self::LIMIT
    }
}

static BACKGROUND_OPENS: Burst = Burst::new();

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
        // One of a burst of links opened behind the page (a row of results
        // middle-clicked in turn) starts asleep: each would otherwise start a
        // renderer and load at once, for pages nobody is looking at yet. It
        // loads when it is first shown, like any sleeping tab.
        if !activate
            && url.scheme() != crate::engine::INTERNAL_SCHEME
            && BACKGROUND_OPENS.burst(std::time::Instant::now())
        {
            tab.state = dive_core::TabState::Discarded;
        }
        store.upsert_tab(&tab)?;
        (tab, container)
    };
    let opened = {
        let mut host = lock(&state.host);
        match host.as_mut() {
            Some(_) if tab.state == dive_core::TabState::Discarded => Ok(()),
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
    close_tab_from_user(&app, id)
}

/// `request_tab_close` from any thread: hops to the main thread first.
pub(crate) fn close_tab_from_user(app: &AppHandle<Runtime>, id: TabId) -> AppResult<()> {
    on_main(app, move |main, app, state| {
        request_tab_close(main, app, state, id)
    })
}

/// Close `id` because the person asked to (⌘W, the tab's X, a middle click,
/// Close other tabs, a detached window's close button). The page is asked
/// first, the way every browser asks it: one holding unsaved work shows its
/// "Leave site?" question, and the tab only goes once the page lets go --
/// `page_agreed_to_close` finishes the job then. Staying keeps the tab.
/// Closes the engine makes on its own (sleep, discard, deleting a workspace
/// or a profile, quitting) stay forced and go through `close_tab`.
pub(crate) fn request_tab_close(
    main: &MainThread,
    app: &AppHandle<Runtime>,
    state: &AppState,
    id: TabId,
) -> AppResult<()> {
    let asked = lock(&state.host)
        .as_mut()
        .is_some_and(|host| host.request_close(id));
    if asked {
        return Ok(());
    }
    close_tab_as_asked(main, app, state, id)
}

/// The page in view `label` agreed to close (or was closed by force). Only a
/// close `request_tab_close` asked for, from that very view, takes the tab.
pub(crate) fn page_agreed_to_close(app: &AppHandle<Runtime>, id: TabId, label: &str) {
    use tauri::Manager as _;
    let Some(main) = MainThread::here() else {
        tracing::warn!(%id, "a page's close arrived off the main thread");
        return;
    };
    let state = app.state::<AppState>();
    let asked = lock(&state.host)
        .as_mut()
        .is_some_and(|host| host.take_close_request(id, label));
    if !asked {
        return;
    }
    if let Err(e) = close_tab_as_asked(&main, app, &state, id) {
        tracing::warn!(%id, "closing a tab its page let go of failed: {e}");
    }
}

/// Close a tab the person asked to close, and in a private window close the
/// window once no tab is left in it.
fn close_tab_as_asked(
    main: &MainThread,
    app: &AppHandle<Runtime>,
    state: &AppState,
    id: TabId,
) -> AppResult<()> {
    use tauri::Manager as _;
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
}

/// Close `id`: destroy its view (and its window, if it had one of its own),
/// forget it, and move on to the workspace's previous tab if it was showing.
pub fn close_tab(
    main: &MainThread,
    app: &AppHandle<Runtime>,
    state: &AppState,
    id: TabId,
) -> AppResult<()> {
    forget_tab_state(app, state, id);
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
    state.bus.publish(CoreEvent::TabClosed(id));
    // Picked in its own statement so the store guard is released before
    // `activate_tab` takes the store again. Inside an `if let` chain the
    // guard lives through the body, and the second lock never returns:
    // closing the active tab froze the main thread. A tab in a window of its
    // own cannot take the main window's place.
    let detached = lock(&state.host)
        .as_ref()
        .map_or_else(Vec::new, crate::engine::TabHost::detached);
    let next = match workspace {
        Some(ws) if was_active => lock(&state.store).last_active_tab(ws, &detached)?,
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
    show_tab(&app, id)
}

/// `activate_tab` from any thread: hops to the main thread first.
pub(crate) fn show_tab(app: &AppHandle<Runtime>, id: TabId) -> AppResult<()> {
    on_main(app, move |main, app, state| {
        activate_tab(main, app, state, id)
    })
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

/// Put `id` on screen and give its page the keyboard, then say so.
///
/// The eyedropper needs both: Chromium reads the pixels it is painting, so a
/// hidden tab has none, and it refuses to open a picker for an unfocused
/// frame. Clicking the dock's button leaves focus in the chrome webview, so
/// without this the picker would abort the moment it opened.
pub(crate) fn focus_page(app: &AppHandle<Runtime>, id: TabId) -> AppResult<()> {
    on_main(app, move |main, app, state| {
        activate_tab(main, app, state, id)?;
        let mut host = lock(&state.host);
        let host = host
            .as_mut()
            .ok_or_else(|| AppError::new("engine not ready"))?;
        host.focus_page(id).map_err(AppError::new)
    })
}

/// Show `id` (recreating its view if it was discarded), persist it as the
/// active tab and announce the change.
pub fn activate_tab(
    main: &MainThread,
    app: &AppHandle<Runtime>,
    state: &AppState,
    id: TabId,
) -> AppResult<()> {
    // Lock order everywhere: host, then store. The host is held throughout,
    // which closes the window in which a concurrent `tab_close` could delete
    // the row while we recreate its view (it needs the host first). The store
    // is taken only for the reads, and again for the writes: creating the
    // native view is the slow part, and holding the store across it stalled
    // every history, favicon and feed write in the process for the duration.
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
        let (mut tab, container) = {
            let store = lock(&state.store);
            let tab = store.tab(id)?;
            let container = if host.has(id) {
                None
            } else {
                let ws = tab
                    .workspace_id
                    .or(*lock(&state.active_workspace))
                    .ok_or_else(|| AppError::new("tab has no workspace"))?;
                Some(store.container(store.workspace(ws)?.container_id)?)
            };
            (tab, container)
        };
        if let Some(container) = container {
            host.open(main, app, &tab, &container)?;
            crate::housekeeping::restore_scroll(app.clone(), id);
        }
        host.activate(main, id)?;
        // A tab whose renderer crashed while it was in the background was
        // left for now; shown, it is reloaded.
        let _ = host.with_view(id, |view| {
            crate::crash::reload_if_deferred(&state.crashes, id, view)
        });
        let woke = tab.state != dive_core::TabState::Active;
        tab.last_active_at = dive_core::Timestamp::now();
        tab.state = dive_core::TabState::Active;
        {
            let store = lock(&state.store);
            store.upsert_tab(&tab)?;
            store.set_setting(crate::state::ACTIVE_TAB, &id.to_string())?;
            // Remembered for the workspace it is shown in, so switching back
            // lands here -- an essential in the workspace it was opened from.
            let shown_in = if tab.tier == dive_core::TabTier::Essential {
                *lock(&state.active_workspace)
            } else {
                tab.workspace_id
            };
            if let Some(workspace) = shown_in {
                store.set_setting(&workspace_tab_key(workspace), &id.to_string())?;
            }
        }
        woke.then_some(tab)
    };
    // Only a tab that woke has changed in a way anyone draws. When it was
    // last focused is the store's business, for the idle sweep; announcing
    // that sent the whole tab to the chrome on every switch for nothing.
    if let Some(tab) = tab {
        state.bus.publish(CoreEvent::TabUpserted(tab));
    }
    state.bus.publish(CoreEvent::TabActivated(id));
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn tab_navigate(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: TabId,
    url: String,
) -> AppResult<()> {
    let url = normalize_url_with(&url, state.prefs.get(&state).search_template())?;
    // Another app's link typed into the bar is asked about straight away.
    // Sent through the engine, the question would name the page on screen
    // as the one asking, and "always" would be remembered for that site.
    if crate::external_link::is_external(&url) {
        crate::external_link::intercept(&app, id, &url, "");
        return Ok(());
    }
    if rebuild_failed_protocol(&app, &state, id, Some(url.as_str().to_owned()))? {
        return Ok(());
    }
    let host = lock(&state.host);
    host.as_ref()
        .ok_or_else(|| AppError::new("engine not ready"))?
        .navigate(id, url)?;
    Ok(())
}

/// Float this tab's video over everything else, or bring it back.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_picture_in_picture(
    state: State<'_, AppState>,
    id: TabId,
) -> AppResult<String> {
    let session = lock(&state.host)
        .as_ref()
        .and_then(|host| host.cdp(id))
        .ok_or_else(|| AppError::new("no devtools session"))?;
    Ok(crate::pip::describe(&crate::pip::toggle(&session).await).to_owned())
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
        let moved: Vec<(TabId, i32)> = tabs
            .iter()
            .enumerate()
            .map(|(i, tab)| (tab, i32::try_from(i).unwrap_or(i32::MAX)))
            .filter(|(tab, position)| tab.position != *position)
            .map(|(tab, position)| (tab.id, position))
            .collect();
        if moved.is_empty() {
            return Ok(());
        }
        store.set_tab_positions(&moved)?;
        tabs.into_iter().map(|tab| tab.id).collect::<Vec<_>>()
    };
    // The whole order in one event. A tab per tab that moved sent every one
    // of them, favicon and all, and re-rendered the strip once for each.
    state.bus.publish(CoreEvent::TabsReordered {
        workspace_id,
        ids: updated,
    });
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
    go_back(&state, id)
}

/// Step a tab's page back in its history.
pub(crate) fn go_back(state: &AppState, id: TabId) -> AppResult<()> {
    with_view(state, id, tauri::Webview::go_back)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn tab_forward(state: State<'_, AppState>, id: TabId) -> AppResult<()> {
    go_forward(&state, id)
}

/// Step a tab's page forward in its history.
pub(crate) fn go_forward(state: &AppState, id: TabId) -> AppResult<()> {
    with_view(state, id, tauri::Webview::go_forward)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn tab_reload(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: TabId,
) -> AppResult<()> {
    if rebuild_failed_protocol(&app, &state, id, None)? {
        return Ok(());
    }
    with_view(&state, id, tauri::Webview::reload)
}

/// Reload `id` without the HTTP cache, as ⌘⇧R does in every browser: a
/// stale stylesheet or script is fetched again instead of served from disk.
/// A tab with no debugging session yet (still being created) gets a plain
/// reload.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_reload_hard(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: TabId,
) -> AppResult<()> {
    if rebuild_failed_protocol(&app, &state, id, None)? {
        return Ok(());
    }
    let session = lock(&state.host).as_ref().and_then(|host| host.cdp(id));
    match session {
        Some(session) => session
            .call("Page.reload", serde_json::json!({ "ignoreCache": true }))
            .await
            .map(|_| ())
            .map_err(AppError::new),
        None => with_view(&state, id, tauri::Webview::reload),
    }
}

pub(crate) fn rebuild_failed_protocol(
    app: &AppHandle<Runtime>,
    state: &AppState,
    id: TabId,
    url: Option<String>,
) -> AppResult<bool> {
    if !lock(&state.host)
        .as_ref()
        .is_some_and(|host| host.needs_protocol_rebuild(id))
    {
        return Ok(false);
    }
    on_main(app, move |main, app, state| {
        let mut host = lock(&state.host);
        let host = host
            .as_mut()
            .ok_or_else(|| AppError::new("engine not ready"))?;
        if !host.needs_protocol_rebuild(id) {
            return Ok(false);
        }
        let (mut tab, container) = {
            let store = lock(&state.store);
            let tab = store.tab(id)?;
            let workspace = tab
                .workspace_id
                .or(*lock(&state.active_workspace))
                .ok_or_else(|| AppError::new("tab has no workspace"))?;
            let container = store.container(store.workspace(workspace)?.container_id)?;
            (tab, container)
        };
        if let Some(url) = url {
            tab.url = url;
        }
        host.rebuild_protocol_view(main, app, &tab, &container)?;
        Ok(true)
    })
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

/// Zoom levels the chrome steps through; `1.0` is the default.
pub const ZOOM_STEPS: &[f64] = &[
    0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0,
];

/// Set a tab's zoom factor (clamped to the step range).
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_zoom(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: TabId,
    factor: f64,
) -> AppResult<()> {
    let factor = factor.clamp(ZOOM_STEPS[0], ZOOM_STEPS[ZOOM_STEPS.len() - 1]);
    with_view(&state, id, |v| v.set_zoom(factor))?;
    // Zoom is a per-site preference, as in every browser: remember it for
    // the origin so the next visit opens at the same size.
    let url = lock(&state.store)
        .tab(id)
        .map(|t| t.url)
        .unwrap_or_default();
    if let Some(origin) = dive_core::origin_of(&url) {
        let key = format!("{}{origin}", crate::site_zoom::SITE_ZOOM_PREFIX);
        // Before the store guard: a cold preferences cache reads the store,
        // and that second lock on this thread would never return.
        let default_zoom = state.prefs.snapshot(&state).default_zoom;
        let store = lock(&state.store);
        let remembered = if (factor - default_zoom).abs() < f64::EPSILON {
            store.remove_setting(&key)?;
            None
        } else {
            store.set_setting(&key, &factor.to_string())?;
            Some(factor)
        };
        drop(store);
        crate::site_zoom::cache().remember(&origin, remembered);
    }
    // The engine keeps zoom per host, so every open tab of this host just
    // changed size too; each is set explicitly all the same, since a tab in
    // another container does not share the engine's level. Every chrome is
    // told, this tab's included: the one that asked already knows, but a
    // popout or the main window showing a sibling did not, and kept a stale
    // badge.
    for tab_id in same_host_tabs(&state, id, &url) {
        if tab_id != id && with_view(&state, tab_id, |v| v.set_zoom(factor)).is_err() {
            continue;
        }
        let _ = crate::engine::TabZoom { tab_id, factor }.emit(&app);
    }
    Ok(())
}

/// `id` and every other tab with a live view whose page is on `url`'s host.
fn same_host_tabs(state: &AppState, id: TabId, url: &str) -> Vec<TabId> {
    let Some(host) = crate::site_zoom::host_of(url) else {
        return vec![id];
    };
    let live: Vec<TabId> = lock(&state.host)
        .as_ref()
        .map(|h| h.sessions().into_iter().map(|(tab, _)| tab).collect())
        .unwrap_or_default();
    let store = lock(&state.store);
    let mut tabs = vec![id];
    tabs.extend(live.into_iter().filter(|tab| {
        *tab != id
            && store
                .tab(*tab)
                .is_ok_and(|t| crate::site_zoom::host_of(&t.url).as_deref() == Some(host.as_str()))
    }));
    tabs
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

/// Why a tab cannot move to `target`, or `None` when it can. A tab moves
/// between the workspaces of its own profile that share its cookie jar: the
/// live page is signed in with that jar, and carrying it into another would
/// show one set of logins under another's name. An essential is already in
/// every workspace.
fn move_refusal(tab: &Tab, source: Option<&Workspace>, target: &Workspace) -> Option<&'static str> {
    if tab.tier == dive_core::TabTier::Essential {
        return Some("an essential is already in every workspace");
    }
    let source = source?;
    if source.profile_id != target.profile_id {
        return Some("a tab can only move to a workspace of its own profile");
    }
    if source.container_id != target.container_id {
        return Some(
            "that workspace keeps its own cookies and logins; open the page there instead",
        );
    }
    None
}

/// Move a tab into another workspace of its profile, at the end of that
/// workspace's strip. A tab on screen leaves the screen, and the workspace
/// it left shows the tab it would on switching to it.
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_move_to_workspace(
    app: AppHandle<Runtime>,
    id: TabId,
    workspace: WorkspaceId,
) -> AppResult<()> {
    on_main(&app, move |main, app, state| {
        // Host before store, as everywhere.
        let (tab, from, was_showing, previous) = {
            let host = lock(&state.host);
            let store = lock(&state.store);
            let mut tab = store.tab(id)?;
            if tab.workspace_id == Some(workspace) {
                return Ok(());
            }
            let target = store.workspace(workspace)?;
            let source = tab
                .workspace_id
                .map(|from| store.workspace(from))
                .transpose()?;
            if let Some(reason) = move_refusal(&tab, source.as_ref(), &target) {
                return Err(AppError::new(reason));
            }
            let end = store
                .tabs_for_workspace(workspace)?
                .iter()
                .filter(|t| t.workspace_id == Some(workspace))
                .map(|t| t.position)
                .max()
                .map_or(0, |p| p + 1);
            let from = tab.workspace_id;
            tab.workspace_id = Some(workspace);
            tab.position = end;
            store.upsert_tab(&tab)?;
            let (was_showing, previous) = host.as_ref().map_or((false, None), |host| {
                (
                    !host.is_detached(id) && host.showing().contains(&id),
                    host.active(),
                )
            });
            (tab, from, was_showing, previous)
        };
        state.bus.publish(CoreEvent::TabUpserted(tab));
        if !was_showing {
            return Ok(());
        }
        // The page belongs to another workspace now; the main window shows
        // what this one would, the tab that was in front if that was not it.
        if let Some(host) = lock(&state.host).as_mut() {
            host.deactivate_all()?;
        }
        let next = match (previous, from) {
            (Some(active), _) if active != id => Some(active),
            (_, Some(from)) => {
                let detached = lock(&state.host)
                    .as_ref()
                    .map_or_else(Vec::new, crate::engine::TabHost::detached);
                workspace_tab_to_show(&lock(&state.store), from, &detached)?
            }
            _ => None,
        };
        if let Some(next) = next {
            activate_tab(main, app, state, next)?;
        }
        Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_burst_of_background_links_opens_asleep() {
        let burst = super::Burst::new();
        let start = std::time::Instant::now();
        for n in 0..5 {
            assert!(
                !burst.burst(start + std::time::Duration::from_millis(n * 100)),
                "the first few load at once"
            );
        }
        assert!(burst.burst(start + std::time::Duration::from_secs(1)));
        // Once the burst is over, a link opened behind loads again.
        assert!(!burst.burst(start + std::time::Duration::from_secs(30)));
    }

    #[test]
    fn a_tab_moves_only_where_its_page_keeps_its_logins() {
        let store = dive_core::Store::in_memory().unwrap();
        let profile = store.ensure_default_profile().unwrap();
        let work = Workspace::new("Work", profile.container_id, profile.id, 0);
        let play = Workspace::new("Play", profile.container_id, profile.id, 1);
        let sealed_jar = dive_core::Container::new("Sealed");
        store.upsert_container(&sealed_jar).unwrap();
        let sealed = Workspace::new("Sealed", sealed_jar.id, profile.id, 2);
        let other_profile = dive_core::Profile::new("Other", profile.container_id, 1);
        let theirs = Workspace::new("Theirs", profile.container_id, other_profile.id, 3);
        let tab = Tab::new(work.id, "https://a.test", 0);
        assert_eq!(move_refusal(&tab, Some(&work), &play), None);
        assert!(move_refusal(&tab, Some(&work), &sealed).is_some());
        assert!(move_refusal(&tab, Some(&work), &theirs).is_some());
        let mut essential = tab.clone();
        essential.tier = dive_core::TabTier::Essential;
        assert!(move_refusal(&essential, Some(&work), &play).is_some());
    }
}
