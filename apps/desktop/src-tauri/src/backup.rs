//! Everything Dive knows, in one file you own.
//!
//! Not sync -- there is no server here and no account -- but the thing sync
//! is usually wanted for: getting a browser's life onto another machine, or
//! back after a reinstall. One JSON file holds bookmarks, history, form
//! entries, preferences and the open tabs of every workspace; restoring
//! merges it into the profile rather than replacing it, so importing the same
//! file twice leaves one of everything.
//!
//! Saved passwords are deliberately absent. They live in the Keychain, and a
//! file on disk is exactly where they should not be; Settings › Passwords
//! exports them separately, on purpose, with the warning that deserves.

use dive_core::{ProfileId, Store, Tab, TabState, Timestamp, Workspace};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// The format this build writes. A file from a newer build is refused rather
/// than half-read.
pub const VERSION: u32 = 1;
/// Most history rows a backup carries.
const HISTORY_LIMIT: usize = 100_000;
/// Refuse a file bigger than this rather than trying to parse it.
pub const MAX_BYTES: usize = 128 * 1024 * 1024;

/// One saved page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct BackupBookmark {
    pub url: String,
    pub title: String,
    pub created_at: String,
}

/// One page that was visited.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct BackupVisit {
    pub url: String,
    pub title: String,
    pub last_visited_at: String,
}

/// One remembered form field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct BackupFormEntry {
    pub field: String,
    pub value: String,
}

/// One workspace and the tabs it had open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct BackupWorkspace {
    pub name: String,
    pub color: String,
    pub icon: String,
    pub tabs: Vec<BackupTab>,
}

/// One open tab.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct BackupTab {
    pub url: String,
    pub title: String,
}

/// A whole profile, as a file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Backup {
    pub version: u32,
    /// When it was written, and by which build.
    pub exported_at: String,
    pub app_version: String,
    /// Preferences, as the stored blob.
    pub preferences: Option<String>,
    pub bookmarks: Vec<BackupBookmark>,
    pub history: Vec<BackupVisit>,
    pub form_entries: Vec<BackupFormEntry>,
    pub workspaces: Vec<BackupWorkspace>,
}

/// What a restore actually added.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RestoreSummary {
    pub bookmarks: u32,
    pub history: u32,
    pub form_entries: u32,
    pub workspaces: u32,
    pub tabs: u32,
    /// Preferences were taken from the file.
    pub preferences: bool,
}

/// Gather everything worth keeping from the active profile.
pub fn export(state: &AppState) -> AppResult<Backup> {
    let store = lock(&state.store);
    let profile = crate::commands::active_profile(&store, *lock(&state.active_workspace))?;
    let workspaces = store
        .workspaces()?
        .into_iter()
        .map(|workspace| {
            let tabs = store
                .tabs_for_workspace(workspace.id)?
                .into_iter()
                // Essentials belong to every workspace; keeping them once
                // each would multiply them on every restore.
                .filter(|tab| tab.workspace_id == Some(workspace.id))
                .filter(|tab| is_keepable(&tab.url))
                .map(|tab| BackupTab {
                    url: tab.url,
                    title: tab.title,
                })
                .collect();
            Ok(BackupWorkspace {
                name: workspace.name,
                color: workspace.color,
                icon: workspace.icon,
                tabs,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok(Backup {
        version: VERSION,
        exported_at: Timestamp::now().to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        preferences: store.setting(crate::prefs::KEY).ok().flatten(),
        bookmarks: store
            .all_bookmarks()?
            .into_iter()
            .map(|bookmark| BackupBookmark {
                url: bookmark.url,
                title: bookmark.title,
                created_at: bookmark.created_at,
            })
            .collect(),
        history: store
            .all_history(HISTORY_LIMIT)?
            .into_iter()
            .map(|entry| BackupVisit {
                url: entry.url,
                title: entry.title,
                last_visited_at: entry.last_visited_at,
            })
            .collect(),
        form_entries: store
            .form_entries(profile.id)?
            .into_iter()
            .map(|entry| BackupFormEntry {
                field: entry.field,
                value: entry.value,
            })
            .collect(),
        workspaces,
    })
}

/// Whether a tab address is worth writing down: a page, not a blank view or
/// one of Dive's own screens, which every install has already.
pub fn is_keepable(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|parsed| matches!(parsed.scheme(), "http" | "https" | "file"))
}

/// Read a backup, refusing anything this build cannot understand.
pub fn parse(text: &str) -> AppResult<Backup> {
    if text.len() > MAX_BYTES {
        return Err(AppError::new("that backup is too large to read"));
    }
    let backup: Backup = serde_json::from_str(text)
        .map_err(|error| AppError::new(format!("that is not a Dive backup: {error}")))?;
    if backup.version > VERSION {
        return Err(AppError::new(
            "that backup was written by a newer version of Dive",
        ));
    }
    Ok(backup)
}

/// Merge a backup into the active profile and say what it added.
///
/// Merging, never replacing: nothing already here is removed, and an address
/// that is already bookmarked or already open is left alone, so restoring the
/// same file twice is the same as restoring it once.
pub fn restore(
    store: &Store,
    profile: ProfileId,
    backup: &Backup,
    take_preferences: bool,
) -> AppResult<RestoreSummary> {
    let mut summary = RestoreSummary::default();
    let now = Timestamp::now();

    let existing: std::collections::HashSet<String> = store
        .all_bookmarks()?
        .into_iter()
        .map(|bookmark| bookmark.url)
        .collect();
    for bookmark in &backup.bookmarks {
        if !is_keepable(&bookmark.url) || existing.contains(&bookmark.url) {
            continue;
        }
        let at = Timestamp::parse(&bookmark.created_at).unwrap_or(now);
        store.add_bookmark(&bookmark.url, &bookmark.title, at)?;
        summary.bookmarks += 1;
    }

    for visit in &backup.history {
        if !is_keepable(&visit.url) {
            continue;
        }
        let at = Timestamp::parse(&visit.last_visited_at).unwrap_or(now);
        store.record_visit(&visit.url, &visit.title, at)?;
        summary.history += 1;
    }

    for entry in &backup.form_entries {
        if crate::browser_import::keep_form_entry(&entry.field, &entry.value) {
            store.record_form_entry(profile, &entry.field, &entry.value, now)?;
            summary.form_entries += 1;
        }
    }

    let known: std::collections::HashSet<String> = store
        .workspaces()?
        .into_iter()
        .map(|workspace| workspace.name)
        .collect();
    for workspace in &backup.workspaces {
        if known.contains(&workspace.name) {
            continue;
        }
        let owner = store.profile(profile)?;
        let position =
            i32::try_from(store.workspaces_for_profile(profile)?.len()).unwrap_or(i32::MAX);
        let mut created = Workspace::new(
            workspace.name.clone(),
            owner.container_id,
            profile,
            position,
        );
        created.color.clone_from(&workspace.color);
        created.icon.clone_from(&workspace.icon);
        store.upsert_workspace(&created)?;
        summary.workspaces += 1;
        for (index, tab) in workspace.tabs.iter().enumerate() {
            if !is_keepable(&tab.url) {
                continue;
            }
            let mut restored = Tab::new(
                created.id,
                tab.url.clone(),
                i32::try_from(index).unwrap_or(i32::MAX),
            );
            restored.title.clone_from(&tab.title);
            // Restored tabs arrive asleep: a backup with fifty tabs must not
            // start fifty renderers on the machine it lands on.
            restored.state = TabState::Discarded;
            store.upsert_tab(&restored)?;
            summary.tabs += 1;
        }
    }

    if take_preferences && let Some(preferences) = &backup.preferences {
        store.set_setting(crate::prefs::KEY, preferences)?;
        summary.preferences = true;
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_pages_and_leaves_dives_own_screens_behind() {
        assert!(is_keepable("https://example.com"));
        assert!(is_keepable("http://localhost:3000"));
        assert!(is_keepable("file:///Users/me/notes.html"));
        // Restoring these on another machine would mean nothing.
        assert!(!is_keepable("about:blank"));
        assert!(!is_keepable("dive://settings"));
        assert!(!is_keepable(""));
        assert!(!is_keepable("not a url"));
    }

    #[test]
    fn refuses_a_file_it_cannot_understand() {
        assert!(parse("not json").is_err());
        let newer = serde_json::json!({
            "version": VERSION + 1, "exported_at": "", "app_version": "9.9.9",
            "preferences": null, "bookmarks": [], "history": [], "form_entries": [], "workspaces": []
        });
        let error = parse(&newer.to_string()).unwrap_err();
        assert!(format!("{error:?}").contains("newer version"), "{error:?}");
        assert!(parse(&"x".repeat(MAX_BYTES + 1)).is_err());
    }

    #[test]
    fn reads_a_file_this_build_wrote() {
        let backup = Backup {
            version: VERSION,
            exported_at: "2026-09-15T00:00:00Z".into(),
            app_version: "0.1.26".into(),
            preferences: Some("{}".into()),
            bookmarks: vec![BackupBookmark {
                url: "https://example.com".into(),
                title: "Example".into(),
                created_at: "2026-09-01T00:00:00Z".into(),
            }],
            history: vec![],
            form_entries: vec![],
            workspaces: vec![BackupWorkspace {
                name: "Work".into(),
                color: "#fff".into(),
                icon: "briefcase".into(),
                tabs: vec![BackupTab {
                    url: "https://example.com/a".into(),
                    title: "A".into(),
                }],
            }],
        };
        let text = serde_json::to_string(&backup).unwrap();
        assert_eq!(parse(&text).unwrap(), backup);
    }
}
