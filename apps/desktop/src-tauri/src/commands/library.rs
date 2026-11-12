//! library commands.

// Tauri commands receive their arguments by value; that is the IPC contract.
#![allow(clippy::needless_pass_by_value)]

use dive_core::TabId;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// How many icons one lookup will answer. A rail holds a dozen links; a
/// longer list is a caller that has lost track of what it is asking for.
const MAX_FAVICON_LOOKUPS: usize = 32;

/// How many images one `favicon_get` will return. The chrome batches the
/// keys a render asks for; a tab strip and a page of history fit easily.
const MAX_FAVICON_IMAGES: usize = 64;

/// The images stored under `keys`, as `(key, data: URL)` pairs.
///
/// Tabs, history rows and bookmarks carry only an icon's key; this is where
/// the chrome turns one into a picture. A key names its image's bytes, so
/// the chrome keeps each answer for as long as it runs. A key with nothing
/// stored under it any more is left out of the answer.
#[tauri::command]
#[specta::specta]
pub(crate) fn favicon_get(
    state: State<'_, AppState>,
    keys: Vec<String>,
) -> AppResult<Vec<(String, String)>> {
    let keys: Vec<String> = keys.into_iter().take(MAX_FAVICON_IMAGES).collect();
    Ok(lock(&state.store).favicon_images(&keys)?)
}

/// The same origin with `www.` added or taken away.
///
/// A link pinned as `youtube.com` and a visit to `www.youtube.com` are
/// different origins to everything that stores things by origin, but they are
/// the same site to the person who pinned it.
fn alternate_origin(origin: &str) -> String {
    let Some((scheme, host)) = origin.split_once("://") else {
        return origin.to_owned();
    };
    host.strip_prefix("www.").map_or_else(
        || format!("{scheme}://www.{host}"),
        |bare| format!("{scheme}://{bare}"),
    )
}

/// The key of the cached icon for each of `urls`; see [`favicon_get`].
///
/// Every site the person has visited leaves its icon in the store keyed by
/// origin, so a pinned link can wear the site's own mark without anything
/// touching the network -- and without waiting for a tab on that site to be
/// open, which is what left a freshly added quick link showing a globe.
///
/// `www.` is tried both ways: a link pinned as `youtube.com` and a visit to
/// `www.youtube.com` are different origins, and the person who typed the
/// short one means the site they have been to.
#[tauri::command]
#[specta::specta]
pub(crate) fn favicons_for(state: State<'_, AppState>, urls: Vec<String>) -> Vec<(String, String)> {
    let store = lock(&state.store);
    let mut out = Vec::new();
    for url in urls.into_iter().take(MAX_FAVICON_LOOKUPS) {
        let Some(origin) = dive_core::origin_of(&url) else {
            continue;
        };
        let alternate = alternate_origin(&origin);
        let found = store
            .favicon(&origin)
            .ok()
            .flatten()
            .or_else(|| store.favicon(&alternate).ok().flatten());
        if let Some(key) = found {
            out.push((url, key));
        }
    }
    out
}

/// Toggle the bookmark for a tab's current URL; returns the new state.
#[tauri::command]
#[specta::specta]
pub(crate) fn bookmark_toggle(state: State<'_, AppState>, id: TabId) -> AppResult<bool> {
    let store = lock(&state.store);
    let tab = store.tab(id)?;
    if store.is_bookmarked(&tab.url)? {
        store.remove_bookmark(&tab.url)?;
        Ok(false)
    } else {
        store.add_bookmark(&tab.url, &tab.title, dive_core::Timestamp::now())?;
        Ok(true)
    }
}

/// Whether `url` is bookmarked.
#[tauri::command]
#[specta::specta]
pub(crate) fn bookmark_status(state: State<'_, AppState>, url: String) -> AppResult<bool> {
    Ok(lock(&state.store).is_bookmarked(&url)?)
}

/// Bookmarks matching `query`.
#[tauri::command]
#[specta::specta]
pub(crate) fn bookmarks_search(
    state: State<'_, AppState>,
    query: String,
    limit: u32,
) -> AppResult<Vec<dive_core::Bookmark>> {
    Ok(lock(&state.store).search_bookmarks(
        &query,
        usize::try_from(limit.min(LIBRARY_MAX)).unwrap_or(50),
    )?)
}

/// Recent history matching `query`, newest first.
#[tauri::command]
#[specta::specta]
pub(crate) fn history_search(
    state: State<'_, AppState>,
    query: String,
    limit: u32,
) -> AppResult<Vec<dive_core::HistoryEntry>> {
    Ok(lock(&state.store).search_history(
        &query,
        usize::try_from(limit.min(LIBRARY_MAX)).unwrap_or(50),
    )?)
}

/// Most rows one bookmarks or history search returns. The Library asks for a
/// page more as it scrolls, so this bounds how far one list can reach, not
/// what a filter can find: the filter runs in the database.
pub(crate) const LIBRARY_MAX: u32 = 5000;

/// Forget every visit to `url`; true when there was one.
#[tauri::command]
#[specta::specta]
pub(crate) fn history_remove(state: State<'_, AppState>, url: String) -> AppResult<bool> {
    Ok(lock(&state.store).remove_history(&url)? > 0)
}

/// Forget a bookmark by URL.
#[tauri::command]
#[specta::specta]
pub(crate) fn bookmark_remove(state: State<'_, AppState>, url: String) -> AppResult<bool> {
    Ok(lock(&state.store).remove_bookmark(&url)?)
}

/// Give a bookmark a new title, keeping its URL and creation time. A blank
/// title is refused rather than erasing the one on record.
#[tauri::command]
#[specta::specta]
pub(crate) fn bookmark_rename(
    state: State<'_, AppState>,
    url: String,
    title: String,
) -> AppResult<()> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::new("a bookmark needs a title"));
    }
    lock(&state.store).add_bookmark(&url, title, dive_core::Timestamp::now())?;
    Ok(())
}

/// Put back a bookmark that was just removed, with the title and creation
/// time it had, so Undo leaves the list as it was rather than moving the
/// bookmark to the top as a new one.
#[tauri::command]
#[specta::specta]
pub(crate) fn bookmark_restore(
    state: State<'_, AppState>,
    url: String,
    title: String,
    created_at: String,
) -> AppResult<()> {
    let at =
        dive_core::Timestamp::parse(&created_at).unwrap_or_else(|_| dive_core::Timestamp::now());
    lock(&state.store).add_bookmark(&url, &title, at)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pinned_short_host_finds_the_icon_left_by_the_long_one() {
        // Someone pins youtube.com and has been to www.youtube.com. Those are
        // different origins, so a straight lookup finds nothing and the rail
        // shows a globe forever.
        let dir = tempfile::tempdir().expect("tempdir");
        let store = dive_core::Store::open(dir.path().join("t.db")).expect("store");
        let key = store
            .set_favicon("https://www.youtube.com", "data:image/png;base64,AAA", "")
            .expect("set");
        assert_eq!(
            store.favicon("https://youtube.com").expect("lookup"),
            None,
            "the two origins really are different"
        );
        // The pairing is what the command adds on top.
        let paired = alternate_origin("https://youtube.com");
        assert_eq!(paired, "https://www.youtube.com");
        assert_eq!(store.favicon(&paired).expect("lookup"), Some(key.clone()));
        assert_eq!(
            store.favicon_images(&[key]).expect("image")[0].1,
            "data:image/png;base64,AAA"
        );
    }

    #[test]
    fn the_pairing_goes_both_ways() {
        assert_eq!(
            alternate_origin("https://www.example.com"),
            "https://example.com"
        );
        assert_eq!(
            alternate_origin("https://example.com"),
            "https://www.example.com"
        );
        // Nothing to pair on leaves it alone rather than mangling it.
        assert_eq!(alternate_origin("not-an-origin"), "not-an-origin");
    }
}
