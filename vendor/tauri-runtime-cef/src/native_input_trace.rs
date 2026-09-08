// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Opt-in, bounded timing receipts. Never serialize an event, key or page data.
//! `post_key` marks renderer fallback, not execution of a native menu action.

use std::{
    io::Write,
    sync::{Mutex, OnceLock},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const LIMIT: u64 = 256;
const WINDOW_MS: u64 = 500;

fn gate(trace: &str, probe: &str, mock: &str, profile: bool, competing: bool) -> bool {
    trace == "1" && probe == "1" && mock == "1" && profile && !competing
}

pub(crate) fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        gate(
            &std::env::var("DIVE_UI_INPUT_NATIVE_TRACE").unwrap_or_default(),
            &std::env::var("DIVE_UI_PROBE").unwrap_or_default(),
            &std::env::var("DIVE_USE_MOCK_KEYCHAIN").unwrap_or_default(),
            std::env::var_os("DIVE_DATA_DIR").is_some_and(|value| !value.is_empty()),
            [
                "DIVE_NATIVE_LIFECYCLE_PROBE",
                "DIVE_STRESS_TABS",
                "DIVE_SMOKE",
                "DIVE_CDP_BENCH",
            ]
            .iter()
            .any(|key| std::env::var_os(key).is_some()),
        )
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum KeyClass {
    Launcher,
    SelectAll,
    Other,
}

impl KeyClass {
    fn name(self) -> &'static str {
        match self {
            Self::Launcher => "launcher",
            Self::SelectAll => "select_all",
            Self::Other => "other",
        }
    }
}

pub(crate) fn classify_key(
    macos: bool,
    raw_key_down: bool,
    key_code: i32,
    command: bool,
    control: bool,
    alt: bool,
    shift: bool,
) -> KeyClass {
    if macos && raw_key_down && command && !control && !alt && !shift {
        match key_code {
            84 => KeyClass::Launcher,
            65 => KeyClass::SelectAll,
            _ => KeyClass::Other,
        }
    } else {
        KeyClass::Other
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Stage {
    PreKey,
    PostKey,
    ProxySend,
    UserEventImmediate,
    UserEventEnqueued,
    UserEventDispatch,
    SetFocusBegin,
    SetFocusEnd,
    #[cfg(target_os = "macos")]
    DirectSubmit,
    #[cfg(target_os = "macos")]
    DirectFocus,
}

impl Stage {
    fn name(self) -> &'static str {
        match self {
            Self::PreKey => "pre_key",
            Self::PostKey => "post_key",
            Self::ProxySend => "proxy_send",
            Self::UserEventImmediate => "user_event_immediate",
            Self::UserEventEnqueued => "user_event_enqueued",
            Self::UserEventDispatch => "user_event_dispatch",
            Self::SetFocusBegin => "set_focus_begin",
            Self::SetFocusEnd => "set_focus_end",
            #[cfg(target_os = "macos")]
            Self::DirectSubmit => "direct_submit",
            #[cfg(target_os = "macos")]
            Self::DirectFocus => "direct_focus",
        }
    }
}

#[derive(Default)]
struct TraceState {
    sequence: u64,
    armed_ms: Option<u64>,
}

impl TraceState {
    fn next(&mut self, now_ms: u64, arm: bool) -> Option<u64> {
        if self.sequence >= LIMIT {
            return None;
        }
        if arm {
            self.armed_ms = Some(now_ms);
        }
        if now_ms.checked_sub(self.armed_ms?)? > WINDOW_MS {
            return None;
        }
        self.sequence += 1;
        Some(self.sequence)
    }
}

pub(crate) fn key_event(
    stage: Stage,
    key_down: bool,
    classification: KeyClass,
    browser_id: Option<i32>,
) {
    if key_down {
        emit(
            stage,
            browser_id,
            None,
            Some(classification.name()),
            matches!(classification, KeyClass::Launcher | KeyClass::SelectAll)
                && matches!(stage, Stage::PreKey),
        );
    }
}

pub(crate) fn record(stage: Stage, browser_id: Option<i32>, webview_id: Option<u32>) {
    emit(stage, browser_id, webview_id, None, false);
}

fn emit(
    stage: Stage,
    browser_id: Option<i32>,
    webview_id: Option<u32>,
    classification: Option<&'static str>,
    arm: bool,
) {
    if !enabled() {
        return;
    }
    static STATE: OnceLock<(Instant, Mutex<TraceState>)> = OnceLock::new();
    let (origin, state) = STATE.get_or_init(|| (Instant::now(), Mutex::new(TraceState::default())));
    let mut state = state.lock().unwrap_or_else(|error| error.into_inner());
    let monotonic_ms = origin.elapsed().as_millis() as u64;
    let Some(sequence) = state.next(monotonic_ms, arm) else {
        return;
    };
    let unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0;
    let browser_id = browser_id.map_or_else(|| "null".into(), |id| id.to_string());
    let webview_id = webview_id.map_or_else(|| "null".into(), |id| id.to_string());
    let classification =
        classification.map_or_else(|| "null".into(), |value| format!("\"{value}\""));
    // Ignore output failures: a diagnostic must not change browser behavior.
    let _ = writeln!(
        std::io::stdout().lock(),
        "DIVE_UI_INPUT_NATIVE: {{\"sequence\":{sequence},\"unix_ms\":{unix_ms:.3},\"monotonic_ms\":{monotonic_ms},\"stage\":\"{}\",\"browser_id\":{browser_id},\"webview_id\":{webview_id},\"classification\":{classification}}}",
        stage.name(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_requires_every_explicit_flag_and_disposable_profile() {
        assert!(gate("1", "1", "1", true, false));
        for invalid in ["", "0", "true", " 1", "2"] {
            assert!(!gate(invalid, "1", "1", true, false));
            assert!(!gate("1", invalid, "1", true, false));
            assert!(!gate("1", "1", invalid, true, false));
        }
        assert!(!gate("1", "1", "1", false, false));
        assert!(!gate("1", "1", "1", true, true));
    }

    #[test]
    fn reserved_classification_requires_exact_macos_raw_command_without_extra_modifiers() {
        for (code, expected) in [(84, KeyClass::Launcher), (65, KeyClass::SelectAll)] {
            assert_eq!(
                classify_key(true, true, code, true, false, false, false),
                expected
            );
            for actual in [
                classify_key(false, true, code, true, false, false, false),
                classify_key(true, false, code, true, false, false, false),
                classify_key(true, true, code, false, false, false, false),
                classify_key(true, true, code, true, true, false, false),
                classify_key(true, true, code, true, false, true, false),
                classify_key(true, true, code, true, false, false, true),
            ] {
                assert_eq!(actual, KeyClass::Other);
            }
        }
        assert_eq!(
            classify_key(true, true, 85, true, false, false, false),
            KeyClass::Other
        );
    }

    #[test]
    fn armed_window_is_non_sliding_and_rearms_after_expiry() {
        let mut state = TraceState::default();
        assert_eq!(state.next(0, false), None);
        assert_eq!(state.next(10, true), Some(1));
        assert_eq!(state.next(509, false), Some(2));
        assert_eq!(state.next(510, false), Some(3));
        assert_eq!(state.next(511, false), None);
        assert_eq!(state.next(600, true), Some(4));
        assert_eq!(state.next(1101, false), None);
    }

    #[test]
    fn process_limit_does_not_reset_for_new_launchers() {
        let mut state = TraceState::default();
        for sequence in 1..=256 {
            assert_eq!(state.next(sequence * 1000, true), Some(sequence));
        }
        assert_eq!(state.next(257_000, true), None);
        assert_eq!(state.next(257_001, false), None);
    }

    #[test]
    fn isolated_receipt_child() {
        if std::env::var_os("DIVE_TRACE_TEST_CHILD").is_none() {
            return;
        }
        let select_all = std::env::var_os("DIVE_TRACE_TEST_SELECT_ALL").is_some();
        let chord = if select_all {
            KeyClass::SelectAll
        } else {
            KeyClass::Launcher
        };
        // Neither post-key, a non-keydown chord, nor unrelated activity arms it.
        key_event(Stage::PostKey, true, chord, Some(11));
        key_event(Stage::PreKey, false, chord, Some(11));
        record(Stage::ProxySend, None, None);
        key_event(Stage::PreKey, true, chord, Some(11));
        key_event(Stage::PreKey, true, KeyClass::Other, Some(11));
        if select_all {
            key_event(Stage::PostKey, true, chord, Some(11));
        }
        for stage in [
            Stage::PostKey,
            Stage::ProxySend,
            Stage::UserEventImmediate,
            Stage::UserEventEnqueued,
            Stage::UserEventDispatch,
            Stage::SetFocusBegin,
            Stage::SetFocusEnd,
            #[cfg(target_os = "macos")]
            Stage::DirectSubmit,
            #[cfg(target_os = "macos")]
            Stage::DirectFocus,
        ] {
            record(stage, Some(22), Some(33));
        }
        for _ in 0..300 {
            key_event(Stage::PreKey, true, chord, Some(11));
        }
    }

    fn child_receipts(trace: &str, competing: bool, select_all: bool) -> Vec<String> {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child
            // A suffix matches both standalone and library-qualified module paths.
            .args(["tests::isolated_receipt_child", "--nocapture"])
            .env("DIVE_TRACE_TEST_CHILD", "1")
            .env("DIVE_UI_INPUT_NATIVE_TRACE", trace)
            .env("DIVE_UI_PROBE", "1")
            .env("DIVE_USE_MOCK_KEYCHAIN", "1")
            .env("DIVE_DATA_DIR", "/unused-disposable-test-profile");
        child.env_remove("DIVE_TRACE_TEST_SELECT_ALL");
        if select_all {
            child.env("DIVE_TRACE_TEST_SELECT_ALL", "1");
        }
        for key in [
            "DIVE_NATIVE_LIFECYCLE_PROBE",
            "DIVE_STRESS_TABS",
            "DIVE_SMOKE",
            "DIVE_CDP_BENCH",
        ] {
            child.env_remove(key);
        }
        if competing {
            child.env("DIVE_SMOKE", "");
        }
        let result = child.output().unwrap();
        assert!(result.status.success());
        let stdout = String::from_utf8(result.stdout).unwrap();
        assert!(stdout.contains("1 passed; 0 failed"), "{stdout}");
        stdout
            .lines()
            .filter(|line| line.starts_with("DIVE_UI_INPUT_NATIVE: "))
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn actual_output_is_gated_armed_by_pre_key_only_and_process_bounded() {
        assert!(child_receipts("", false, false).is_empty());
        assert!(child_receipts("1", true, false).is_empty());
        let lines = child_receipts("1", false, false);
        assert_eq!(lines.len(), 256);
        assert!(lines[0].contains("\"sequence\":1,"));
        assert!(lines[0].contains("\"stage\":\"pre_key\""));
        assert!(lines[0].contains("\"browser_id\":11,\"webview_id\":null"));
        assert!(lines[0].contains("\"classification\":\"launcher\""));
        assert!(lines[1].contains("\"classification\":\"other\""));
        assert!(lines[2].contains("\"browser_id\":22,\"webview_id\":33"));
        assert!(lines[2].contains("\"classification\":null"));
        assert!(lines[255].contains("\"sequence\":256,"));
        for line in lines {
            for forbidden in ["key_code", "characters", "url", "value", "event_debug"] {
                assert!(!line.contains(forbidden));
            }
        }
    }

    #[test]
    fn select_all_receipts_preserve_pre_other_post_order_and_share_gate_and_cap() {
        assert!(child_receipts("", false, true).is_empty());
        assert!(child_receipts("1", true, true).is_empty());
        let lines = child_receipts("1", false, true);
        assert_eq!(lines.len(), 256);
        for (line, (stage, class)) in lines.iter().zip([
            ("pre_key", "select_all"),
            ("pre_key", "other"),
            ("post_key", "select_all"),
        ]) {
            assert!(line.contains(&format!("\"stage\":\"{stage}\"")), "{line}");
            assert!(
                line.contains(&format!("\"classification\":\"{class}\"")),
                "{line}"
            );
        }
        assert!(lines[0].contains("\"sequence\":1,"));
        assert!(lines[255].contains("\"sequence\":256,"));
    }
}
