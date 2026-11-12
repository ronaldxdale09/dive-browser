//! Workspace and profile commands, and the state they tear down.

// Tauri commands receive their arguments by value; that is the IPC contract.
#![allow(clippy::needless_pass_by_value)]

use dive_core::{CoreEvent, Tab, TabId, Workspace, WorkspaceId};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, State};

use super::{activate_tab, on_main};
use crate::Runtime;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

#[tauri::command]
#[specta::specta]
pub(crate) fn workspace_activate(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: WorkspaceId,
) -> AppResult<()> {
    // Host before store, and released before it: the main thread takes them
    // in that order.
    let detached = lock(&state.host)
        .as_ref()
        .map_or_else(Vec::new, crate::engine::TabHost::detached);
    let next = {
        let store = lock(&state.store);
        let w = store.workspace(id)?;
        store.set_setting(crate::state::ACTIVE_WORKSPACE, &id.to_string())?;
        // Remembered per profile, so switching back to a profile lands on
        // the workspace it was last in.
        store.set_setting(&profile_workspace_key(w.profile_id), &id.to_string())?;
        workspace_tab_to_show(&store, id, &detached)?
    };
    *lock(&state.active_workspace) = Some(id);
    // Hiding the old workspace's views is native view work too, so it makes
    // the same hop as showing the new one; off the main thread it raced the
    // engine's own view changes.
    on_main(&app, move |main, app, state| {
        if let Some(host) = lock(&state.host).as_mut() {
            host.deactivate_all()?;
        }
        state.bus.publish(CoreEvent::WorkspaceActivated(id));
        if let Some(next) = next {
            activate_tab(main, app, state, next)?;
        }
        Ok(())
    })
}

/// How many tabs a workspace holds, for the rail.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WorkspaceTabs {
    /// The workspace.
    pub workspace_id: WorkspaceId,
    /// Open tabs in it, including discarded tabs.
    pub tabs: u32,
}

/// Open tab count of every workspace, including discarded tabs. The snapshot carries the active
/// workspace's tabs, so the rail asks for the rest separately.
#[tauri::command]
#[specta::specta]
pub(crate) fn workspace_tab_counts(state: State<'_, AppState>) -> AppResult<Vec<WorkspaceTabs>> {
    Ok(lock(&state.store)
        .tab_counts()?
        .into_iter()
        .map(|(workspace_id, tabs)| WorkspaceTabs { workspace_id, tabs })
        .collect())
}

/// The tabs of every workspace but the active one, so the palette can find a
/// tab wherever it lives. The snapshot carries only the active workspace's,
/// with the essentials, which show in every workspace and are left out here.
#[tauri::command]
#[specta::specta]
pub(crate) fn workspace_other_tabs(state: State<'_, AppState>) -> AppResult<Vec<Tab>> {
    let active = *lock(&state.active_workspace);
    other_workspace_tabs(&lock(&state.store), active)
}

fn other_workspace_tabs(
    store: &dive_core::Store,
    active: Option<WorkspaceId>,
) -> AppResult<Vec<Tab>> {
    let mut tabs = Vec::new();
    for workspace in store.workspaces()? {
        if Some(workspace.id) == active {
            continue;
        }
        tabs.extend(
            store
                .tabs_for_workspace(workspace.id)?
                .into_iter()
                .filter(|tab| tab.workspace_id == Some(workspace.id)),
        );
    }
    Ok(tabs)
}

/// Persist a new rail order. Ids not listed keep their relative order after
/// the listed ones, so a reorder never has to name every workspace.
#[tauri::command]
#[specta::specta]
pub(crate) fn workspace_reorder(
    state: State<'_, AppState>,
    ordered: Vec<WorkspaceId>,
) -> AppResult<()> {
    let updated = {
        let store = lock(&state.store);
        let mut workspaces = store.workspaces()?;
        workspaces.sort_by_key(|w| {
            ordered
                .iter()
                .position(|id| *id == w.id)
                .unwrap_or(usize::MAX)
        });
        let mut updated = Vec::new();
        for (i, workspace) in workspaces.iter_mut().enumerate() {
            let position = i32::try_from(i).unwrap_or(i32::MAX);
            if workspace.position != position {
                workspace.position = position;
                store.upsert_workspace(workspace)?;
                updated.push(workspace.clone());
            }
        }
        updated
    };
    for workspace in updated {
        state.bus.publish(CoreEvent::WorkspaceUpserted(workspace));
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
    /// Icon identifier the chrome resolves to a glyph.
    pub icon: String,
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
    // Validate every user field before creating a separate container. A bad
    // color or icon must not leave an orphan profile row behind.
    let color = clean_color(&draft.color)?;
    let icon = clean_icon(&draft.icon)?;
    let workspace = {
        let store = lock(&state.store);
        // A new workspace joins the profile you are in and browses in that
        // profile's container, unless it asks for cookies of its own.
        let profile = active_profile(&store, *lock(&state.active_workspace))?;
        let container = if separate_container {
            let c = dive_core::Container::new(&name);
            store.upsert_container(&c)?;
            c.id
        } else {
            profile.container_id
        };
        let position =
            i32::try_from(store.workspaces_for_profile(profile.id)?.len()).unwrap_or(i32::MAX);
        let mut w = Workspace::new(name, container, profile.id, position);
        w.color = color;
        w.icon = icon;
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
        w.icon = clean_icon(&draft.icon)?;
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
    let (tab_ids, next, container) = {
        let store = lock(&state.store);
        let workspace = store.workspace(id)?;
        let profile = workspace.profile_id;
        let container = workspace.container_id;
        let all = store.workspaces_for_profile(profile)?;
        if all.len() <= 1 {
            return Err(AppError::new(
                "a profile keeps at least one workspace; delete the profile instead",
            ));
        }
        let tabs = store.tabs_for_workspace(id)?;
        let next = all.iter().find(|w| w.id != id).map(|w| w.id);
        (
            tabs.into_iter()
                .filter(|t| t.workspace_id == Some(id))
                .map(|t| t.id)
                .collect::<Vec<_>>(),
            next,
            container,
        )
    };
    close_views(&app, &state, &tab_ids);
    {
        let store = lock(&state.store);
        store.remove_workspace(id)?;
        // A workspace made with cookies of its own -- an agent's clean
        // session, an MCP context -- takes them with it. One that shares
        // its profile's container leaves it alone.
        crate::state::release_unused_containers(&store, [container])?;
    }
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

/// Close the views of tabs that are going with their workspace or profile,
/// and forget what the rest of the app kept about them.
///
/// These used to go through `host.close` alone, from the command's worker
/// thread: a recording kept its ffmpeg running, subtitles kept transcribing,
/// and every per-tab registry kept its entry for a tab that no longer
/// existed. Views are closed on the main thread, as `close_tab` closes them.
///
/// Every view is tried, and a refusal is only logged: the tabs' rows go with
/// their workspace either way, and stopping at the first refusal left the
/// rest open, the workspace in place and no `TabClosed` for any of them.
fn close_views(app: &AppHandle<Runtime>, state: &AppState, tabs: &[TabId]) {
    for tab in tabs {
        forget_tab_state(app, state, *tab);
    }
    let tabs = tabs.to_vec();
    let closed = on_main(app, move |_, _, state| {
        if let Some(host) = lock(&state.host).as_mut() {
            for tab in &tabs {
                if let Err(e) = host.close(*tab) {
                    tracing::warn!(%tab, "view of a deleted tab would not close: {e}");
                    // Forgotten all the same, so nothing keeps showing or
                    // driving a tab that no longer exists.
                    host.forget_closed(*tab);
                }
            }
        }
        Ok(())
    });
    if let Err(e) = closed {
        tracing::warn!("views of deleted tabs could not be closed: {e}");
    }
}

/// Forget everything kept about tab `id` outside the host and the store:
/// its recording (saved, not thrown away), its subtitles, its buffered console and network rows, its
/// inspector picks, its crash budget, its privacy report, a sign-in prompt
/// still waiting, a certificate question, and a pending https upgrade. Every path that closes a tab
/// calls this, so none of them leaks what another path cleans up.
pub(crate) fn forget_tab_state(app: &AppHandle<Runtime>, state: &AppState, id: TabId) {
    crate::subtitles::stop_tab(app, id);
    state.screencast.finish_detached(id);
    state.buffers.drop_tab(id);
    state.inspector.drop_tab(id);
    state.crashes.drop_tab(id);
    state.privacy_pages.drop_tab(id);
    state.http_auth.forget_tab(id);
    crate::cert_error::forget_tab(app, id);
    crate::https_only::forget(id);
    crate::housekeeping::forget_unanswered(id);
}

/// Setting key remembering the last workspace of a profile.
pub(super) fn profile_workspace_key(profile: dive_core::ProfileId) -> String {
    format!("profile_workspace:{profile}")
}

/// Setting key remembering the tab last shown in a workspace. Recency alone
/// cannot say it: an essential belongs to every workspace, so one looked at
/// in another workspace since would be the "most recent" everywhere.
pub(super) fn workspace_tab_key(workspace: WorkspaceId) -> String {
    format!("workspace_tab:{workspace}")
}

/// The tab to show on switching to `workspace`: the one it was showing when
/// it was left -- an essential included -- if that is still open in the
/// main window, else its most recently used tab that is. Tabs in a window
/// of their own are passed over: activating one raises that window and left
/// the main window blank.
pub(super) fn workspace_tab_to_show(
    store: &dive_core::Store,
    workspace: WorkspaceId,
    detached: &[TabId],
) -> AppResult<Option<TabId>> {
    let remembered = store
        .setting(&workspace_tab_key(workspace))?
        .and_then(|value| value.parse::<TabId>().ok())
        .and_then(|id| store.tab(id).ok())
        .filter(|tab| {
            !detached.contains(&tab.id)
                && (tab.workspace_id == Some(workspace)
                    || tab.tier == dive_core::TabTier::Essential)
        });
    if let Some(tab) = remembered {
        return Ok(Some(tab.id));
    }
    Ok(store
        .last_active_tab(workspace, detached)?
        .map(|tab| tab.id))
}

/// The profile of the active workspace, else the first profile.
pub(crate) fn active_profile(
    store: &dive_core::Store,
    active: Option<WorkspaceId>,
) -> AppResult<dive_core::Profile> {
    if let Some(id) = active
        && let Ok(w) = store.workspace(id)
    {
        return Ok(store.profile(w.profile_id)?);
    }
    store
        .profiles()?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::new("no profile"))
}

/// What a profile is made of, from the profile dialog.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ProfileDraft {
    pub name: String,
    pub color: String,
    /// Avatar seed.
    pub avatar: String,
    pub note: String,
}

fn clean_profile(draft: &ProfileDraft) -> AppResult<(String, String, String, String)> {
    let name = clean_name(&draft.name)?;
    let color = clean_color(&draft.color)?;
    let avatar = draft.avatar.trim();
    if avatar.is_empty() || avatar.chars().count() > 64 {
        return Err(AppError::new("pick an avatar"));
    }
    let note = draft.note.trim();
    if note.chars().count() > 80 {
        return Err(AppError::new("the note is too long"));
    }
    Ok((name, color, avatar.to_owned(), note.to_owned()))
}

/// Every profile, in switcher order.
#[tauri::command]
#[specta::specta]
pub(crate) fn profiles_list(state: State<'_, AppState>) -> AppResult<Vec<dive_core::Profile>> {
    Ok(lock(&state.store).profiles()?)
}

/// Create a profile with a container of its own and a first workspace, and
/// switch to it.
#[tauri::command]
#[specta::specta]
pub(crate) fn profile_create(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    draft: ProfileDraft,
) -> AppResult<dive_core::Profile> {
    let (name, color, avatar, note) = clean_profile(&draft)?;
    let (profile, workspace) = {
        let store = lock(&state.store);
        let container = dive_core::Container::new(&name);
        store.upsert_container(&container)?;
        let position = i32::try_from(store.profiles()?.len()).unwrap_or(i32::MAX);
        let mut p = dive_core::Profile::new(name, container.id, position);
        p.color = color;
        p.avatar = avatar;
        p.note = note;
        store.upsert_profile(&p)?;
        let w = Workspace::new("Home", container.id, p.id, 0);
        store.upsert_workspace(&w)?;
        (p, w)
    };
    state
        .bus
        .publish(CoreEvent::ProfileUpserted(profile.clone()));
    state
        .bus
        .publish(CoreEvent::WorkspaceUpserted(workspace.clone()));
    workspace_activate(app, state, workspace.id)?;
    Ok(profile)
}

/// Rename or restyle a profile.
#[tauri::command]
#[specta::specta]
pub(crate) fn profile_update(
    state: State<'_, AppState>,
    id: dive_core::ProfileId,
    draft: ProfileDraft,
) -> AppResult<dive_core::Profile> {
    let (name, color, avatar, note) = clean_profile(&draft)?;
    let profile = {
        let store = lock(&state.store);
        let mut p = store.profile(id)?;
        p.name = name;
        p.color = color;
        p.avatar = avatar;
        p.note = note;
        store.upsert_profile(&p)?;
        p
    };
    state
        .bus
        .publish(CoreEvent::ProfileUpserted(profile.clone()));
    Ok(profile)
}

/// Switch to a profile: its last workspace, or its first.
#[tauri::command]
#[specta::specta]
pub(crate) fn profile_activate(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: dive_core::ProfileId,
) -> AppResult<()> {
    let target = {
        let store = lock(&state.store);
        store.profile(id)?;
        let workspaces = store.workspaces_for_profile(id)?;
        let remembered = store
            .setting(&profile_workspace_key(id))?
            .and_then(|s| s.parse::<WorkspaceId>().ok())
            .filter(|w| workspaces.iter().any(|x| x.id == *w));
        remembered
            .or_else(|| workspaces.first().map(|w| w.id))
            .ok_or_else(|| AppError::new("this profile has no workspace"))?
    };
    state.bus.publish(CoreEvent::ProfileActivated(id));
    workspace_activate(app, state, target)
}

/// Delete a profile with everything in it: its workspaces and tabs, its
/// logins and cards (keychain secrets included), its history, bookmarks and
/// form entries, and the cookies and site storage of any container nothing
/// else uses. Those folders are removed at the next launch, once the engine
/// no longer has them open. Refuses to delete the last profile; if the
/// active one goes, another takes over.
#[tauri::command]
#[specta::specta]
pub(crate) fn profile_delete(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: dive_core::ProfileId,
) -> AppResult<()> {
    let (workspaces, tab_ids, next, containers, logins, cards) = {
        let store = lock(&state.store);
        let profiles = store.profiles()?;
        if profiles.len() <= 1 {
            return Err(AppError::new("cannot delete the last profile"));
        }
        let profile = store.profile(id)?;
        let workspaces = store.workspaces_for_profile(id)?;
        let mut containers = vec![profile.container_id];
        for w in &workspaces {
            if !containers.contains(&w.container_id) {
                containers.push(w.container_id);
            }
        }
        let logins: Vec<String> = store.credentials(id)?.into_iter().map(|c| c.id).collect();
        let cards: Vec<String> = store.cards(id)?.into_iter().map(|c| c.id).collect();
        let mut tabs = Vec::new();
        for w in &workspaces {
            tabs.extend(
                store
                    .tabs_for_workspace(w.id)?
                    .into_iter()
                    .filter(|t| t.workspace_id == Some(w.id))
                    .map(|t| t.id),
            );
        }
        let next = profiles.iter().find(|p| p.id != id).map(|p| p.id);
        (workspaces, tabs, next, containers, logins, cards)
    };
    close_views(&app, &state, &tab_ids);
    let was_active = {
        let active = *lock(&state.active_workspace);
        workspaces.iter().any(|w| Some(w.id) == active)
    };
    // Secrets before rows, with no lock held: the keychain can take its
    // time. One it refuses to let go of is logged rather than keeping the
    // whole profile, which the person asked to be gone.
    if !crate::private_session::is_private() {
        for login in &logins {
            if let Err(e) = crate::passwords::delete_secret(login) {
                tracing::warn!("a deleted profile's password stayed in the keychain: {e}");
            }
        }
        for card in &cards {
            if let Err(e) = crate::autofill::delete_card_secret(card) {
                tracing::warn!("a deleted profile's card stayed in the keychain: {e}");
            }
        }
    }
    {
        let store = lock(&state.store);
        for w in &workspaces {
            store.remove_workspace(w.id)?;
        }
        store.remove_profile(id)?;
        store.remove_profile_data(id)?;
        crate::state::release_unused_containers(&store, containers)?;
    }
    for tab in tab_ids {
        state.bus.publish(CoreEvent::TabClosed(tab));
    }
    for w in &workspaces {
        state.bus.publish(CoreEvent::WorkspaceRemoved(w.id));
    }
    state.bus.publish(CoreEvent::ProfileRemoved(id));
    if was_active && let Some(next) = next {
        profile_activate(app, state, next)?;
    }
    Ok(())
}

fn clean_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 40 {
        return Err(AppError::invalid(
            "name",
            "workspace name must be 1-40 characters",
        ));
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

/// Accept an icon identifier the chrome will be able to resolve.
///
/// The name seeds the workspace's generated mark in the chrome, so any name
/// draws something and one written by an older build still works. The shape is
/// all this side can check: lowercase, dashes, and short enough that it is a
/// name rather than smuggled markup.
fn clean_icon(icon: &str) -> AppResult<String> {
    let name = icon.trim().to_ascii_lowercase();
    if name.is_empty() {
        return Ok(Workspace::default_icon().to_owned());
    }
    if name.len() <= 32 && name.chars().all(|c| c.is_ascii_lowercase() || c == '-') {
        Ok(name)
    } else {
        Err(AppError::new("icon must be a lowercase icon name"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn other_workspace_tabs_leave_out_the_active_workspace_and_essentials() {
        let store = dive_core::Store::in_memory().unwrap();
        let profile = store.ensure_default_profile().unwrap();
        let here = Workspace::new("Here", profile.container_id, profile.id, 0);
        let there = Workspace::new("There", profile.container_id, profile.id, 1);
        store.upsert_workspace(&here).unwrap();
        store.upsert_workspace(&there).unwrap();
        store
            .upsert_tab(&Tab::new(here.id, "https://here.test", 0))
            .unwrap();
        let away = Tab::new(there.id, "https://there.test", 0);
        store.upsert_tab(&away).unwrap();
        let mut global = Tab::new(there.id, "https://global.test", 1);
        global.tier = dive_core::TabTier::Essential;
        global.workspace_id = None;
        store.upsert_tab(&global).unwrap();
        assert_eq!(
            other_workspace_tabs(&store, Some(here.id)).unwrap(),
            vec![away]
        );
    }

    #[test]
    fn a_workspace_comes_back_to_the_tab_it_showed_essentials_included() {
        let store = dive_core::Store::in_memory().unwrap();
        let profile = store.ensure_default_profile().unwrap();
        let work = Workspace::new("Work", profile.container_id, profile.id, 0);
        let play = Workspace::new("Play", profile.container_id, profile.id, 1);
        store.upsert_workspace(&work).unwrap();
        store.upsert_workspace(&play).unwrap();
        let now = dive_core::Timestamp::now();
        let mut older = Tab::new(work.id, "https://older.test", 0);
        older.last_active_at = dive_core::Timestamp(now.0 - time::Duration::hours(2));
        let mut torn_off = Tab::new(work.id, "https://torn-off.test", 1);
        torn_off.last_active_at = now;
        let mut essential = Tab::new(play.id, "https://mail.test", 0);
        essential.tier = dive_core::TabTier::Essential;
        for tab in [&older, &torn_off, &essential] {
            store.upsert_tab(tab).unwrap();
        }
        // Nothing remembered: the most recent tab the main window can show.
        assert_eq!(
            workspace_tab_to_show(&store, work.id, &[torn_off.id]).unwrap(),
            Some(older.id)
        );
        // The essential it was left on, though it belongs to another workspace.
        store
            .set_setting(&workspace_tab_key(work.id), &essential.id.to_string())
            .unwrap();
        assert_eq!(
            workspace_tab_to_show(&store, work.id, &[torn_off.id]).unwrap(),
            Some(essential.id)
        );
        // A remembered tab that went to a window of its own is passed over.
        store
            .set_setting(&workspace_tab_key(work.id), &torn_off.id.to_string())
            .unwrap();
        assert_eq!(
            workspace_tab_to_show(&store, work.id, &[torn_off.id]).unwrap(),
            Some(older.id)
        );
        // Another workspace's ordinary tab is never shown here.
        let foreign = Tab::new(play.id, "https://foreign.test", 1);
        store.upsert_tab(&foreign).unwrap();
        store
            .set_setting(&workspace_tab_key(work.id), &foreign.id.to_string())
            .unwrap();
        assert_eq!(
            workspace_tab_to_show(&store, work.id, &[]).unwrap(),
            Some(torn_off.id)
        );
    }

    #[test]
    fn validates_workspace_fields() {
        assert_eq!(clean_color(" #abc ").unwrap(), "#ABC");
        assert!(clean_color("red").is_err());
        assert!(clean_color("#12345").is_err());
        assert_eq!(clean_name("  Work ").unwrap(), "Work");
        assert!(clean_name("   ").is_err());
        assert_eq!(
            clean_name("   ").unwrap_err().kind,
            Some(crate::error::ErrorKind::Invalid {
                field: "name".into()
            }),
            "the chrome marks the name field from the kind, not from the words"
        );
        assert_eq!(clean_icon(" Book-Open ").unwrap(), "book-open");
        assert_eq!(clean_icon("  ").unwrap(), Workspace::default_icon());
        assert!(clean_icon("<img onerror=x>").is_err());
        assert!(clean_icon(&"a".repeat(33)).is_err());
    }
}
