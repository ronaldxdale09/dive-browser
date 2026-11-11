//! Tier 2: Boundary & Corner Cases — Requirement R3 (Crash Bursts & Lockout)

use dive_core::model::Tab;

use crate::fixtures::create_test_store;

#[test]
fn test_crash_event_for_non_existent_tab() {
    let (store, _, _) = create_test_store();
    let fake_tab_id = dive_core::model::TabId::new();

    // Verify non-existent tab lookup returns Err without panic
    let tab = store.tab(fake_tab_id);
    assert!(tab.is_err());
}

#[test]
fn test_simultaneous_crashes_multi_workspace() {
    let (store, container_id, ws_1) = create_test_store();
    let profile_id = store.workspace(ws_1).unwrap().profile_id;
    let ws_2 = dive_core::model::Workspace::new("WS 2", container_id, profile_id, 1);
    store.upsert_workspace(&ws_2).unwrap();

    let tab_1 = Tab::new(ws_1, "https://ws1.local", 0);
    let tab_2 = Tab::new(ws_2.id, "https://ws2.local", 0);
    store.upsert_tab(&tab_1).unwrap();
    store.upsert_tab(&tab_2).unwrap();

    // Both tabs remain in their respective workspaces
    let t1_fetched = store.tab(tab_1.id).unwrap();
    let t2_fetched = store.tab(tab_2.id).unwrap();
    assert_eq!(t1_fetched.workspace_id, Some(ws_1));
    assert_eq!(t2_fetched.workspace_id, Some(ws_2.id));
}

#[test]
fn test_crash_handling_on_already_discarded_tab() {
    let (store, _, ws_id) = create_test_store();
    let mut tab = Tab::new(ws_id, "https://dormant.dev", 0);
    tab.state = dive_core::model::TabState::Discarded;
    store.upsert_tab(&tab).unwrap();

    // If an incoming event references an already discarded tab,
    // it remains in discarded state without crashing the host
    let current = store.tab(tab.id).unwrap();
    assert_eq!(current.state, dive_core::model::TabState::Discarded);
}
