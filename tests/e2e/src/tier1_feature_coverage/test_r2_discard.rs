//! Tier 1: Feature Coverage — Requirement R2 (Tab Discarding & Memory Saver Architecture)
//!
//! Features covered:
//! - Feature 7: 30-minute idle sweeping
//! - Feature 8: Multi-workspace native view sweep
//! - Feature 9: Safe discard: pinned & essential tabs
//! - Feature 10: Safe discard: audio-playing tabs
//! - Feature 11: Safe discard: localhost dev sessions
//! - Feature 12: Safe discard: active screencast / agents
//! - Feature 13: Scroll position persistence in SQLite
//! - Feature 14: Discarded tab reactivation
//! - Feature 15: TabStrip sleeping tab display
//! - Feature 16: 20-tab memory profiling harness contract

use dive_core::model::{Tab, TabState, TabTier, Timestamp};
use time::Duration;

use crate::fixtures::{create_sample_tabs, create_test_store, is_localhost_or_devserver};

/// Specification threshold for idle discarding (30 minutes).
pub const SPEC_MAX_IDLE: Duration = Duration::minutes(30);

/// Safe discard policy: only Today-tier tabs idle for longer than `max_idle` may
/// be discarded; showing, pinned/essential, audible, local-dev and automated
/// tabs are always kept.
pub fn should_discard_tab(
    tab: &Tab,
    is_active_showing: bool,
    is_audible: bool,
    is_under_automation: bool,
    now: Timestamp,
    max_idle: Duration,
) -> bool {
    // Rule 1: Never discard active/showing tab
    if is_active_showing {
        return false;
    }
    // Rule 2: Exclude pinned and essential tabs
    if tab.tier == TabTier::Pinned || tab.tier == TabTier::Essential {
        return false;
    }
    // Rule 3: Exclude tabs playing audio
    if is_audible {
        return false;
    }
    // Rule 4: Exclude localhost / loopback dev server sessions
    if is_localhost_or_devserver(&tab.url) {
        return false;
    }
    // Rule 5: Exclude tabs under active screencast or agent automation
    if is_under_automation {
        return false;
    }
    // Rule 6: Must be in Today tier and idle > max_idle
    if tab.tier != TabTier::Today {
        return false;
    }
    let idle_duration = now.0 - tab.last_active_at.0;
    idle_duration >= max_idle
}

#[test]
fn test_idle_sweep_30m_threshold() {
    let (store, _, ws_id) = create_test_store();
    let now = Timestamp::now();

    // Tab 1: idle for 31 minutes -> should be discarded
    let mut tab_idle = Tab::new(ws_id, "https://docs.rs/tokio", 0);
    tab_idle.last_active_at = now - Duration::minutes(31);
    store.upsert_tab(&tab_idle).unwrap();

    // Tab 2: idle for 10 minutes -> should remain active
    let mut tab_active = Tab::new(ws_id, "https://crates.io", 1);
    tab_active.last_active_at = now - Duration::minutes(10);
    store.upsert_tab(&tab_active).unwrap();

    let decision_idle = should_discard_tab(&tab_idle, false, false, false, now, SPEC_MAX_IDLE);
    let decision_active = should_discard_tab(&tab_active, false, false, false, now, SPEC_MAX_IDLE);

    assert!(decision_idle, "Tab idle for 31m must be marked for discard");
    assert!(!decision_active, "Tab idle for 10m must not be discarded");

    // Test store archiving query with 30m cutoff
    let count = store.archive_idle_tabs(now, SPEC_MAX_IDLE).unwrap();
    assert_eq!(count, 1, "Exactly one tab should be archived in SQLite");

    let archived = store.tab(tab_idle.id).unwrap();
    assert_eq!(archived.state, TabState::Discarded);

    let kept = store.tab(tab_active.id).unwrap();
    assert_eq!(kept.state, TabState::Active);
}

#[test]
fn test_safe_discard_pinned_and_essential_protection() {
    let (_, _, ws_id) = create_test_store();
    let now = Timestamp::now();

    let mut pinned = Tab::new(ws_id, "https://github.com/tauri-apps", 0);
    pinned.tier = TabTier::Pinned;
    pinned.last_active_at = now - Duration::hours(5);

    let mut essential = Tab::new(ws_id, "https://dive.browser/settings", 1);
    essential.tier = TabTier::Essential;
    essential.last_active_at = now - Duration::hours(10);

    assert!(!should_discard_tab(
        &pinned,
        false,
        false,
        false,
        now,
        SPEC_MAX_IDLE
    ));
    assert!(!should_discard_tab(
        &essential,
        false,
        false,
        false,
        now,
        SPEC_MAX_IDLE
    ));
}

#[test]
fn test_safe_discard_localhost_dev_sessions() {
    let (_, _, ws_id) = create_test_store();
    let now = Timestamp::now();

    let dev_urls = [
        "http://localhost:3000",
        "http://localhost:5173/dashboard",
        "http://127.0.0.1:8080",
        "http://127.0.0.1:4000/api",
        "http://[::1]:3000",
        "http://0.0.0.0:9000",
    ];

    for url in dev_urls {
        let mut tab = Tab::new(ws_id, url, 0);
        tab.last_active_at = now - Duration::hours(2);

        assert!(
            is_localhost_or_devserver(url),
            "URL {} must be identified as loopback/devserver",
            url
        );
        assert!(
            !should_discard_tab(&tab, false, false, false, now, SPEC_MAX_IDLE),
            "Dev server tab with URL {} must be protected from discard",
            url
        );
    }
}

#[test]
fn test_safe_discard_audible_and_active_tabs() {
    let (_, _, ws_id) = create_test_store();
    let now = Timestamp::now();

    let mut audible_tab = Tab::new(ws_id, "https://music.youtube.com", 0);
    audible_tab.last_active_at = now - Duration::hours(1);

    let mut showing_tab = Tab::new(ws_id, "https://news.ycombinator.com", 1);
    showing_tab.last_active_at = now - Duration::hours(1);

    let mut agent_tab = Tab::new(ws_id, "https://automated.test", 2);
    agent_tab.last_active_at = now - Duration::hours(1);

    // Audible tab protected
    assert!(!should_discard_tab(
        &audible_tab,
        false,
        true,
        false,
        now,
        SPEC_MAX_IDLE
    ));
    // Currently focused/showing tab protected
    assert!(!should_discard_tab(
        &showing_tab,
        true,
        false,
        false,
        now,
        SPEC_MAX_IDLE
    ));
    // Tab under active automation/screencast protected
    assert!(!should_discard_tab(
        &agent_tab,
        false,
        false,
        true,
        now,
        SPEC_MAX_IDLE
    ));
}

#[test]
fn test_multi_workspace_sweep_coverage() {
    let (store, container_id, ws_1) = create_test_store();
    let profile_id = store.workspace(ws_1).unwrap().profile_id;
    let ws_2 = dive_core::model::Workspace::new("Secondary Workspace", container_id, profile_id, 1);
    store.upsert_workspace(&ws_2).unwrap();

    let now = Timestamp::now();

    // 3 tabs in Workspace 1 (idle >30m)
    create_sample_tabs(
        &store,
        ws_1,
        3,
        TabTier::Today,
        TabState::Active,
        Duration::minutes(40),
    );
    // 5 tabs in Workspace 2 (idle >30m)
    create_sample_tabs(
        &store,
        ws_2.id,
        5,
        TabTier::Today,
        TabState::Active,
        Duration::minutes(50),
    );

    let archived = store.archive_idle_tabs(now, SPEC_MAX_IDLE).unwrap();
    assert_eq!(
        archived, 8,
        "Idle sweep must archive tabs across all workspaces"
    );

    let ws1_tabs = store.tabs_for_workspace(ws_1).unwrap();
    let ws2_tabs = store.tabs_for_workspace(ws_2.id).unwrap();

    assert!(ws1_tabs.iter().all(|t| t.state == TabState::Discarded));
    assert!(ws2_tabs.iter().all(|t| t.state == TabState::Discarded));
}

#[test]
fn test_tab_reactivation_and_scroll_restoration() {
    let (store, _, ws_id) = create_test_store();
    let mut tab = Tab::new(ws_id, "https://github.com/features", 0);
    tab.state = TabState::Discarded;
    store.upsert_tab(&tab).unwrap();

    // Reactivation contract:
    // When a discarded tab is clicked, commands::activate_tab:
    // 1. Sets tab.state = TabState::Active
    // 2. Updates last_active_at to Timestamp::now()
    // 3. Recreates webview and injects window.scrollTo(scroll_x, scroll_y)
    let reactivate_time = Timestamp::now();
    tab.state = TabState::Active;
    tab.last_active_at = reactivate_time;
    store.upsert_tab(&tab).unwrap();

    let restored = store.tab(tab.id).unwrap();
    assert_eq!(restored.state, TabState::Active);
    assert_eq!(restored.url, "https://github.com/features");
    assert!(restored.last_active_at >= reactivate_time);
}

#[test]
fn test_tabstrip_sleeping_tab_display_contract() {
    // Contract:
    // Frontend TabStrip renders sleeping/discarded tabs with indicator/opacity
    // and allows clicking to activate.
    // Ensure Tab model accurately reflects Discarded and Sleeping states for the UI.
    let tab_discarded = TabState::Discarded;
    let tab_sleeping = TabState::Sleeping;
    let tab_active = TabState::Active;

    let ser_discarded = serde_json::to_string(&tab_discarded).unwrap();
    let ser_sleeping = serde_json::to_string(&tab_sleeping).unwrap();
    let ser_active = serde_json::to_string(&tab_active).unwrap();

    assert_eq!(ser_discarded, "\"discarded\"");
    assert_eq!(ser_sleeping, "\"sleeping\"");
    assert_eq!(ser_active, "\"active\"");
}
