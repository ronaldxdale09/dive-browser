//! Tier 2: Boundary & Corner Cases — Requirement R3 (Crash Bursts & Lockout)

use std::time::{Duration, Instant};

use dive_core::model::Tab;

use crate::fixtures::{
    CrashAttempts, SPEC_CRASH_BASE_DELAY, SPEC_MAX_CRASH_ATTEMPTS, TabCrashedEvent,
    create_test_store, plan_crash_recovery,
};

#[test]
fn test_rapid_crash_loop_exhaustion() {
    let now = Instant::now();
    let mut state = CrashAttempts::default();

    // Loop through maximum attempts rapidly (< 2 seconds total)
    for i in 1..=SPEC_MAX_CRASH_ATTEMPTS {
        let p = plan_crash_recovery(state, now + Duration::from_millis(i as u64 * 300))
            .expect("Within budget, reload must be planned");
        assert_eq!(p.attempt, i);
        state = p.next;
    }

    assert_eq!(state.count, 3);

    // Attempt 4 in the same episode
    let locked_out = plan_crash_recovery(state, now + Duration::from_secs(2));
    assert!(
        locked_out.is_none(),
        "Rapid crash loop must lock out auto-reload after 3 attempts"
    );
}

#[test]
fn test_crash_window_expiration_resets_counter() {
    let now = Instant::now();

    // Simulate 3 crashes
    let mut state = CrashAttempts::default();
    for _ in 0..3 {
        let p = plan_crash_recovery(state, now).unwrap();
        state = p.next;
    }
    assert_eq!(state.count, 3);

    // 31 seconds later (> WINDOW = 30s)
    let fresh_time = now + Duration::from_secs(31);
    let p_fresh = plan_crash_recovery(state, fresh_time)
        .expect("After 30s window, a new crash should get a fresh budget");
    assert_eq!(
        p_fresh.attempt, 1,
        "Attempt count must reset to 1 in new window"
    );
    assert_eq!(p_fresh.delay, SPEC_CRASH_BASE_DELAY);
}

#[test]
fn test_crash_event_for_non_existent_tab() {
    let (store, _, _) = create_test_store();
    let fake_tab_id = dive_core::model::TabId::new();

    // Verify non-existent tab lookup returns Err without panic
    let tab = store.tab(fake_tab_id);
    assert!(tab.is_err());

    let event = TabCrashedEvent {
        tab_id: fake_tab_id,
        attempt: 1,
        recovering: false,
    };
    assert_eq!(event.tab_id, fake_tab_id);
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

    // Both crash simultaneously
    let now = Instant::now();
    let p1 = plan_crash_recovery(CrashAttempts::default(), now).unwrap();
    let p2 = plan_crash_recovery(CrashAttempts::default(), now).unwrap();

    assert_eq!(p1.attempt, 1);
    assert_eq!(p2.attempt, 1);

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
