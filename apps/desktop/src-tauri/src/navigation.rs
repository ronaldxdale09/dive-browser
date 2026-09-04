//! Chromium's per-view navigation stack. Entry IDs are scoped to the native
//! view generation so a menu opened before discard cannot navigate a new view.

use dive_cdp::CdpSession;
use dive_core::TabId;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;
use tauri_specta::Event;

use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

#[derive(Clone, Debug, Deserialize, Serialize, Type)]
pub struct NavigationEntry {
    pub id: i32,
    pub url: String,
    pub title: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Type)]
pub struct NavigationHistory {
    pub generation: String,
    pub current_index: i32,
    pub entries: Vec<NavigationEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
pub struct TabHistoryChanged {
    pub tab_id: TabId,
}

fn parse_history(value: serde_json::Value, generation: String) -> AppResult<NavigationHistory> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Reply {
        current_index: i32,
        entries: Vec<NavigationEntry>,
    }
    let reply: Reply = serde_json::from_value(value).map_err(AppError::new)?;
    let valid_index = if reply.entries.is_empty() {
        reply.current_index == -1
    } else {
        usize::try_from(reply.current_index).is_ok_and(|index| index < reply.entries.len())
    };
    let mut ids = std::collections::HashSet::new();
    if !valid_index || !reply.entries.iter().all(|entry| ids.insert(entry.id)) {
        return Err(AppError::new("engine returned invalid navigation history"));
    }
    let history = NavigationHistory {
        generation,
        current_index: reply.current_index,
        entries: reply.entries,
    };
    Ok(history)
}

fn target(state: &AppState, id: TabId) -> AppResult<(CdpSession, String)> {
    let host = lock(&state.host);
    let host = host
        .as_ref()
        .ok_or_else(|| AppError::new("engine not ready"))?;
    let generation = host.with_view(id, |view| Ok(view.label().to_owned()))?;
    let session = host
        .cdp(id)
        .ok_or_else(|| AppError::new("no navigation session for this tab"))?;
    Ok((session, generation))
}

fn require_generation(state: &AppState, id: TabId, expected: &str) -> AppResult<()> {
    let (_, generation) = target(state, id)?;
    if generation != expected {
        return Err(AppError::new(
            "this tab was restored; reopen its navigation history",
        ));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_history(
    state: State<'_, AppState>,
    id: TabId,
) -> AppResult<NavigationHistory> {
    let (session, generation) = target(&state, id)?;
    let result = session
        .call0("Page.getNavigationHistory")
        .await
        .map_err(AppError::new)?;
    require_generation(&state, id, &generation)?;
    parse_history(result, generation)
}

fn require_entry(history: &NavigationHistory, generation: &str, entry_id: i32) -> AppResult<()> {
    if history.generation != generation || !history.entries.iter().any(|entry| entry.id == entry_id)
    {
        return Err(AppError::new("that history entry is no longer available"));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_history_navigate(
    state: State<'_, AppState>,
    id: TabId,
    generation: String,
    entry_id: i32,
) -> AppResult<()> {
    let (session, actual_generation) = target(&state, id)?;
    if actual_generation != generation {
        return Err(AppError::new(
            "this tab was restored; reopen its navigation history",
        ));
    }
    let result = session
        .call0("Page.getNavigationHistory")
        .await
        .map_err(AppError::new)?;
    let history = parse_history(result, actual_generation)?;
    require_entry(&history, &generation, entry_id)?;
    require_generation(&state, id, &generation)?;
    session
        .call(
            "Page.navigateToHistoryEntry",
            serde_json::json!({"entryId": entry_id}),
        )
        .await
        .map_err(AppError::new)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn reply(index: i32) -> serde_json::Value {
        json!({"currentIndex": index, "entries": [
            {"id": 10, "url": "https://example.com/", "title": "Home", "transitionType": "typed"},
            {"id": 20, "url": "https://example.com/#part", "title": "Part", "transitionType": "link"}
        ]})
    }

    #[test]
    fn preserves_engine_ids_order_and_same_document_entries() {
        let history = parse_history(reply(1), "view-1".into()).unwrap();
        assert_eq!(history.current_index, 1);
        assert_eq!(history.entries[0].id, 10);
        assert_eq!(history.entries[1].url, "https://example.com/#part");
        assert!(require_entry(&history, "view-1", 10).is_ok());
    }

    #[test]
    fn rejects_invalid_indices_and_duplicate_entry_ids() {
        for index in [-1, 2, 200] {
            assert!(parse_history(reply(index), "view-1".into()).is_err());
        }
        let mut duplicate = reply(0);
        duplicate["entries"][1]["id"] = json!(10);
        assert!(parse_history(duplicate, "view-1".into()).is_err());
    }

    #[test]
    fn accepts_only_the_empty_history_sentinel() {
        assert!(parse_history(json!({"currentIndex": -1, "entries": []}), "view-1".into()).is_ok());
        assert!(parse_history(json!({"currentIndex": 0, "entries": []}), "view-1".into()).is_err());
    }

    #[test]
    fn rejects_entries_from_a_replaced_view_or_pruned_forward_stack() {
        let history = parse_history(reply(0), "view-2".into()).unwrap();
        assert!(require_entry(&history, "view-1", 10).is_err());
        assert!(require_entry(&history, "view-2", 99).is_err());
    }
}
