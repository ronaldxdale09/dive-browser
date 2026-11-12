//! Clearing browsing data, now or at the next launch, and history retention.

use dive_cdp::CdpSession;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;

use crate::error::{AppError, AppResult};
use crate::prefs::MAX_HISTORY_DAYS;
use crate::state::{AppState, lock};

/// What [`clear`] should delete.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[allow(clippy::struct_excessive_bools)] // Each field is an independent clear-data checkbox.
pub struct ClearRequest {
    /// Visited pages.
    pub history: bool,
    /// Cookies of this profile's containers.
    pub cookies: bool,
    /// HTTP cache.
    pub cache: bool,
    /// `localStorage`, `sessionStorage`, `IndexedDB` and friends for the
    /// origins of open tabs.
    pub site_data: bool,
    /// Form entries remembered in the active profile.
    #[serde(default)]
    pub forms: bool,
    /// Only what happened in the last this many hours; `None` is all time.
    /// Applies to history, downloads and form entries. Chromium offers no
    /// time range for cookies, the cache or site data, so those are always
    /// cleared in full and Settings says so.
    #[serde(default)]
    pub since_hours: Option<u32>,
}

/// What [`clear`] managed, and what it could not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ClearOutcome {
    /// One sentence on what went.
    pub summary: String,
    /// What failed, one line each. Everything else was still cleared: a
    /// cache that would not clear no longer hides that history did.
    pub failures: Vec<String>,
    /// Cookies, cache or site data were cleared, and the profiles that are
    /// not open finish on the next launch.
    pub restart_needed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingClear {
    profiles: Vec<String>,
    what: ClearRequest,
}

fn pending_clear_path() -> std::path::PathBuf {
    crate::state::data_root().join("pending-browser-data-clear.json")
}

fn merge_clear(left: ClearRequest, right: ClearRequest) -> ClearRequest {
    ClearRequest {
        history: left.history || right.history,
        cookies: left.cookies || right.cookies,
        cache: left.cache || right.cache,
        site_data: left.site_data || right.site_data,
        forms: left.forms || right.forms,
        // Only cookies, cache and site data wait for a restart, and those
        // are cleared in full.
        since_hours: None,
    }
}

fn safe_profile(root: &std::path::Path, name: &str) -> AppResult<std::path::PathBuf> {
    let path = std::path::Path::new(name);
    if path.components().count() != 1
        || !matches!(
            path.components().next(),
            Some(std::path::Component::Normal(_))
        )
    {
        return Err(AppError::new("invalid browser profile path"));
    }
    Ok(root.join(path))
}

fn component_targets(profile: &std::path::Path, what: ClearRequest) -> Vec<std::path::PathBuf> {
    let mut targets = Vec::new();
    if what.cookies {
        for relative in [
            "Cookies",
            "Cookies-journal",
            "Network/Cookies",
            "Network/Cookies-journal",
        ] {
            targets.push(profile.join(relative));
        }
    }
    if what.cache {
        for relative in [
            "Cache",
            "Code Cache",
            "GPUCache",
            "Network Cache",
            "Network/Cache",
            "Shared Dictionary",
            "Service Worker/CacheStorage",
        ] {
            targets.push(profile.join(relative));
        }
    }
    if what.site_data {
        for relative in [
            "Local Storage",
            "Session Storage",
            "WebStorage",
            "IndexedDB",
            "CacheStorage",
            "File System",
            "blob_storage",
            "databases",
            "QuotaManager",
            "QuotaManager-journal",
            "Service Worker",
        ] {
            targets.push(profile.join(relative));
        }
    }
    targets.sort();
    targets.dedup();
    targets
}

/// Finish deferred profile cleanup before CEF opens or locks profile files.
///
/// Each target is moved into the trash rather than deleted here: this runs
/// on the launch path, and deleting a cache of thousands of files held the
/// window back for as long as that took. The trash is emptied in the
/// background once the store is open.
pub fn finish_pending_clear() -> AppResult<()> {
    finish_pending_clear_at(
        &pending_clear_path(),
        &crate::state::profiles_root(),
        &crate::state::trash_root(),
    )
}

/// [`finish_pending_clear`] with its locations passed in, for tests.
///
/// A file that cannot be read as a cleanup is moved aside rather than left
/// to fail every launch. A profile whose parts could not all be moved stays
/// queued, alone, for the next launch; the ones that finished are not
/// repeated.
fn finish_pending_clear_at(
    pending_path: &std::path::Path,
    root: &std::path::Path,
    trash: &std::path::Path,
) -> AppResult<()> {
    if !pending_path.exists() {
        return Ok(());
    }
    let bytes = std::fs::read(pending_path).map_err(AppError::new)?;
    let pending: PendingClear = match serde_json::from_slice(&bytes) {
        Ok(pending) => pending,
        Err(error) => {
            let aside = pending_path.with_extension("json.unreadable");
            tracing::warn!(%error, aside = %aside.display(), "setting aside an unreadable browser-data cleanup");
            std::fs::rename(pending_path, &aside).map_err(AppError::new)?;
            return Err(AppError::new(format!(
                "invalid pending browser-data cleanup, set aside as {}: {error}",
                aside.display()
            )));
        }
    };
    let mut failed = Vec::new();
    let mut first_error = None;
    for name in &pending.profiles {
        let result = safe_profile(root, name).and_then(|profile| {
            for target in component_targets(&profile, pending.what) {
                crate::state::discard_path(&target, trash).map_err(AppError::new)?;
            }
            Ok(())
        });
        if let Err(error) = result {
            tracing::warn!(profile = name, %error, "could not finish clearing a profile");
            // An unsafe name can never succeed; keeping it would only fail
            // again at every launch.
            if safe_profile(root, name).is_ok() {
                failed.push(name.clone());
            }
            first_error.get_or_insert(error);
        }
    }
    if failed.is_empty() {
        std::fs::remove_file(pending_path).map_err(AppError::new)?;
    } else {
        write_pending_clear(
            pending_path,
            &PendingClear {
                profiles: failed,
                what: pending.what,
            },
        )?;
    }
    first_error.map_or(Ok(()), Err)
}

/// Write the pending cleanup beside its path and rename it into place once
/// it is on disk, so a crash leaves the old file or the new one, never half
/// of either.
fn write_pending_clear(path: &std::path::Path, pending: &PendingClear) -> AppResult<()> {
    use std::io::Write as _;
    let tmp = path.with_extension("json.tmp");
    let mut file = std::fs::File::create(&tmp).map_err(AppError::new)?;
    file.write_all(&serde_json::to_vec_pretty(pending).map_err(AppError::new)?)
        .map_err(AppError::new)?;
    file.sync_all().map_err(AppError::new)?;
    drop(file);
    std::fs::rename(tmp, path).map_err(AppError::new)
}

fn queue_profile_clear(profiles: &[String], what: ClearRequest) -> AppResult<()> {
    let path = pending_clear_path();
    let existing = if path.exists() {
        serde_json::from_slice::<PendingClear>(&std::fs::read(&path).map_err(AppError::new)?).ok()
    } else {
        None
    };
    let mut profiles = existing.as_ref().map_or(profiles.to_owned(), |pending| {
        let mut names = pending.profiles.clone();
        names.extend_from_slice(profiles);
        names
    });
    profiles.sort();
    profiles.dedup();
    let what = existing.map_or(what, |pending| merge_clear(pending.what, what));
    write_pending_clear(&path, &PendingClear { profiles, what })
}

/// Delete the requested browsing data and describe what went.
///
/// Open profiles clear immediately through Chromium; a component cleanup is
/// also queued for the next launch before CEF locks persistent profile files.
/// A part that fails is reported and the rest still goes ahead.
pub async fn clear(state: &AppState, what: ClearRequest) -> AppResult<ClearOutcome> {
    let since = what.since_hours.and_then(|hours| {
        dive_core::Timestamp::now()
            .0
            .checked_sub(time::Duration::hours(i64::from(hours)))
            .map(dive_core::Timestamp)
    });
    let profile = {
        let store = lock(&state.store);
        crate::commands::active_profile(&store, *lock(&state.active_workspace))?.id
    };
    let (mut done, mut failures) = clear_records(state, what, since, profile);
    let containers = open_containers(state, profile);
    for (session, origins) in containers.values() {
        if what.cookies
            && let Err(error) = session.call0("Network.clearBrowserCookies").await
        {
            failures.push(format!("Cookies: {error}"));
        }
        if what.cache
            && let Err(error) = session.call0("Network.clearBrowserCache").await
        {
            failures.push(format!("Cache: {error}"));
        }
        // Every site open in the container, not only the first tab's: the
        // storage partition is the container's, so one session reaches all.
        if what.site_data {
            for origin in origins {
                if let Err(error) = session
                    .call(
                        "Storage.clearDataForOrigin",
                        json!({"origin": origin, "storageTypes": "all"}),
                    )
                    .await
                {
                    failures.push(format!("Site data for {origin}: {error}"));
                }
            }
        }
    }
    if what.cookies {
        done.push("cookies".into());
    }
    if what.cache {
        done.push("cache".into());
    }
    if what.site_data {
        done.push("site data".into());
    }
    let restart_needed = what.cookies || what.cache || what.site_data;
    if restart_needed {
        let queued = containers_to_queue(&lock(&state.store), profile);
        match queued.and_then(|profiles| queue_profile_clear(&profiles, what)) {
            Ok(()) => {}
            Err(error) => failures.push(format!("Closed profiles: {error}")),
        }
    }
    let mut summary = summary(&done);
    if restart_needed {
        summary.push_str(" Restart Dive to finish the profiles that were not open.");
    }
    Ok(ClearOutcome {
        summary,
        failures,
        restart_needed,
    })
}

/// The cache folders of the containers a clear for `profile` must queue for
/// the next launch: that profile's own, never another's.
fn containers_to_queue(
    store: &dive_core::Store,
    profile: dive_core::ProfileId,
) -> AppResult<Vec<String>> {
    Ok(store
        .containers_of_profile(profile)?
        .into_iter()
        .map(|container| container.cache_dir)
        .collect())
}

/// Clear what Dive keeps itself -- history, download records, form entries
/// -- and say what went and what could not.
fn clear_records(
    state: &AppState,
    what: ClearRequest,
    since: Option<dive_core::Timestamp>,
    profile: dive_core::ProfileId,
) -> (Vec<String>, Vec<String>) {
    let mut done: Vec<String> = Vec::new();
    let mut failures: Vec<String> = Vec::new();
    if what.history {
        let store = crate::state::lock(&state.store);
        let cleared = store.history_origins(profile).and_then(|origins| {
            // Read before the delete: the rows are what name the sites.
            let n = store.clear_history_for(profile, since)?;
            // Icons record which sites were visited, but not when; they go
            // with the whole of history, not with the last hour of it, and
            // stay where another profile still reaches the same site.
            if since.is_none() {
                store.clear_favicons_for(&origins)?;
            }
            let downloads = store.clear_downloads_for(profile, since)?;
            Ok((n, downloads))
        });
        drop(store);
        match cleared {
            Ok((n, downloads)) => {
                done.push(counted(n, "history entry", "history entries"));
                if downloads > 0 {
                    done.push(counted(downloads, "download record", "download records"));
                }
            }
            Err(error) => failures.push(format!("History: {error}")),
        }
    }
    if what.forms {
        let store = crate::state::lock(&state.store);
        match store.clear_form_entries_since(profile, since) {
            Ok(n) => done.push(counted(n, "form entry", "form entries")),
            Err(error) => failures.push(format!("Form entries: {error}")),
        }
    }
    (done, failures)
}

/// One live session per container with an open tab, and the origin of every
/// page open in that container.
fn open_containers(
    state: &AppState,
    profile: dive_core::ProfileId,
) -> std::collections::HashMap<
    dive_core::ContainerId,
    (CdpSession, std::collections::BTreeSet<String>),
> {
    let host = crate::state::lock(&state.host);
    let store = crate::state::lock(&state.store);
    let mut containers = std::collections::HashMap::new();
    let Some(host) = host.as_ref() else {
        return containers;
    };
    for (id, session) in host.sessions() {
        let Ok(tab) = store.tab(id) else { continue };
        let Some(workspace) = tab
            .workspace_id
            .and_then(|workspace| store.workspace(workspace).ok())
        else {
            continue;
        };
        if workspace.profile_id != profile {
            continue;
        }
        let (_, origins) = containers
            .entry(workspace.container_id)
            .or_insert_with(|| (session, std::collections::BTreeSet::new()));
        if let Some(origin) = origin_of(&tab.url) {
            origins.insert(origin);
        }
    }
    containers
}

fn origin_of(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let origin = parsed.origin();
    origin.is_tuple().then(|| origin.ascii_serialization())
}

/// "3 history entries", "1 form entry": the count first, as a person would say it.
fn counted(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// "Cleared 3 history entries, cookies and cache." — a sentence, not a list dump.
fn summary(done: &[String]) -> String {
    match done {
        [] => "Nothing selected.".to_owned(),
        [only] => format!("Cleared {only}."),
        [head @ .., last] => format!("Cleared {} and {last}.", head.join(", ")),
    }
}

/// The oldest visit a retention window of `days` keeps; `None` when history
/// is kept forever.
fn retention_cutoff(days: i32) -> Option<dive_core::Timestamp> {
    if days <= 0 {
        return None;
    }
    // Clamped on the way in, and checked here as well: a window reaching
    // past the calendar's first year panics in a plain subtraction.
    let days = i64::from(days.min(MAX_HISTORY_DAYS));
    dive_core::Timestamp::now()
        .0
        .checked_sub(time::Duration::days(days))
        .map(dive_core::Timestamp)
}

/// Drop visits older than the retention window, in every profile; no-op
/// when history is kept forever. Returns how many rows went.
pub fn prune_history(state: &AppState) -> AppResult<usize> {
    let Some(cutoff) = retention_cutoff(state.prefs.snapshot(state).history_days) else {
        return Ok(0);
    };
    Ok(crate::state::lock(&state.store).prune_history(cutoff)?)
}

/// How many visits a retention window of `days` would drop, in every
/// profile as [`prune_history`] does, so shortening it can ask first.
/// Nothing is deleted here.
pub fn count_prunable(state: &AppState, days: i32) -> AppResult<usize> {
    let Some(cutoff) = retention_cutoff(days) else {
        return Ok(0);
    };
    Ok(crate::state::lock(&state.store).count_history_before(cutoff)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_cleanup_is_scoped_and_selection_specific() {
        let root = std::path::Path::new("/profiles");
        assert_eq!(
            safe_profile(root, "container-good").unwrap(),
            root.join("container-good")
        );
        assert!(safe_profile(root, "../outside").is_err());
        assert!(safe_profile(root, "/absolute").is_err());
        let targets = component_targets(
            &root.join("container-good"),
            ClearRequest {
                history: false,
                cookies: true,
                cache: false,
                site_data: false,
                forms: false,
                since_hours: None,
            },
        );
        assert!(targets.iter().any(|path| path.ends_with("Network/Cookies")));
        assert!(!targets.iter().any(|path| path.ends_with("IndexedDB")));
    }

    #[test]
    fn a_clear_queues_only_the_active_profile_s_containers() {
        use dive_core::{Container, Profile, Store, Workspace};
        let store = Store::in_memory().unwrap();
        let mut made = Vec::new();
        for (position, name) in [(0, "one"), (1, "two")] {
            let home = Container::new(name);
            let own = Container::new(format!("{name}-own"));
            store.upsert_container(&home).unwrap();
            store.upsert_container(&own).unwrap();
            let profile = Profile::new(name, home.id, position);
            store.upsert_profile(&profile).unwrap();
            store
                .upsert_workspace(&Workspace::new(name, own.id, profile.id, 0))
                .unwrap();
            made.push((profile.id, [home.cache_dir, own.cache_dir]));
        }
        for (profile, dirs) in made {
            let mut queued = containers_to_queue(&store, profile).unwrap();
            queued.sort();
            let mut want = dirs.to_vec();
            want.sort();
            assert_eq!(queued, want);
        }
    }

    #[test]
    fn a_pending_clear_finishes_and_an_unreadable_one_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("profiles");
        let trash = dir.path().join("trash");
        let pending = dir.path().join("pending-browser-data-clear.json");
        std::fs::create_dir_all(root.join("a/Cache")).unwrap();
        let what = ClearRequest {
            history: false,
            cookies: false,
            cache: true,
            site_data: false,
            forms: false,
            since_hours: None,
        };
        write_pending_clear(
            &pending,
            &PendingClear {
                // A name that can never be a profile folder is dropped
                // rather than retried at every launch.
                profiles: vec!["a".into(), "../escape".into()],
                what,
            },
        )
        .unwrap();
        assert!(finish_pending_clear_at(&pending, &root, &trash).is_err());
        assert!(
            !root.join("a/Cache").exists(),
            "the cache went to the trash"
        );
        assert!(!pending.exists(), "nothing retryable was left queued");

        std::fs::write(&pending, b"{\"profiles\": [").unwrap();
        assert!(finish_pending_clear_at(&pending, &root, &trash).is_err());
        assert!(!pending.exists());
        assert!(pending.with_extension("json.unreadable").is_file());
        // The next launch is not held up by it again.
        assert!(finish_pending_clear_at(&pending, &root, &trash).is_ok());
    }

    #[test]
    fn pending_clear_selections_only_grow() {
        let first = ClearRequest {
            history: true,
            cookies: false,
            cache: true,
            site_data: false,
            forms: false,
            since_hours: None,
        };
        let second = ClearRequest {
            history: false,
            cookies: true,
            cache: false,
            site_data: true,
            forms: false,
            since_hours: None,
        };
        assert_eq!(
            merge_clear(first, second),
            ClearRequest {
                history: true,
                cookies: true,
                cache: true,
                site_data: true,
                forms: false,
                since_hours: None,
            }
        );
    }

    #[test]
    fn cleared_summary_reads_as_a_sentence() {
        assert_eq!(super::summary(&[]), "Nothing selected.");
        assert_eq!(super::summary(&["cookies".to_owned()]), "Cleared cookies.");
        assert_eq!(
            super::summary(&[
                super::counted(3, "history entry", "history entries"),
                "cookies".to_owned(),
                "cache".to_owned()
            ]),
            "Cleared 3 history entries, cookies and cache."
        );
        assert_eq!(
            super::counted(1, "form entry", "form entries"),
            "1 form entry"
        );
    }
}
