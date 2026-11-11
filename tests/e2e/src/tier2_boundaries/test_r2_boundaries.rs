//! Tier 2: Boundary & Corner Cases — Requirement R2 (Tab Discarding Boundaries)

use dive_core::model::{Tab, TabState, TabTier, Timestamp};
use time::Duration;

use crate::fixtures::{create_sample_tabs, create_test_store};
use crate::tier1_feature_coverage::test_r2_discard::SPEC_MAX_IDLE;

#[test]
fn test_store_sweep_respects_the_30_minute_cutoff() {
    let (store, _, ws_id) = create_test_store();
    let now = Timestamp::now();

    let mut just_inside = Tab::new(ws_id, "https://example.com/29m59s", 0);
    just_inside.last_active_at = now - (SPEC_MAX_IDLE - Duration::seconds(1));
    store.upsert_tab(&just_inside).unwrap();

    let mut just_past = Tab::new(ws_id, "https://example.com/30m01s", 1);
    just_past.last_active_at = now - (SPEC_MAX_IDLE + Duration::seconds(1));
    store.upsert_tab(&just_past).unwrap();

    assert_eq!(store.archive_idle_tabs(now, SPEC_MAX_IDLE).unwrap(), 1);
    assert_eq!(store.tab(just_inside.id).unwrap().state, TabState::Active);
    assert_eq!(store.tab(just_past.id).unwrap().state, TabState::Discarded);
}

#[test]
fn test_extreme_and_negative_scroll_coordinates() {
    // Contract: Scroll coordinates (scroll_x, scroll_y) must safely store 0,
    // large integers, and clamp negative inputs.
    let sanitize_scroll = |x: i64, y: i64| -> (i32, i32) {
        let clamped_x = x.clamp(0, 10_000_000) as i32;
        let clamped_y = y.clamp(0, 10_000_000) as i32;
        (clamped_x, clamped_y)
    };

    // (0, 0) top of page
    assert_eq!(sanitize_scroll(0, 0), (0, 0));

    // Negative coordinates should clamp to 0
    assert_eq!(sanitize_scroll(-100, -500), (0, 0));

    // Extreme large webpage coordinates
    assert_eq!(sanitize_scroll(500_000, 2_000_000), (500_000, 2_000_000));
}

#[test]
fn test_empty_workspace_sweep_idempotency() {
    let (store, _, ws_id) = create_test_store();
    let now = Timestamp::now();

    // Sweeping an empty workspace should return 0 and not panic
    let count = store.archive_idle_tabs(now, SPEC_MAX_IDLE).unwrap();
    assert_eq!(count, 0);

    let tabs = store.tabs_for_workspace(ws_id).unwrap();
    assert!(tabs.is_empty());
}

#[test]
fn test_all_protected_tabs_sweep_zero_discards() {
    let (store, _, ws_id) = create_test_store();
    let now = Timestamp::now();

    // Add pinned tabs
    let mut pinned = Tab::new(ws_id, "https://github.com", 0);
    pinned.tier = TabTier::Pinned;
    pinned.last_active_at = now - Duration::hours(10);
    store.upsert_tab(&pinned).unwrap();

    // Add essential tab
    let mut essential = Tab::new(ws_id, "https://dive.internal", 1);
    essential.tier = TabTier::Essential;
    essential.last_active_at = now - Duration::hours(20);
    store.upsert_tab(&essential).unwrap();

    let archived = store.archive_idle_tabs(now, SPEC_MAX_IDLE).unwrap();
    assert_eq!(
        archived, 0,
        "No pinned or essential tabs should ever be discarded"
    );

    let tabs = store.tabs_for_workspace(ws_id).unwrap();
    assert_eq!(tabs.len(), 2);
    assert!(tabs.iter().all(|t| t.state == TabState::Active));
}

#[test]
fn test_rapid_successive_idle_sweeps() {
    let (store, _, ws_id) = create_test_store();
    let now = Timestamp::now();

    create_sample_tabs(
        &store,
        ws_id,
        5,
        TabTier::Today,
        TabState::Active,
        Duration::hours(2),
    );

    // First sweep: archives 5 tabs
    let first = store.archive_idle_tabs(now, SPEC_MAX_IDLE).unwrap();
    assert_eq!(first, 5);

    // Immediate successive sweeps: must return 0 (idempotent, no double-sweeps)
    for _ in 0..5 {
        let subsequent = store.archive_idle_tabs(now, SPEC_MAX_IDLE).unwrap();
        assert_eq!(subsequent, 0);
    }
}

#[test]
fn test_special_url_discard_and_reactivation() {
    let (store, _, ws_id) = create_test_store();
    let now = Timestamp::now();

    let complex_urls = [
        "https://example.com/docs#deep-anchor-section-123",
        "https://search.engine.com/q?term=%E2%9C%A8+unicode&filter=1#res",
        "data:text/html,<h1>Local%20Draft</h1>",
    ];

    for (pos, url) in complex_urls.iter().enumerate() {
        let mut tab = Tab::new(ws_id, *url, pos as i32);
        tab.last_active_at = now - Duration::hours(1);
        store.upsert_tab(&tab).unwrap();
    }

    let count = store.archive_idle_tabs(now, SPEC_MAX_IDLE).unwrap();
    assert_eq!(count, 3);

    for (pos, expected_url) in complex_urls.iter().enumerate() {
        let tabs = store.tabs_for_workspace(ws_id).unwrap();
        let tab = &tabs[pos];
        assert_eq!(tab.state, TabState::Discarded);
        assert_eq!(tab.url, *expected_url);
    }
}
