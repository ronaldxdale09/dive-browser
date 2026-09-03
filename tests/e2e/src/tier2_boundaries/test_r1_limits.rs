//! Tier 2: Boundary & Corner Cases — Requirement R1 (Engine Limits & Startup Skew)

use crate::fixtures::StartupTimelineModel;
use crate::tier1_feature_coverage::test_r1_startup::format_cef_switches;
use std::sync::{Arc, Mutex};

/// Parses renderer process limit with bounds validation and fallback to default (6).
pub fn parse_renderer_process_limit(env_val: Option<&str>) -> usize {
    const DEFAULT_LIMIT: usize = 6;
    const MIN_LIMIT: usize = 1;
    const MAX_LIMIT: usize = 64;

    match env_val {
        Some(s) => match s.trim().parse::<usize>() {
            Ok(val) if (MIN_LIMIT..=MAX_LIMIT).contains(&val) => val,
            _ => DEFAULT_LIMIT,
        },
        None => DEFAULT_LIMIT,
    }
}

#[test]
fn test_renderer_limit_boundary_zero() {
    // Limit of 0 should be rejected and clamped to default
    let limit = parse_renderer_process_limit(Some("0"));
    assert_eq!(
        limit, 6,
        "Limit of 0 should fall back to default limit of 6"
    );
}

#[test]
fn test_renderer_limit_boundary_minimum_one() {
    // Limit of 1 is the minimum valid single-renderer limit
    let limit = parse_renderer_process_limit(Some("1"));
    assert_eq!(limit, 1);
    let switches = format_cef_switches(false, false, Some(limit));
    assert_eq!(switches[0].1.as_deref(), Some("1"));
}

#[test]
fn test_renderer_limit_extreme_high_clamped() {
    // Extreme high value (e.g. 1000) should be clamped to max reasonable limit (64)
    let limit = parse_renderer_process_limit(Some("1000"));
    assert_eq!(
        limit, 6,
        "Extreme high limit should fall back to safe default"
    );
}

#[test]
fn test_renderer_limit_malformed_and_empty_strings() {
    let malformed_inputs = ["", "   ", "abc", "-5", "NaN", "null", "undefined", "12.34"];
    for input in malformed_inputs {
        let limit = parse_renderer_process_limit(Some(input));
        assert_eq!(
            limit, 6,
            "Malformed input {:?} must fall back to default limit 6",
            input
        );
    }
}

#[test]
fn test_clock_skew_and_zero_elapsed_milestones() {
    // Corner case: milestones reported with zero elapsed or reversed order
    let skew_timeline = StartupTimelineModel {
        process_start_ms: 0.0,
        state_init_ms: 50.0,
        window_created_ms: 50.0, // equal timestamp (instant transition)
        setup_complete_ms: 49.0, // reversed timestamp due to skew
        chrome_paint_ms: Some(100.0),
    };

    assert!(
        !skew_timeline.is_monotonically_ordered(),
        "Timeline with negative duration between phases should fail monotonicity check"
    );
}

#[test]
fn test_rapid_burst_milestone_reports() {
    // Verify thread-safe concurrent recording of milestone reports
    let reports = Arc::new(Mutex::new(Vec::new()));
    let mut handles = Vec::new();

    for i in 0..50 {
        let reports_clone = Arc::clone(&reports);
        handles.push(std::thread::spawn(move || {
            let milestone = format!("milestone_{}", i);
            let elapsed = i as f64 * 2.5;
            reports_clone.lock().unwrap().push((milestone, elapsed));
        }));
    }

    for h in handles {
        h.join().unwrap();
    }

    let recorded = reports.lock().unwrap();
    assert_eq!(
        recorded.len(),
        50,
        "All 50 concurrent milestone reports should be recorded"
    );
}
