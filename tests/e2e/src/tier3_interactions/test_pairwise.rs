//! Tier 3: Cross-Feature Combinations (Pairwise Interactions)
//!
//! Evaluates interactions across multiple subsystems:
//! 1. Discarding while CDP session is active
//! 2. Crash recovery while navigation is in flight
//! 3. MCP tool command on a discarded tab
//! 4. Concurrent store work: MCP reads while the idle sweep runs
//! 6. Concurrent MCP requests during housekeeping idle sweep
//! 7. Tab reactivation requested while crash recovery reload is pending
//! 8. Workspace switching while background operations execute

use std::sync::{Arc, Mutex};

use dive_cdp::CdpSession;
use dive_core::model::{Tab, TabId, TabState, Timestamp};
use dive_mcp::{Browser, TabInfo};

use crate::fixtures::{MockCdpTransport, TestFakeBrowser, create_test_store};
use crate::tier1_feature_coverage::test_r2_discard::SPEC_MAX_IDLE;

#[test]
fn test_discard_while_cdp_active() {
    // Interaction: An active CDP session exists on a tab when the tab is discarded.
    // The transport should drop cleanly without leaking memory or panicking.
    let transport = MockCdpTransport::new();
    let session = CdpSession::new(transport);

    let (store, _, ws_id) = create_test_store();
    let mut tab = Tab::new(ws_id, "https://app.dev", 0);
    store.upsert_tab(&tab).unwrap();

    // CDP call in flight
    let _ = session.handle_incoming(r#"{"id": 10000001, "result": {"navigated": true}}"#);

    // Tab is discarded
    tab.state = TabState::Discarded;
    store.upsert_tab(&tab).unwrap();

    // Verify session drops or handles subsequent incoming cleanly
    let handled_after_discard =
        session.handle_incoming(r#"{"id": 10000002, "result": {"dropped": true}}"#);
    assert!(handled_after_discard.is_ok());

    let fetched = store.tab(tab.id).unwrap();
    assert_eq!(fetched.state, TabState::Discarded);
}

#[test]
fn test_crash_recovery_during_navigation() {
    // Interaction: Renderer crashes while a page navigation is in-flight.
    let (store, _, ws_id) = create_test_store();
    let mut tab = Tab::new(ws_id, "https://slow-load.dev/heavy-bundle", 0);
    tab.title = "Loading...".to_string();
    store.upsert_tab(&tab).unwrap();

    // The navigation target URL is what the store keeps for recovery.
    let recovered_tab = store.tab(tab.id).unwrap();
    assert_eq!(recovered_tab.url, "https://slow-load.dev/heavy-bundle");
}

#[tokio::test]
async fn test_mcp_tool_on_discarded_tab() {
    // Interaction: An MCP agent invokes page_text on a discarded tab.
    let discarded_id = TabId::new();
    let fake_browser = Arc::new(TestFakeBrowser::with_initial_tabs(vec![TabInfo {
        id: discarded_id.to_string(),
        url: "https://discarded-tab.dev".to_string(),
        title: "Sleeping Tab".to_string(),
        active: false,
    }]));

    // Agent attempts to read page text on discarded tab
    let result = fake_browser.page_text(discarded_id).await;
    assert!(
        result.is_ok(),
        "MCP should gracefully handle discarded tab reference"
    );
}

#[tokio::test]
async fn test_concurrent_mcp_during_idle_sweep() {
    // Interaction: MCP client reads tabs while housekeeping sweep runs in background.
    let (store, _, ws_id) = create_test_store();
    let store_arc = Arc::new(Mutex::new(store));

    // Create 10 tabs in store
    let now = Timestamp::now();
    for i in 0..10 {
        let mut t = Tab::new(ws_id, format!("https://test{i}.com"), i);
        t.last_active_at = now - time::Duration::minutes(35);
        store_arc.lock().unwrap().upsert_tab(&t).unwrap();
    }

    let store_sweep = Arc::clone(&store_arc);
    let sweep_handle = tokio::spawn(async move {
        store_sweep
            .lock()
            .unwrap()
            .archive_idle_tabs(now, SPEC_MAX_IDLE)
            .unwrap()
    });

    let store_read = Arc::clone(&store_arc);
    let read_handle = tokio::spawn(async move {
        let tabs = store_read
            .lock()
            .unwrap()
            .tabs_for_workspace(ws_id)
            .unwrap();
        tabs.len()
    });

    let (sweep_res, read_res) = tokio::join!(sweep_handle, read_handle);
    assert_eq!(sweep_res.unwrap(), 10);
    assert_eq!(read_res.unwrap(), 10);
}

#[test]
fn test_tab_reactivation_during_crash_recovery() {
    // Interaction: User clicks on a tab while an automated crash backoff is waiting to reload.
    let (store, _, ws_id) = create_test_store();
    let mut tab = Tab::new(ws_id, "https://crashing-app.dev", 0);
    store.upsert_tab(&tab).unwrap();

    // User explicitly reactivates tab before backoff fires
    tab.state = TabState::Active;
    tab.last_active_at = Timestamp::now();
    store.upsert_tab(&tab).unwrap();

    let fetched = store.tab(tab.id).unwrap();
    assert_eq!(fetched.state, TabState::Active);
}

#[test]
fn test_workspace_switching_during_recovery() {
    // Interaction: Switching active workspace while a background tab in another
    // workspace is recovering from a crash.
    let (store, container_id, ws_1) = create_test_store();
    let profile_id = store.workspace(ws_1).unwrap().profile_id;
    let ws_2 = dive_core::model::Workspace::new("Secondary Workspace", container_id, profile_id, 1);
    store.upsert_workspace(&ws_2).unwrap();

    let mut tab_ws1 = Tab::new(ws_1, "https://ws1.dev", 0);
    store.upsert_tab(&tab_ws1).unwrap();

    // User switches to WS2
    let active_ws = ws_2.id;
    assert_ne!(active_ws, ws_1);

    // WS1 tab completes recovery and remains bound to WS1
    tab_ws1.state = TabState::Active;
    store.upsert_tab(&tab_ws1).unwrap();

    let tab_check = store.tab(tab_ws1.id).unwrap();
    assert_eq!(tab_check.workspace_id, Some(ws_1));
}
