//! Startup timeline instrumentation and benchmarking harness for Dive.
//!
//! Tracks fine-grained lifecycle milestones from process start to initial
//! window paint and setup completion, and provides IPC hooks and automated
//! benchmark dumping.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde::{Deserialize, Serialize};

/// Earliest recorded process instant.
static START_INSTANT: OnceLock<Instant> = OnceLock::new();

/// Cached indicator whether this process launch began without an existing database.
static IS_COLD_LAUNCH: OnceLock<bool> = OnceLock::new();

/// Internal mutable timeline store.
static TIMELINE: Mutex<Option<StartupTimeline>> = Mutex::new(None);

/// Internal named milestone dictionary storing elapsed milliseconds.
static MILESTONES: Mutex<Option<HashMap<String, f64>>> = Mutex::new(None);

/// Flag indicating chrome paint milestone has been received.
static CHROME_PAINT_RECEIVED: AtomicBool = AtomicBool::new(false);

/// Custom serde serializer/deserializer for [`std::time::Instant`].
mod instant_serde {
    use serde::{self, Deserialize, Deserializer, Serializer};
    use std::time::Instant;

    pub fn serialize<S>(_: &Instant, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_f64(0.0)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Instant, D::Error>
    where
        D: Deserializer<'de>,
    {
        let _ = Option::<f64>::deserialize(deserializer)?;
        Ok(Instant::now())
    }
}

/// Key startup milestones recorded during application boot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StartupTimeline {
    /// Timestamp when process execution began.
    #[serde(default = "Instant::now", with = "instant_serde")]
    pub process_start: Instant,
    /// Elapsed milliseconds until SQLite store initialization and migrations completed.
    pub state_init_ms: f64,
    /// Elapsed milliseconds until the main native window was created.
    pub window_created_ms: f64,
    /// Elapsed milliseconds until Tauri setup hook completed.
    pub setup_complete_ms: f64,
    /// Host-observed elapsed milliseconds when the chrome FCP IPC arrived.
    pub chrome_paint_ms: Option<f64>,
}

impl StartupTimeline {
    /// Create a new timeline rooted at the provided process start instant.
    #[must_use]
    pub fn new(process_start: Instant) -> Self {
        Self {
            process_start,
            state_init_ms: 0.0,
            window_created_ms: 0.0,
            setup_complete_ms: 0.0,
            chrome_paint_ms: None,
        }
    }
}

/// Structured benchmark report emitted when running with `DIVE_STARTUP_BENCHMARK=1`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StartupBenchmarkReport {
    /// Whether this was a cold launch (fresh profile/database).
    pub cold_start: bool,
    /// Host-observed readiness time; absent until paint and usable controls are observed.
    pub total_startup_ms: Option<f64>,
    /// Timings include renderer scheduling and IPC delivery latency.
    pub timing_basis: String,
    /// Detailed timeline milestones.
    pub timeline: StartupTimeline,
    /// Milestone name to elapsed milliseconds map, including delta intervals.
    pub milestones: HashMap<String, f64>,
}

/// Record the process launch instant as early as possible.
pub fn record_launch() -> Instant {
    let instant = *START_INSTANT.get_or_init(Instant::now);
    // Cache cold start check before any state initialization creates dive.db
    let _ = IS_COLD_LAUNCH.get_or_init(detect_cold_start);
    let mut guard = TIMELINE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if guard.is_none() {
        *guard = Some(StartupTimeline::new(instant));
    }
    instant
}

/// Get the recorded process launch instant.
#[must_use]
pub fn launch_time() -> Instant {
    *START_INSTANT.get_or_init(Instant::now)
}

/// Compute milliseconds elapsed since process launch.
#[must_use]
#[allow(clippy::cast_precision_loss)]
pub fn elapsed_ms() -> f64 {
    launch_time().elapsed().as_secs_f64() * 1000.0
}

/// Record a milestone at the current timestamp.
pub fn record_milestone(name: &str) -> f64 {
    let elapsed = elapsed_ms();
    record_custom_milestone(name, elapsed);
    elapsed
}

/// Record a milestone with an explicitly provided elapsed millisecond duration.
pub fn record_custom_milestone(name: &str, elapsed: f64) {
    if !elapsed.is_finite() || elapsed < 0.0 {
        tracing::warn!(milestone = name, "ignoring invalid startup timestamp");
        return;
    }
    let mut milestones_guard = MILESTONES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let milestones = milestones_guard.get_or_insert_with(HashMap::new);
    if milestones.contains_key(name) {
        return;
    }
    milestones.insert(name.to_owned(), elapsed);

    let mut timeline_guard = TIMELINE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let timeline = timeline_guard.get_or_insert_with(|| StartupTimeline::new(launch_time()));

    match name {
        "state_init" => timeline.state_init_ms = elapsed,
        "window_created" => timeline.window_created_ms = elapsed,
        "setup_complete" => timeline.setup_complete_ms = elapsed,
        "chrome_first_paint" | "chrome_paint" => {
            timeline.chrome_paint_ms = Some(elapsed);
            CHROME_PAINT_RECEIVED.store(true, Ordering::SeqCst);
        }
        _ => {}
    }

    tracing::info!(milestone = name, elapsed_ms = %elapsed, "startup milestone recorded");
}

/// Retrieve a snapshot of the current [`StartupTimeline`].
#[must_use]
pub fn get_timeline() -> StartupTimeline {
    let mut guard = TIMELINE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    guard
        .get_or_insert_with(|| StartupTimeline::new(launch_time()))
        .clone()
}

/// Retrieve a snapshot of all recorded milestone timings.
#[must_use]
pub fn get_milestones() -> HashMap<String, f64> {
    let mut guard = MILESTONES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    guard.get_or_insert_with(HashMap::new).clone()
}

/// Check whether the chrome paint milestone has been received.
#[must_use]
pub fn has_chrome_paint() -> bool {
    CHROME_PAINT_RECEIVED.load(Ordering::SeqCst)
}

/// Detect whether the current launch is cold (fresh profile/database).
#[must_use]
pub fn detect_cold_start() -> bool {
    if let Ok(val) = std::env::var("DIVE_COLD_START") {
        return val == "1" || val.eq_ignore_ascii_case("true");
    }
    let db_path = crate::state::data_root().join("dive.db");
    !db_path.exists()
}

/// Determine cold start status for the benchmark report.
#[must_use]
pub fn is_cold_launch() -> bool {
    *IS_COLD_LAUNCH.get_or_init(detect_cold_start)
}

/// Generate a structured [`StartupBenchmarkReport`] from current metrics.
#[must_use]
pub fn generate_benchmark_report(cold_start: bool) -> StartupBenchmarkReport {
    let timeline = get_timeline();
    let mut milestones = get_milestones();

    milestones.insert("process_start_ms".into(), 0.0);
    milestones.insert("state_init_ms".into(), timeline.state_init_ms);
    milestones.insert("window_created_ms".into(), timeline.window_created_ms);
    milestones.insert("setup_complete_ms".into(), timeline.setup_complete_ms);

    let state_init_to_window = timeline.window_created_ms - timeline.state_init_ms;
    let window_to_setup = timeline.setup_complete_ms - timeline.window_created_ms;

    milestones.insert("process_to_state_init_ms".into(), timeline.state_init_ms);
    milestones.insert(
        "state_init_to_window_created_ms".into(),
        state_init_to_window,
    );
    milestones.insert(
        "window_created_to_setup_complete_ms".into(),
        window_to_setup,
    );

    if let Some(paint_ms) = timeline.chrome_paint_ms {
        milestones.insert("chrome_paint_ms".into(), paint_ms);
        milestones.insert(
            "setup_to_chrome_fcp_ms".into(),
            paint_ms - timeline.setup_complete_ms,
        );
    }

    let total_startup_ms = milestones
        .get("controls_ready")
        .copied()
        .filter(|controls| {
            ["state_init", "window_created", "setup_complete"]
                .iter()
                .all(|name| milestones.contains_key(*name))
                && timeline.window_created_ms >= timeline.state_init_ms
                && timeline.setup_complete_ms >= timeline.window_created_ms
                && timeline
                    .chrome_paint_ms
                    .is_some_and(|paint| paint >= timeline.window_created_ms && *controls >= paint)
                && *controls >= timeline.setup_complete_ms
        });

    StartupBenchmarkReport {
        cold_start,
        total_startup_ms,
        timing_basis: "host_observed_since_record_launch".into(),
        timeline,
        milestones,
    }
}

/// Serialize current benchmark metrics to pretty JSON string.
#[must_use]
pub fn dump_benchmark_json() -> String {
    let report = generate_benchmark_report(is_cold_launch());
    serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".into())
}

/// Write the startup benchmark JSON report to disk and stdout.
///
/// Output destination resolves in order:
/// 1. `output_path` parameter if provided
/// 2. `DIVE_BENCHMARK_OUTPUT` environment variable
/// 3. Default path `target/startup-benchmark.json`
pub fn write_benchmark_file(output_path: Option<&Path>) -> std::io::Result<PathBuf> {
    let json = dump_benchmark_json();
    let resolved_path = if let Some(p) = output_path {
        p.to_path_buf()
    } else if let Some(env_path) = std::env::var_os("DIVE_BENCHMARK_OUTPUT") {
        PathBuf::from(env_path)
    } else {
        PathBuf::from("target/startup-benchmark.json")
    };

    if let Some(parent) = resolved_path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)?;
    }

    std::fs::write(&resolved_path, &json)?;
    println!("DIVE_STARTUP_BENCHMARK_JSON: {json}");
    tracing::info!(path = %resolved_path.display(), "wrote startup benchmark report");

    Ok(resolved_path)
}

fn finish_benchmark(output_path: Option<&Path>) -> i32 {
    let complete = generate_benchmark_report(is_cold_launch())
        .total_startup_ms
        .is_some();
    if let Err(error) = write_benchmark_file(output_path) {
        tracing::error!(%error, "failed to write startup benchmark report");
        return 2;
    }
    if !complete {
        tracing::error!("startup benchmark incomplete: paint and usable controls are required");
        return 1;
    }
    0
}

/// Background handler spawned when `DIVE_STARTUP_BENCHMARK=1` is set.
///
/// Waits for paint AND usable controls. A timeout writes an incomplete report
/// and exits unsuccessfully; a report write error also produces a nonzero exit.
pub fn on_setup_completed(app: tauri::AppHandle<crate::Runtime>) {
    if std::env::var("DIVE_STARTUP_BENCHMARK").as_deref() != Ok("1") {
        return;
    }

    tauri::async_runtime::spawn(async move {
        let timeout_ms = std::env::var("DIVE_BENCHMARK_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(10_000);

        let start = Instant::now();
        let interval = std::time::Duration::from_millis(50);
        while start.elapsed().as_millis() < u128::from(timeout_ms) {
            tokio::time::sleep(interval).await;
            if generate_benchmark_report(is_cold_launch())
                .total_startup_ms
                .is_some()
            {
                break;
            }
        }

        app.exit(finish_benchmark(None));
    });
}

/// Timestamp a renderer milestone at host receipt on the process launch clock.
/// Only the main chrome may report the two supported renderer observations.
pub fn observe_renderer_milestone(
    webview: &str,
    window: &str,
    milestone: &str,
) -> Result<(), String> {
    if webview != crate::CHROME_LABEL || window != crate::MAIN_WINDOW {
        return Err("startup observations are restricted to the main chrome".into());
    }
    match milestone {
        "chrome_first_paint" => {}
        "controls_ready" if has_chrome_paint() => {}
        "controls_ready" => {
            return Err("contentful paint must be observed before controls readiness".into());
        }
        _ => return Err("unsupported startup milestone".into()),
    }
    record_milestone(milestone);
    Ok(())
}

/// Format the required Chromium command-line switches for CEF runtime.
///
/// Switches comply strictly with `tauri-runtime-cef` switch parsing:
/// - Valueless switches start with `--` to avoid being treated as positional arguments.
/// - Valued switches have no leading `--` prefix so the runtime does not double-dash them.
#[must_use]
pub fn build_chromium_args(renderer_limit: Option<&str>) -> Vec<(&'static str, Option<String>)> {
    let extension_paths = crate::extensions::startup_paths();
    crate::extensions::mark_started(&extension_paths);
    build_chromium_args_with(
        renderer_limit,
        &std::env::var("DIVE_CHROMIUM_FLAGS").unwrap_or_default(),
        std::env::var_os("DIVE_USE_MOCK_KEYCHAIN").is_some(),
        &extension_paths,
    )
}

fn build_chromium_args_with(
    renderer_limit: Option<&str>,
    chromium_flags: &str,
    use_mock_keychain: bool,
    extension_paths: &[String],
) -> Vec<(&'static str, Option<String>)> {
    let limit = renderer_limit
        .map(str::to_owned)
        .or_else(|| std::env::var("DIVE_RENDERER_PROCESS_LIMIT").ok())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "6".to_string());

    let mut args = Vec::new();
    if use_mock_keychain {
        args.push(("use-mock-keychain", Some(String::new())));
    }
    if !extension_paths.is_empty() {
        args.push(("load-extension", Some(extension_paths.join(","))));
    }
    // `DIVE_DEFAULT_PROCESS_MODEL=1` leaves Chromium's own process model in
    // place, for telling a process-model fault apart from anything else.
    if std::env::var_os("DIVE_DEFAULT_PROCESS_MODEL").is_none() {
        args.push(("--process-per-site", None));
        args.push(("renderer-process-limit", Some(limit)));
    }
    let mut extra = extra_chromium_args(chromium_flags);
    // Chromium honours only the last `disable-features`, so ours and any
    // from the environment are folded into one switch.
    let mut disabled: Vec<String> = DISABLED_FEATURES.iter().map(|f| (*f).to_owned()).collect();
    extra.retain(|(name, value)| {
        if *name == "disable-features" {
            if let Some(v) = value {
                disabled.extend(v.split(',').filter(|f| !f.is_empty()).map(str::to_owned));
            }
            false
        } else {
            true
        }
    });
    args.push(("disable-features", Some(disabled.join(","))));
    args.extend(extra);
    args
}

/// Chromium features that must stay off in an embedded engine.
///
/// `ImmersiveReadAnything` (reading mode) installs a soft-navigation observer
/// that asks `tabs::TabInterface::GetFromContents` for the Chrome tab behind
/// a page. There is no such tab in CEF, and the observer dereferences the
/// null it gets back, taking the whole browser process down the first time
/// a page navigates within itself. `YouTube` does that as soon as a video
/// starts. Symbolised from the crash on CEF 151.3.12; Chromium 151.
pub const DISABLED_FEATURES: &[&str] = &["ImmersiveReadAnything"];

/// Parse `DIVE_CHROMIUM_FLAGS`: whitespace-separated switches, either
/// `--name` (valueless) or `name=value`, for experiments without a rebuild.
pub fn extra_chromium_args(spec: &str) -> Vec<(&'static str, Option<String>)> {
    spec.split_whitespace()
        .filter_map(|item| {
            if let Some((name, value)) = item.split_once('=') {
                let name = name.trim_start_matches('-');
                (!name.is_empty()).then(|| {
                    (
                        Box::leak(name.to_owned().into_boxed_str()) as &'static str,
                        Some(value.to_owned()),
                    )
                })
            } else {
                let name = item.trim_start_matches('-');
                (!name.is_empty()).then(|| {
                    (
                        Box::leak(format!("--{name}").into_boxed_str()) as &'static str,
                        None,
                    )
                })
            }
        })
        .collect()
}

/// Validate that Chromium switches adhere to CEF command-line processing rules.
pub fn validate_switch_syntax(args: &[(&str, Option<String>)]) -> Result<(), String> {
    for &(switch, ref val) in args {
        if val.is_none() {
            if !switch.starts_with('-') {
                return Err(format!(
                    "valueless switch '{switch}' must start with '-' to avoid positional arg parse"
                ));
            }
        } else if switch.starts_with('-') {
            return Err(format!(
                "valued switch '{switch}' should not start with '-' to prevent double dash prefix"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Reset global benchmark state for isolated unit testing.
#[cfg(test)]
pub(crate) fn reset_for_test(new_launch: Option<Instant>) {
    let instant = new_launch.unwrap_or_else(Instant::now);
    // Do not hold both locks at once. Production milestone recording takes
    // MILESTONES before TIMELINE; taking them in the opposite order here can
    // deadlock when startup tests run concurrently.
    {
        let mut milestones_guard = MILESTONES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *milestones_guard = Some(HashMap::new());
    }
    {
        let mut timeline_guard = TIMELINE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *timeline_guard = Some(StartupTimeline::new(instant));
    }

    CHROME_PAINT_RECEIVED.store(false, Ordering::SeqCst);
}

#[cfg(test)]
#[allow(clippy::float_cmp)]
mod tests {
    #[test]
    fn reading_mode_is_always_disabled_and_merged_with_extra_disable_features() {
        let args = build_chromium_args(None);
        let disabled = args
            .iter()
            .find(|(n, _)| *n == "disable-features")
            .and_then(|(_, v)| v.clone())
            .expect("a disable-features switch");
        assert!(disabled.contains("ImmersiveReadAnything"), "{disabled}");
        assert_eq!(
            args.iter()
                .filter(|(n, _)| *n == "disable-features")
                .count(),
            1,
            "one switch, or Chromium keeps only the last"
        );
        let mut merged = extra_chromium_args("disable-features=A,B --x");
        let mut folded: Vec<String> = DISABLED_FEATURES.iter().map(|f| (*f).to_owned()).collect();
        merged.retain(|(n, v)| {
            if *n == "disable-features" {
                folded.extend(v.iter().flat_map(|v| v.split(',')).map(str::to_owned));
                false
            } else {
                true
            }
        });
        assert_eq!(folded, ["ImmersiveReadAnything", "A", "B"]);
        assert_eq!(merged, [("--x", None)]);
    }

    #[test]
    fn extra_flags_parse_both_forms_and_survive_switch_validation() {
        let args = extra_chromium_args("--disable-gpu disable-features=A,B  --x= ");
        assert_eq!(args[0], ("--disable-gpu", None));
        assert_eq!(args[1], ("disable-features", Some("A,B".to_string())));
        assert_eq!(args[2], ("x", Some(String::new())));
        assert!(validate_switch_syntax(&args).is_ok());
        assert!(extra_chromium_args("").is_empty());
    }

    use super::*;

    #[test]
    fn test_chromium_args_default_formatting() {
        let args = build_chromium_args_with(None, "", false, &[]);
        assert_eq!(args.len(), 3);

        assert_eq!(args[0], ("--process-per-site", None));
        assert_eq!(args[1], ("renderer-process-limit", Some("6".to_string())));
        assert_eq!(
            args[2],
            (
                "disable-features",
                Some("ImmersiveReadAnything".to_string())
            )
        );

        assert!(validate_switch_syntax(&args).is_ok());
    }

    #[test]
    fn test_chromium_args_custom_limit() {
        let args = build_chromium_args_with(Some("12"), "", false, &[]);
        assert_eq!(args[1], ("renderer-process-limit", Some("12".to_string())));
        assert!(validate_switch_syntax(&args).is_ok());
    }

    #[test]
    fn extensions_and_mock_keychain_are_explicit_startup_choices() {
        let paths = vec!["/a/extension".to_owned(), "/z/extension".to_owned()];
        let args = build_chromium_args_with(None, "", true, &paths);
        assert_eq!(args[0], ("use-mock-keychain", Some(String::new())));
        assert_eq!(
            args[1],
            (
                "load-extension",
                Some("/a/extension,/z/extension".to_owned())
            )
        );
        assert!(!args.iter().any(|(name, _)| *name == "--disable-extensions"));
    }

    #[test]
    fn test_validate_switch_syntax_detects_errors() {
        let bad_valueless = [("disable-extensions", None)];
        assert!(validate_switch_syntax(&bad_valueless).is_err());

        let bad_valued = [("--renderer-process-limit", Some("6".to_string()))];
        assert!(validate_switch_syntax(&bad_valued).is_err());
    }

    #[test]
    fn test_timeline_milestones_and_intervals() {
        let _serial = test_lock();
        let launch = Instant::now();
        reset_for_test(Some(launch));

        record_custom_milestone("state_init", 15.5);
        record_custom_milestone("window_created", 45.0);
        record_custom_milestone("setup_complete", 62.0);
        record_custom_milestone("chrome_first_paint", 110.0);
        record_custom_milestone("controls_ready", 125.0);

        let timeline = get_timeline();
        assert_eq!(timeline.state_init_ms, 15.5);
        assert_eq!(timeline.window_created_ms, 45.0);
        assert_eq!(timeline.setup_complete_ms, 62.0);
        assert_eq!(timeline.chrome_paint_ms, Some(110.0));

        let report = generate_benchmark_report(true);
        assert!(report.cold_start);
        assert_eq!(report.total_startup_ms, Some(125.0));

        assert_eq!(
            report.milestones.get("process_to_state_init_ms"),
            Some(&15.5)
        );
        assert_eq!(
            report.milestones.get("state_init_to_window_created_ms"),
            Some(&29.5)
        );
        assert_eq!(
            report.milestones.get("window_created_to_setup_complete_ms"),
            Some(&17.0)
        );
        assert_eq!(report.milestones.get("setup_to_chrome_fcp_ms"), Some(&48.0));
    }

    #[test]
    fn incomplete_startup_never_reports_success_from_setup_or_paint_alone() {
        let _serial = test_lock();
        reset_for_test(None);
        record_custom_milestone("state_init", 10.0);
        record_custom_milestone("window_created", 30.0);
        record_custom_milestone("setup_complete", 40.0);
        let report: serde_json::Value = serde_json::from_str(&dump_benchmark_json()).unwrap();
        assert!(report["total_startup_ms"].is_null());
        record_custom_milestone("chrome_first_paint", 50.0);
        let report: serde_json::Value = serde_json::from_str(&dump_benchmark_json()).unwrap();
        assert!(report["total_startup_ms"].is_null());
    }

    #[test]
    fn duplicate_reports_preserve_the_first_observation() {
        let _serial = test_lock();
        reset_for_test(None);
        record_custom_milestone("chrome_first_paint", 50.0);
        record_custom_milestone("chrome_first_paint", 100.0);
        assert_eq!(get_timeline().chrome_paint_ms, Some(50.0));
    }

    #[test]
    fn renderer_observations_reject_foreign_chrome_unknown_names_and_wrong_order() {
        let _serial = test_lock();
        reset_for_test(None);
        assert!(observe_renderer_milestone("tab-1", "main", "chrome_first_paint").is_err());
        assert!(observe_renderer_milestone("chrome", "popout-1", "chrome_first_paint").is_err());
        assert!(observe_renderer_milestone("chrome", "main", "state_init").is_err());
        assert!(observe_renderer_milestone("chrome", "main", "controls_ready").is_err());
        assert!(get_milestones().is_empty());
        let before = elapsed_ms();
        observe_renderer_milestone("chrome", "main", "chrome_first_paint").unwrap();
        let after = elapsed_ms();
        let paint = get_timeline().chrome_paint_ms.unwrap();
        assert!(paint >= before && paint <= after);
        observe_renderer_milestone("chrome", "main", "controls_ready").unwrap();
        assert!(get_milestones()["controls_ready"] >= paint);
    }

    #[test]
    fn benchmark_exit_fails_on_missing_observations_or_unwritable_output() {
        let _serial = test_lock();
        reset_for_test(None);
        let root = std::env::temp_dir().join(format!("dive-startup-{}", dive_core::TabId::new()));
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(finish_benchmark(Some(&root.join("missing.json"))), 1);
        record_custom_milestone("state_init", 10.0);
        record_custom_milestone("window_created", 25.0);
        record_custom_milestone("setup_complete", 35.0);
        record_custom_milestone("chrome_first_paint", 40.0);
        record_custom_milestone("controls_ready", 45.0);
        assert_eq!(finish_benchmark(Some(&root.join("complete.json"))), 0);
        assert_eq!(finish_benchmark(Some(&root)), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn test_timeline_serde_roundtrip() {
        let timeline = StartupTimeline {
            process_start: Instant::now(),
            state_init_ms: 12.0,
            window_created_ms: 40.0,
            setup_complete_ms: 55.0,
            chrome_paint_ms: Some(95.0),
        };

        let json = serde_json::to_string(&timeline).expect("failed to serialize timeline");
        assert!(json.contains("\"state_init_ms\":12.0"));
        assert!(json.contains("\"chrome_paint_ms\":95.0"));

        let deserialized: StartupTimeline =
            serde_json::from_str(&json).expect("failed to deserialize timeline");
        assert_eq!(deserialized.state_init_ms, 12.0);
        assert_eq!(deserialized.chrome_paint_ms, Some(95.0));
    }

    #[test]
    fn test_benchmark_report_json_export() {
        let _serial = test_lock();
        reset_for_test(None);
        record_custom_milestone("state_init", 10.0);
        record_custom_milestone("window_created", 30.0);
        record_custom_milestone("setup_complete", 40.0);

        let json = dump_benchmark_json();
        let parsed: serde_json::Value =
            serde_json::from_str(&json).expect("invalid benchmark JSON");
        assert!(parsed.get("timeline").is_some());
        assert!(parsed.get("milestones").is_some());
        assert!(parsed.get("total_startup_ms").is_some());
    }

    #[test]
    fn test_write_benchmark_file_to_temp_path() {
        let _serial = test_lock();
        reset_for_test(None);
        record_custom_milestone("state_init", 10.0);
        record_custom_milestone("window_created", 25.0);
        record_custom_milestone("setup_complete", 35.0);

        let temp_dir = std::env::temp_dir().join("dive_test_bench");
        let temp_file = temp_dir.join("test_startup.json");

        let written = write_benchmark_file(Some(&temp_file)).expect("write should succeed");
        assert_eq!(written, temp_file);
        assert!(temp_file.exists());

        let contents = std::fs::read_to_string(&temp_file).expect("should read file");
        assert!(contents.contains("state_init_ms"));

        let _ = std::fs::remove_file(temp_file);
        let _ = std::fs::remove_dir(temp_dir);
    }
}
