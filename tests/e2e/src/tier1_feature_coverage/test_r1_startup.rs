//! Tier 1: Feature Coverage — Requirement R1 (Engine Flags & Startup Performance)
//!
//! Features covered:
//! - Feature 1: `--disable-extensions` Chromium switch
//! - Feature 2: `--process-per-site` Chromium switch
//! - Feature 3: `--renderer-process-limit` switch (and DIVE_RENDERER_PROCESS_LIMIT env)
//! - Feature 4: Startup timeline instrumentation (StartupTimeline)
//!
//! These switch/timeline fixtures are model checks, not measurements of a running
//! browser. Real startup IPC, readiness, and failure handling are exercised by
//! `apps/desktop/src-tauri/src/startup.rs` and `lib.rs` unit tests, plus
//! `apps/desktop/src/lib/startup.test.ts` and `components/Splash.test.tsx`.
//! The process harness and its controlled failure fixtures live in
//! `scripts/startup_benchmark.py` and `scripts/tests/`.
//!
//! Renderer reports carry only `chrome_first_paint` or `controls_ready`; Rust
//! timestamps host receipt. Missing readiness produces a null total and nonzero
//! exit. Fabricated JSON values cannot validate that IPC or benchmark contract.

use crate::fixtures::StartupTimelineModel;

/// Helper function defining the expected Chromium command line switch format
/// as required by tauri-runtime-cef.
pub fn format_cef_switches(
    disable_extensions: bool,
    process_per_site: bool,
    renderer_process_limit: Option<usize>,
) -> Vec<(String, Option<String>)> {
    let mut switches = Vec::new();
    // Valueless switches must begin with '--' to prevent tauri-runtime-cef
    // from appending them as positional arguments.
    if disable_extensions {
        switches.push(("--disable-extensions".to_string(), None));
    }
    if process_per_site {
        switches.push(("--process-per-site".to_string(), None));
    }
    if let Some(limit) = renderer_process_limit {
        switches.push((
            "renderer-process-limit".to_string(),
            Some(limit.to_string()),
        ));
    }
    switches
}

#[test]
fn test_cli_flags_disable_extensions_switch() {
    let switches = format_cef_switches(true, false, None);
    assert_eq!(switches.len(), 1);
    let (flag, val) = &switches[0];
    assert_eq!(flag, "--disable-extensions");
    assert!(val.is_none(), "Valueless switch should have None value");
    assert!(
        flag.starts_with("--"),
        "Chromium valueless switches in CEF must start with '--'"
    );
}

#[test]
fn test_cli_flags_process_per_site_switch() {
    let switches = format_cef_switches(false, true, None);
    assert_eq!(switches.len(), 1);
    let (flag, val) = &switches[0];
    assert_eq!(flag, "--process-per-site");
    assert!(val.is_none());
    assert!(flag.starts_with("--"));
}

#[test]
fn test_cli_flags_renderer_process_limit_switch() {
    let limit = 8;
    let switches = format_cef_switches(false, false, Some(limit));
    assert_eq!(switches.len(), 1);
    let (flag, val) = &switches[0];
    assert_eq!(flag, "renderer-process-limit");
    assert_eq!(val.as_deref(), Some("8"));
}

#[test]
fn test_cli_flags_combined_optimization_suite() {
    let switches = format_cef_switches(true, true, Some(6));
    assert_eq!(switches.len(), 3);

    let has_disable_ext = switches
        .iter()
        .any(|(f, v)| f == "--disable-extensions" && v.is_none());
    let has_proc_per_site = switches
        .iter()
        .any(|(f, v)| f == "--process-per-site" && v.is_none());
    let has_limit = switches
        .iter()
        .any(|(f, v)| f == "renderer-process-limit" && v.as_deref() == Some("6"));

    assert!(has_disable_ext, "Missing --disable-extensions switch");
    assert!(has_proc_per_site, "Missing --process-per-site switch");
    assert!(has_limit, "Missing renderer-process-limit switch");
}

#[test]
fn test_startup_timeline_monotonic_milestones() {
    let timeline = StartupTimelineModel {
        process_start_ms: 0.0,
        state_init_ms: 25.4,
        window_created_ms: 88.1,
        setup_complete_ms: 142.3,
        chrome_paint_ms: Some(210.0),
    };

    assert!(
        timeline.is_monotonically_ordered(),
        "Timeline milestones must be monotonically non-decreasing"
    );
    assert!(timeline.state_init_ms > timeline.process_start_ms);
    assert!(timeline.window_created_ms > timeline.state_init_ms);
    assert!(timeline.setup_complete_ms > timeline.window_created_ms);
    assert!(timeline.chrome_paint_ms.unwrap() > timeline.setup_complete_ms);

    // Verify serialization round-trip
    let json_str = serde_json::to_string(&timeline).expect("Failed to serialize StartupTimeline");
    let deserialized: StartupTimelineModel =
        serde_json::from_str(&json_str).expect("Failed to deserialize StartupTimeline");
    assert_eq!(timeline, deserialized);
}
