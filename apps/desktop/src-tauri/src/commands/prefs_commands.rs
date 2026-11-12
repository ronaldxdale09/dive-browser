//! Preferences, privacy and network commands.

// Tauri commands receive their arguments by value; that is the IPC contract.
#![allow(clippy::needless_pass_by_value)]

use dive_core::TabId;
use tauri::{AppHandle, State};

use super::{reapply_interception, tab_navigate};
use crate::Runtime;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// Current user preferences.
#[tauri::command]
#[specta::specta]
pub(crate) fn prefs_get(state: State<'_, AppState>) -> crate::prefs::Prefs {
    state.prefs.get(&state)
}

/// The chrome reports the scheme it is drawn in ("dark" | "light"). When
/// pages are told the theme, every open tab is told this at once.
#[tauri::command]
#[specta::specta]
pub(crate) async fn pages_scheme(state: State<'_, AppState>, scheme: String) -> AppResult<()> {
    if scheme != "dark" && scheme != "light" {
        return Err(AppError::new(format!("unknown scheme {scheme}")));
    }
    if !state.prefs.set_chrome_scheme(&scheme) {
        return Ok(());
    }
    let prefs = state.prefs.get(&state);
    if !prefs.tell_pages_theme {
        return Ok(());
    }
    let sessions = {
        let host = lock(&state.host);
        host.as_ref()
            .map_or_else(Vec::new, crate::engine::TabHost::sessions)
    };
    for (tab_id, session) in &sessions {
        let page = page_scheme(&state, *tab_id, crate::prefs_apply::PageScheme::Follow);
        crate::prefs_apply::apply_for(session, &prefs, Some(&scheme), page).await;
    }
    Ok(())
}

/// How a tab hears about the colour scheme: as asked, unless the device menu
/// gave it media overrides of its own, which win over the preference and are
/// left alone.
fn page_scheme(
    state: &AppState,
    tab_id: TabId,
    wanted: crate::prefs_apply::PageScheme,
) -> crate::prefs_apply::PageScheme {
    if state.buffers.media(tab_id) == crate::emulate::MediaOverrides::default() {
        wanted
    } else {
        crate::prefs_apply::PageScheme::Leave
    }
}

/// Store preferences and put them into force on every open tab. Returns the
/// stored form, which may differ where a value was out of range.
#[tauri::command]
#[specta::specta]
pub(crate) async fn prefs_set(
    state: State<'_, AppState>,
    prefs: crate::prefs::Prefs,
) -> AppResult<crate::prefs::Prefs> {
    let _update = state.prefs.begin_update().await;
    let previous = state.prefs.get(&state);
    let mut prefs = prefs;
    // Checked when it changes, not on every write: the check touches the
    // disk, and a folder that was fine when chosen is the engine's to report
    // if it goes away later.
    if prefs.download_dir.trim() != previous.download_dir {
        prefs.download_dir = crate::prefs::check_download_dir(&prefs.download_dir)?;
    }
    let stored = state.prefs.set(&state, prefs)?;
    if crate::prefs_apply::chrome_only_change(&previous, &stored) {
        return Ok(stored);
    }
    let scheme = if previous.tell_pages_theme && !stored.tell_pages_theme {
        crate::prefs_apply::PageScheme::Withdraw
    } else {
        crate::prefs_apply::PageScheme::Follow
    };
    let sessions = {
        let host = lock(&state.host);
        let store = lock(&state.store);
        host.as_ref().map_or_else(Vec::new, |host| {
            host.sessions()
                .into_iter()
                .map(|(id, session)| {
                    let document_url = store.tab(id).map(|tab| tab.url).unwrap_or_default();
                    (id, session, document_url)
                })
                .collect()
        })
    };
    let chrome_scheme = state.prefs.chrome_scheme();
    for (tab_id, session, document_url) in &sessions {
        let page = page_scheme(&state, *tab_id, scheme);
        crate::prefs_apply::apply_for(session, &stored, chrome_scheme.as_deref(), page).await;
        crate::privacy::refresh_page_policy(&state, *tab_id, session, &stored).await;
        if privacy_site_state_changed(&previous, &stored, document_url)
            && let Err(error) = session.call0("Page.reload").await
        {
            tracing::debug!("DivePrivacy site pause reload failed open: {error}");
        }
    }
    reapply_interception(&state, None).await;
    // Only when the window itself changed; housekeeping keeps an unchanged
    // one trimmed. Settings asks before shortening it (see
    // `history_prune_count`), so this runs on a window the person agreed to.
    if previous.history_days != stored.history_days {
        match crate::browsing_data::prune_history(&state) {
            Ok(0) => {}
            Ok(n) => tracing::info!(n, "pruned history past the retention window"),
            Err(e) => tracing::warn!("history prune failed: {e}"),
        }
    }
    Ok(stored)
}

/// Whether the saved DNS and proxy settings differ from the ones the engine
/// was started with, which only a restart puts into force.
#[tauri::command]
#[specta::specta]
pub(crate) fn network_restart_needed(state: State<'_, AppState>) -> bool {
    crate::netconfig::restart_needed(&state.prefs.snapshot(&state).network())
}

/// How many visits keeping history for `days` would delete, so Settings can
/// ask before a shorter window takes them. Deletes nothing.
#[tauri::command]
#[specta::specta]
pub(crate) fn history_prune_count(state: State<'_, AppState>, days: i32) -> AppResult<u32> {
    let n = crate::browsing_data::count_prunable(&state, days)?;
    Ok(u32::try_from(n).unwrap_or(u32::MAX))
}

fn privacy_site_state_changed(
    previous: &crate::prefs::Prefs,
    current: &crate::prefs::Prefs,
    document_url: &str,
) -> bool {
    let effective = |prefs: &crate::prefs::Prefs| {
        prefs.block_trackers && prefs.privacy_enabled_for(document_url)
    };
    effective(previous) != effective(current)
}

/// Delete browsing data; returns a one-line summary of what went.
#[tauri::command]
#[specta::specta]
pub(crate) async fn browsing_data_clear(
    state: State<'_, AppState>,
    what: crate::browsing_data::ClearRequest,
) -> AppResult<crate::browsing_data::ClearOutcome> {
    crate::browsing_data::clear(&state, what).await
}

/// The host this tab was sent to https for, when the newest navigation was
/// an upgrade and `url` -- the address that failed -- is on that host. The
/// error page asks, so a failure can offer a way out without the host having
/// to push anything.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri hands command arguments over by value.
pub(crate) fn https_only_upgraded(id: TabId, url: String) -> Option<String> {
    crate::https_only::upgraded_host_for(id, &url)
}

/// Keep reaching `host` in the clear, and go back to the http address.
///
/// The exception is per host and permanent until the person removes it; that
/// is what makes it a decision rather than a fallback.
#[tauri::command]
#[specta::specta]
pub(crate) fn https_only_allow(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: TabId,
    url: String,
) -> AppResult<()> {
    let parsed =
        url::Url::parse(&url).map_err(|e| AppError::new(format!("not an address: {e}")))?;
    // Only the host this tab was upgraded for, and only for its own failed
    // address: anything else would put a site the person never saw fail
    // over https on the list of sites reached in the clear.
    let host = crate::https_only::upgraded_host_for(id, &url).ok_or_else(|| {
        AppError::new("this page was not upgraded to https, so there is nothing to allow")
    })?;
    crate::prefs::modify(&app, |prefs| {
        if prefs
            .https_only_allowed
            .iter()
            .any(|known| known.eq_ignore_ascii_case(&host))
        {
            return false;
        }
        prefs.https_only_allowed.push(host);
        true
    })?;
    crate::https_only::forget(id);
    let mut plain = parsed;
    plain
        .set_scheme("http")
        .map_err(|()| AppError::new("that address cannot be loaded in the clear"))?;
    tab_navigate(app, state, id, plain.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn privacy_reload_is_reserved_for_site_pause_transitions() {
        let previous = crate::prefs::Prefs {
            block_trackers: true,
            ..crate::prefs::Prefs::default()
        };
        let mut youtube_changed = previous.clone();
        youtube_changed.youtube_protection = false;
        assert!(!privacy_site_state_changed(
            &previous,
            &youtube_changed,
            "https://www.youtube.com/watch?v=abc",
        ));

        let mut paused = previous.clone();
        paused.privacy_exceptions = vec!["www.youtube.com".into()];
        assert!(privacy_site_state_changed(
            &previous,
            &paused,
            "https://www.youtube.com/watch?v=abc",
        ));
        assert!(!privacy_site_state_changed(
            &previous,
            &paused,
            "https://example.com/",
        ));

        let globally_off = crate::prefs::Prefs::default();
        let mut off_with_removed_exception = globally_off.clone();
        off_with_removed_exception.privacy_exceptions = vec!["www.youtube.com".into()];
        assert!(
            !privacy_site_state_changed(
                &off_with_removed_exception,
                &globally_off,
                "https://www.youtube.com/watch?v=abc",
            ),
            "changing an inert exception must not reload while global protection is off",
        );
    }
}
