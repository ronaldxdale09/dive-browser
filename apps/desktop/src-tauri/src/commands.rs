//! IPC surface. Every function here is a Tauri command exported to
//! TypeScript by tauri-specta, plus the events the chrome subscribes to.

// Tauri commands receive their arguments by value; that is the IPC contract.
#![allow(clippy::needless_pass_by_value)]

use dive_core::{Command, CommandScope, CoreEvent, Tab, TabId, Workspace, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::{AppHandle, State};
use tauri_specta::{Event, collect_commands, collect_events};

use crate::Runtime;
use crate::engine::Bounds;
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
}

/// Build the specta command/event collection.
pub fn specta_builder() -> tauri_specta::Builder<Runtime> {
    tauri_specta::Builder::<Runtime>::new()
        .commands(collect_commands![
            snapshot,
            workspace_activate,
            workspace_create,
            workspace_update,
            workspace_delete,
            tab_open,
            tab_close,
            tab_activate,
            tab_navigate,
            tab_back,
            tab_forward,
            tab_reload,
            tab_capture,
            tab_emulate,
            tab_media,
            layout_set_content_bounds,
            commands_list,
            command_run,
        ])
        .events(collect_events![
            StateChanged,
            crate::console::ConsoleEntry,
            crate::network::NetworkEvent
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
        (
            "palette.open",
            "Command palette",
            Some("mod+k"),
            CommandScope::Global,
        ),
        (
            "sidecar.toggle",
            "Toggle agent sidecar",
            Some("mod+j"),
            CommandScope::Global,
        ),
        (
            "dock.toggle",
            "Toggle dev dock",
            Some("mod+shift+d"),
            CommandScope::Global,
        ),
        (
            "capture.fullpage",
            "Capture full page",
            Some("mod+shift+s"),
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
    let store = lock(&state.store);
    let active_workspace = *lock(&state.active_workspace);
    let tabs = match active_workspace {
        Some(id) => store.tabs_for_workspace(id)?,
        None => Vec::new(),
    };
    let active_tab = lock(&state.host)
        .as_ref()
        .and_then(super::engine::TabHost::active);
    Ok(Snapshot {
        workspaces: store.workspaces()?,
        active_workspace,
        tabs,
        active_tab,
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
        store.workspace(id)?;
        store.set_setting(crate::state::ACTIVE_WORKSPACE, &id.to_string())?;
        store.last_active_tab(id)?
    };
    *lock(&state.active_workspace) = Some(id);
    if let Some(host) = lock(&state.host).as_mut() {
        host.deactivate_all()?;
    }
    state.bus.publish(CoreEvent::WorkspaceActivated(id));
    if let Some(tab) = last {
        activate_tab(&app, &state, tab.id)?;
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
    let workspace = {
        let store = lock(&state.store);
        let container = if separate_container {
            let c = dive_core::Container::new(&name);
            store.upsert_container(&c)?;
            c.id
        } else {
            store
                .containers()?
                .into_iter()
                .next()
                .ok_or_else(|| AppError::new("no container"))?
                .id
        };
        let position = i32::try_from(store.workspaces()?.len()).unwrap_or(i32::MAX);
        let mut w = Workspace::new(name, container, position);
        w.color = clean_color(&draft.color)?;
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
        let all = store.workspaces()?;
        if all.len() <= 1 {
            return Err(AppError::new("cannot delete the last workspace"));
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

#[tauri::command]
#[specta::specta]
pub(crate) fn tab_open(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    workspace_id: WorkspaceId,
    url: String,
) -> AppResult<Tab> {
    open_tab(&app, &state, workspace_id, &url)
}

/// Create, persist, show and announce a new tab. Shared by the IPC command
/// and startup URL handling.
pub fn open_tab(
    app: &AppHandle<Runtime>,
    state: &AppState,
    workspace_id: WorkspaceId,
    url: &str,
) -> AppResult<Tab> {
    let url = normalize_url(url)?;
    let (tab, container) = {
        let store = lock(&state.store);
        let workspace = store.workspace(workspace_id)?;
        let container = store.container(workspace.container_id)?;
        let position =
            i32::try_from(store.tabs_for_workspace(workspace_id)?.len()).unwrap_or(i32::MAX);
        let tab = Tab::new(workspace_id, url.as_str(), position);
        store.upsert_tab(&tab)?;
        (tab, container)
    };
    {
        let mut host = lock(&state.host);
        let host = host
            .as_mut()
            .ok_or_else(|| AppError::new("engine not ready"))?;
        host.open(app, &tab, &container)?;
        host.activate(tab.id)?;
    }
    lock(&state.store).set_setting(crate::state::ACTIVE_TAB, &tab.id.to_string())?;
    state.bus.publish(CoreEvent::TabUpserted(tab.clone()));
    state.bus.publish(CoreEvent::TabActivated(tab.id));
    Ok(tab)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn tab_close(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: TabId,
) -> AppResult<()> {
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
    if was_active
        && let Some(ws) = workspace
        && let Some(next) = lock(&state.store).last_active_tab(ws)?
    {
        activate_tab(&app, &state, next.id)?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn tab_activate(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: TabId,
) -> AppResult<()> {
    activate_tab(&app, &state, id)
}

/// Show `id` (recreating its view if it was discarded), persist it as the
/// active tab and announce the change.
pub fn activate_tab(app: &AppHandle<Runtime>, state: &AppState, id: TabId) -> AppResult<()> {
    // Lock order everywhere: host, then store. Holding both here closes the
    // window in which a concurrent `tab_close` could delete the row while we
    // recreate its view.
    let tab = {
        let mut host = lock(&state.host);
        let host = host
            .as_mut()
            .ok_or_else(|| AppError::new("engine not ready"))?;
        let store = lock(&state.store);
        let mut tab = store.tab(id)?;
        if !host.has(id) {
            let ws = tab
                .workspace_id
                .or(*lock(&state.active_workspace))
                .ok_or_else(|| AppError::new("tab has no workspace"))?;
            let container = store.container(store.workspace(ws)?.container_id)?;
            host.open(app, &tab, &container)?;
        }
        host.activate(id)?;
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
    let url = normalize_url(&url)?;
    let host = lock(&state.host);
    host.as_ref()
        .ok_or_else(|| AppError::new("engine not ready"))?
        .navigate(id, url)?;
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

/// Capture `id` to `<data>/captures/dive-<timestamp>.png`.
pub async fn capture_tab(
    state: &AppState,
    id: TabId,
    full_page: bool,
) -> AppResult<std::path::PathBuf> {
    let session = cdp_for(state, id)?;
    let png = if full_page {
        dive_cdp::page::capture_full_page(&session, dive_cdp::page::ImageFormat::Png).await
    } else {
        dive_cdp::page::capture_screenshot(&session, dive_cdp::page::ScreenshotOptions::default())
            .await
    }
    .map_err(AppError::new)?;

    let dir = crate::state::data_root().join("captures");
    std::fs::create_dir_all(&dir)?;
    let stamp = dive_core::Timestamp::now()
        .to_rfc3339()
        .replace([':', '.'], "-");
    let path = dir.join(format!("dive-{stamp}.png"));
    std::fs::write(&path, png)?;
    Ok(path)
}

/// Emulate `device` on a tab, or clear emulation with `None`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_emulate(
    state: State<'_, AppState>,
    id: TabId,
    device: Option<crate::emulate::Device>,
) -> AppResult<()> {
    let session = cdp_for(&state, id)?;
    crate::emulate::apply(&session, crate::emulate::device_calls(device.as_ref())).await?;
    // Emulation only takes effect on the next layout; a reload is the cheapest way there.
    session.call0("Page.reload").await.map_err(AppError::new)?;
    Ok(())
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
    Ok(())
}

fn cdp_for(state: &AppState, id: TabId) -> AppResult<dive_cdp::CdpSession> {
    lock(&state.host)
        .as_ref()
        .and_then(|h| h.cdp(id))
        .ok_or_else(|| AppError::new("no devtools session for this tab"))
}

fn with_view(
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
pub(crate) fn layout_set_content_bounds(
    state: State<'_, AppState>,
    bounds: Bounds,
) -> AppResult<()> {
    if let Some(host) = lock(&state.host).as_mut() {
        host.set_bounds(bounds)?;
    }
    Ok(())
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
pub fn normalize_url(input: &str) -> AppResult<url::Url> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AppError::new("empty url"));
    }
    if let Ok(url) = url::Url::parse(trimmed)
        && matches!(
            url.scheme(),
            "http" | "https" | "file" | "about" | "data" | "blob"
        )
    {
        return Ok(url);
    }
    let looks_like_host = !trimmed.contains(' ')
        && (trimmed.contains('.')
            || trimmed.starts_with("localhost")
            || trimmed.starts_with("127."));
    if looks_like_host {
        return url::Url::parse(&format!("http://{trimmed}")).map_err(Into::into);
    }
    let mut search = url::Url::parse("https://duckduckgo.com/")?;
    search.query_pairs_mut().append_pair("q", trimmed);
    Ok(search)
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
            "http://example.com/"
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
        assert!(std::path::Path::new(path).exists());
    }
}
