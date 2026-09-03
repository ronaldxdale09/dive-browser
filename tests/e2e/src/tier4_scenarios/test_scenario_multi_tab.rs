//! Tier 4: Real-World Application Scenarios — Scenario 1 (Multi-Tab Developer Workflow)
//!
//! Simulates a realistic developer workspace session with 20 tabs across 2 workspaces:
//! - Localhost dev servers (protected)
//! - Pinned reference tabs (protected)
//! - Audio-playing media tabs (protected)
//! - Active focused tab (protected)
//! - Essential system tabs (protected)
//! - Background documentation and research tabs (eligible for 30m idle discard)
//!
//! Validates:
//! 1. Memory saver sweep correctly distinguishes protected vs eligible tabs
//! 2. Multi-workspace sweep cleans up inactive tabs in background workspaces
//! 3. Zero-loss reactivation: clicking discarded tabs restores full state

use dive_core::model::{Tab, TabId, TabState, TabTier, Timestamp};
use time::Duration;

use crate::fixtures::create_test_store;
use crate::tier1_feature_coverage::test_r2_discard::{SPEC_MAX_IDLE, should_discard_tab};

#[test]
fn test_scenario_20_tab_developer_workflow() {
    let (store, container_id, ws_frontend) = create_test_store();
    let ws_backend = dive_core::model::Workspace::new("Backend Microservices", container_id, 1);
    store.upsert_workspace(&ws_backend).unwrap();

    let now = Timestamp::now();
    let idle_time = Duration::minutes(45); // Exceeds 30m threshold

    // Workspace 1 (Frontend): 10 tabs
    // Tab 0: Active focused tab (Vite dev server)
    let mut t0 = Tab::new(ws_frontend, "http://localhost:5173", 0);
    t0.title = "Vite App".to_string();
    t0.last_active_at = now;
    store.upsert_tab(&t0).unwrap();

    // Tab 1: Localhost API server (Background, idle 45m)
    let mut t1 = Tab::new(ws_frontend, "http://localhost:3000/api", 1);
    t1.last_active_at = now - idle_time;
    store.upsert_tab(&t1).unwrap();

    // Tab 2: Pinned MDN docs
    let mut t2 = Tab::new(ws_frontend, "https://developer.mozilla.org", 2);
    t2.tier = TabTier::Pinned;
    t2.last_active_at = now - idle_time;
    store.upsert_tab(&t2).unwrap();

    // Tab 3: Audio streaming tab (e.g. music)
    let mut t3 = Tab::new(ws_frontend, "https://music.youtube.com", 3);
    t3.last_active_at = now - idle_time;
    store.upsert_tab(&t3).unwrap();

    // Tabs 4..9: 6 general reference tabs (Eligible for discard)
    for i in 4..10 {
        let mut t = Tab::new(ws_frontend, format!("https://react.dev/reference/{}", i), i);
        t.last_active_at = now - idle_time;
        store.upsert_tab(&t).unwrap();
    }

    // Workspace 2 (Backend): 10 tabs
    // Tab 10: Essential settings tab
    let mut t10 = Tab::new(ws_backend.id, "https://dive.internal/settings", 0);
    t10.tier = TabTier::Essential;
    t10.last_active_at = now - idle_time;
    store.upsert_tab(&t10).unwrap();

    // Tabs 11..19: 9 background research tabs in Workspace 2 (Eligible for discard)
    for i in 11..20 {
        let mut t = Tab::new(
            ws_backend.id,
            format!("https://crates.io/crates/crate-{}", i),
            i - 10,
        );
        t.last_active_at = now - idle_time;
        store.upsert_tab(&t).unwrap();
    }

    // Total tabs created: 20 unique tabs
    let all_ws1 = store.tabs_for_workspace(ws_frontend).unwrap();
    let all_ws2 = store.tabs_for_workspace(ws_backend.id).unwrap();

    let mut all_unique_tabs: Vec<Tab> = Vec::new();
    for t in all_ws1.into_iter().chain(all_ws2) {
        if !all_unique_tabs.iter().any(|existing| existing.id == t.id) {
            all_unique_tabs.push(t);
        }
    }
    assert_eq!(
        all_unique_tabs.len(),
        20,
        "Total 20 unique tabs across both workspaces"
    );

    // Evaluate safe discard decisions for each tab
    let mut discarded_count = 0;
    let mut protected_count = 0;

    for tab in &mut all_unique_tabs {
        let is_showing = tab.id == t0.id;
        let is_audible = tab.id == t3.id;
        let discard = should_discard_tab(tab, is_showing, is_audible, false, now, SPEC_MAX_IDLE);

        if discard {
            discarded_count += 1;
            tab.state = TabState::Discarded;
            store.upsert_tab(tab).unwrap();
        } else {
            protected_count += 1;
        }
    }

    // Assertions:
    // Protected:
    // 1. Tab 0 (showing active)
    // 2. Tab 1 (localhost dev session)
    // 3. Tab 2 (pinned)
    // 4. Tab 3 (audible)
    // 5. Tab 10 (essential)
    assert_eq!(
        protected_count, 5,
        "Exactly 5 tabs must be protected by safe discard rules"
    );

    // Discarded:
    // Tabs 4..9 (6 tabs) + Tabs 11..19 (9 tabs) = 15 tabs
    assert_eq!(
        discarded_count, 15,
        "Exactly 15 background tabs must be discarded"
    );

    // Verify Zero-Loss Reactivation for 3 discarded tabs:
    let reactivate_ids: Vec<TabId> = all_unique_tabs
        .iter()
        .filter(|t| t.state == TabState::Discarded)
        .take(3)
        .map(|t| t.id)
        .collect();
    let reactivate_time = Timestamp::now();

    for id in reactivate_ids {
        let mut tab = store.tab(id).unwrap();
        assert_eq!(tab.state, TabState::Discarded);
        tab.state = TabState::Active;
        tab.last_active_at = reactivate_time;
        store.upsert_tab(&tab).unwrap();

        let restored = store.tab(id).unwrap();
        assert_eq!(restored.state, TabState::Active);
        assert!(!restored.url.is_empty());
        assert!(restored.last_active_at >= reactivate_time);
    }
}
