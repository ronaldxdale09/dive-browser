//! Local, bounded UI responsiveness diagnostics. No page or browsing data.
//!
//! One observer thread owns the detector and all disk I/O. The UI publishes an
//! awake-clock timestamp through one atomic; it never waits for the observer.
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    fs::{File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

const SECOND: u64 = 1_000_000_000;
const FILE_LIMIT: u64 = 256 * 1024;
const LINE_LIMIT: usize = 256;
const SAMPLE_LIMIT: usize = 256;
// The two OS clocks are read back-to-back. Ignore sub-millisecond skew when
// comparing their deltas, rather than interpreting scheduling jitter as sleep.
const CLOCK_SKEW: u64 = 1_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    MonitorStarted,
    Heartbeat,
    HangStarted,
    HangRecovered,
    SuspendGap,
    ClockDiscontinuity,
    ClockUnavailable,
    DispatchFailed,
    MonitorStopped,
    FaultInjected,
    FaultAcknowledged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    timestamp: u64,
    duration_ms: Option<u64>,
    kind: Kind,
    app_version: String,
}

impl Record {
    fn new(now: Sample, kind: Kind, duration: Option<u64>) -> Self {
        Self {
            timestamp: now.wall,
            // Round up, so a sub-ms remainder never understates the p95 budget.
            duration_ms: duration.map(|ns| ns.div_ceil(1_000_000)),
            kind,
            app_version: env!("CARGO_PKG_VERSION").into(),
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Sample {
    awake: u64,
    continuous: u64,
    wall: u64,
    skew: u64,
}

#[derive(Default)]
pub(crate) struct Acknowledgement(AtomicU64);
impl Acknowledgement {
    fn publish(&self, awake: Option<u64>) {
        // Zero is pending; MAX means an unavailable/overflowed OS clock.
        self.0.store(
            awake.and_then(|n| n.checked_add(1)).unwrap_or(u64::MAX),
            Ordering::Release,
        );
    }

    pub(crate) fn acknowledge(&self) {
        self.publish(platform::awake());
    }
}

struct Pending {
    sent: u64,
    ack: Arc<Acknowledgement>,
    reported: bool,
    fault: bool,
}

#[derive(Default)]
struct Detector {
    pending: Option<Pending>,
    previous: Option<Sample>,
    last_send: Option<u64>,
    failed: bool,
}

impl Detector {
    fn tick(
        &mut self,
        now: Sample,
        sink: &mut impl FnMut(Record),
        dispatch: &mut impl FnMut(Arc<Acknowledgement>, bool) -> bool,
        fault: bool,
    ) -> bool {
        if self.failed || !self.validate_clock(now, sink) {
            return false;
        }
        if !self.observe_pending(now, sink, false) {
            return false;
        }
        if self.pending.is_none()
            && self
                .last_send
                .is_none_or(|sent| now.awake.saturating_sub(sent) >= SECOND)
        {
            let ack = Arc::new(Acknowledgement::default());
            self.pending = Some(Pending {
                sent: now.awake,
                ack: ack.clone(),
                reported: false,
                fault,
            });
            self.last_send = Some(now.awake);
            if fault {
                sink(Record::new(now, Kind::FaultInjected, Some(4 * SECOND)));
            }
            if !dispatch(ack, fault) {
                return self.fail(now, Kind::DispatchFailed, sink);
            }
        }
        true
    }

    // A terminal failure invalidates the pending measurement permanently. A
    // later readable clock or published ack must not revive the rejected epoch.
    fn fail(&mut self, now: Sample, kind: Kind, sink: &mut impl FnMut(Record)) -> bool {
        if !self.failed {
            self.failed = true;
            self.pending = None;
            sink(Record::new(now, kind, None));
        }
        false
    }

    fn validate_clock(&mut self, now: Sample, sink: &mut impl FnMut(Record)) -> bool {
        if let Some(previous) = self.previous {
            let Some(awake) = now.awake.checked_sub(previous.awake) else {
                return self.fail(now, Kind::ClockDiscontinuity, sink);
            };
            let Some(continuous) = now.continuous.checked_sub(previous.continuous) else {
                return self.fail(now, Kind::ClockDiscontinuity, sink);
            };
            let skew = CLOCK_SKEW
                .saturating_add(now.skew)
                .saturating_add(previous.skew);
            if awake > continuous.saturating_add(skew) {
                return self.fail(now, Kind::ClockDiscontinuity, sink);
            }
            if continuous > awake.saturating_add(skew) {
                sink(Record::new(now, Kind::SuspendGap, Some(continuous - awake)));
            }
        }
        self.previous = Some(now);
        true
    }

    // Shutdown takes one atomic snapshot and finalizes only a published ack;
    // it neither waits for UI progress nor classifies a new pending interval.
    fn observe_pending(
        &mut self,
        now: Sample,
        sink: &mut impl FnMut(Record),
        acknowledged_only: bool,
    ) -> bool {
        if let Some(pending) = self.pending.as_mut() {
            let published = pending.ack.0.load(Ordering::Acquire);
            if acknowledged_only && published == 0 {
                return true;
            }
            if published == u64::MAX {
                return self.fail(now, Kind::ClockUnavailable, sink);
            }
            let acknowledged = published.checked_sub(1);
            let Some(age) = acknowledged.unwrap_or(now.awake).checked_sub(pending.sent) else {
                return self.fail(now, Kind::ClockDiscontinuity, sink);
            };
            // The callback can execute just after the observer's clock sample.
            // Future acknowledgement times are valid; their own clock is precise.
            if age >= 2 * SECOND && !pending.reported {
                sink(Record::new(now, Kind::HangStarted, Some(age)));
                pending.reported = true;
            }
            if acknowledged.is_some() {
                let kind = if pending.reported {
                    Kind::HangRecovered
                } else if pending.fault {
                    Kind::FaultAcknowledged
                } else {
                    Kind::Heartbeat
                };
                sink(Record::new(now, kind, Some(age)));
                if pending.fault && pending.reported {
                    sink(Record::new(now, Kind::FaultAcknowledged, Some(age)));
                }
                self.pending = None;
            }
        }
        true
    }

    fn stop(&mut self, now: Sample, sink: &mut impl FnMut(Record)) {
        if !self.failed && self.validate_clock(now, sink) {
            self.observe_pending(now, sink, true);
        }
        let duration = self
            .pending
            .take()
            .and_then(|p| now.awake.checked_sub(p.sent));
        sink(Record::new(now, Kind::MonitorStopped, duration));
    }
}

struct Store {
    directory: PathBuf,
    current: File,
    size: u64,
}
impl Store {
    fn open(directory: &Path) -> io::Result<Self> {
        std::fs::create_dir_all(directory)?;
        if std::fs::symlink_metadata(directory)?
            .file_type()
            .is_symlink()
        {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        for name in ["current.jsonl", "previous.jsonl"] {
            let path = directory.join(name);
            if let Ok(metadata) = std::fs::symlink_metadata(&path) {
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err(io::ErrorKind::InvalidInput.into());
                }
                if metadata.len() > FILE_LIMIT {
                    File::create(path)?;
                }
            }
        }
        // Append-only Windows handles cannot set_len. This observer exclusively
        // owns the writer, so use read/write access and position writes explicitly.
        let mut current = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(directory.join("current.jsonl"))?;
        // Discard a partial trailing record left by process termination. Reading
        // is bounded above; a later append cannot combine it with a valid line.
        let mut bytes = Vec::new();
        (&mut current).take(FILE_LIMIT).read_to_end(&mut bytes)?;
        let size = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1) as u64;
        current.set_len(size)?;
        Ok(Self {
            directory: directory.to_owned(),
            current,
            size,
        })
    }

    fn write(&mut self, record: &Record) -> io::Result<()> {
        let mut line = serde_json::to_vec(record)?;
        line.push(b'\n');
        if line.len() > LINE_LIMIT {
            return Err(io::ErrorKind::InvalidData.into());
        }
        if self.size + line.len() as u64 > FILE_LIMIT {
            // Copy into the second fixed file instead of platform-dependent
            // rename-over-open semantics. At every point both files stay capped.
            self.current.seek(SeekFrom::Start(0))?;
            let mut previous = File::create(self.directory.join("previous.jsonl"))?;
            io::copy(&mut (&mut self.current).take(FILE_LIMIT), &mut previous)?;
            self.current.set_len(0)?;
            self.size = 0;
        }
        // Trimming a partial tail or rotating does not reset the file cursor.
        self.current.seek(SeekFrom::Start(self.size))?;
        self.current.write_all(&line)?;
        self.size += line.len() as u64;
        Ok(())
    }
}

// A bounded local reader for test/soak tools; intentionally no Tauri command or
// automatic export. Its lazy root argument makes the private no-read rule clear.
#[allow(dead_code)]
fn read_records(private: bool, root: impl FnOnce() -> PathBuf) -> Vec<Record> {
    let Some(root) = persistence_root(private, root) else {
        return vec![];
    };
    let mut records = Vec::new();
    for name in ["previous.jsonl", "current.jsonl"] {
        let path = root.join(name);
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > FILE_LIMIT {
            continue;
        }
        let Ok(file) = File::open(path) else {
            continue;
        };
        let mut bytes = Vec::new();
        if file.take(FILE_LIMIT).read_to_end(&mut bytes).is_err() {
            continue;
        }
        for line in bytes.split_inclusive(|b| *b == b'\n') {
            if line.last() != Some(&b'\n') || line.len() > LINE_LIMIT {
                continue;
            }
            if let Ok(record) = serde_json::from_slice::<Record>(line)
                && record.app_version == env!("CARGO_PKG_VERSION")
            {
                records.push(record);
            }
        }
    }
    records
}

fn persistence_root(private: bool, root: impl FnOnce() -> PathBuf) -> Option<PathBuf> {
    if private { None } else { Some(root()) }
}

fn diagnostic_profile(
    private: bool,
    diagnostic: &str,
    disposable: &str,
    mock: &str,
    profile: Option<&Path>,
    temp: &Path,
) -> Option<PathBuf> {
    if private || diagnostic != "1" || disposable != "1" || mock != "1" {
        return None;
    }
    let profile = profile?.canonicalize().ok()?;
    let temp = temp.canonicalize().ok()?;
    (profile != temp && profile.starts_with(temp)).then_some(profile)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn sample(ms: u64) -> Sample {
        Sample {
            awake: ms * 1_000_000,
            continuous: ms * 1_000_000,
            wall: ms,
            skew: 0,
        }
    }
    struct Rig {
        detector: Detector,
        events: Vec<Record>,
        pending: Vec<Arc<Acknowledgement>>,
    }
    impl Rig {
        fn new() -> Self {
            Self {
                detector: Detector::default(),
                events: vec![],
                pending: vec![],
            }
        }
        fn tick(&mut self, s: Sample) -> bool {
            self.detector.tick(
                s,
                &mut |r| self.events.push(r),
                &mut |a, _| {
                    self.pending.push(a);
                    true
                },
                false,
            )
        }
        fn ack(&self, ms: u64) {
            self.pending.last().unwrap().publish(Some(ms * 1_000_000));
        }
        fn kinds(&self) -> Vec<Kind> {
            self.events.iter().map(|r| r.kind).collect()
        }
    }
    #[test]
    fn healthy_ack_uses_ui_timestamp_not_observer_time() {
        let mut r = Rig::new();
        r.tick(sample(0));
        assert_eq!(r.pending.len(), 1);
        r.ack(7);
        r.tick(sample(1000));
        assert_eq!(r.kinds(), [Kind::Heartbeat]);
        assert_eq!(r.events[0].duration_ms, Some(7));
    }
    #[test]
    fn threshold_and_ack_between_ticks() {
        for (ack, kinds) in [
            (1999, vec![Kind::Heartbeat]),
            (2000, vec![Kind::HangStarted, Kind::HangRecovered]),
            (2400, vec![Kind::HangStarted, Kind::HangRecovered]),
        ] {
            let mut r = Rig::new();
            r.tick(sample(0));
            r.ack(ack);
            r.tick(sample(3000));
            assert_eq!(r.kinds(), kinds);
            assert_eq!(r.events.last().unwrap().duration_ms, Some(ack));
        }
    }
    #[test]
    fn sustained_stall_reports_once_and_queues_once() {
        let mut r = Rig::new();
        for ms in (0..=60_000).step_by(1000) {
            r.tick(sample(ms));
        }
        assert_eq!(r.pending.len(), 1);
        assert_eq!(r.kinds(), [Kind::HangStarted]);
        r.ack(60_123);
        r.tick(sample(61_000));
        assert_eq!(r.kinds(), [Kind::HangStarted, Kind::HangRecovered]);
        assert_eq!(r.events[1].duration_ms, Some(60_123));
        assert_eq!(r.pending.len(), 2);
    }
    #[test]
    fn no_catch_up_burst_after_observer_delay() {
        let mut r = Rig::new();
        r.tick(sample(0));
        r.ack(5);
        r.tick(sample(60_000));
        r.tick(sample(60_000));
        assert_eq!(r.pending.len(), 2);
        assert_eq!(r.kinds(), [Kind::Heartbeat]);
    }
    #[test]
    fn actual_sleep_retains_token_and_excludes_sleep() {
        let mut r = Rig::new();
        r.tick(sample(0));
        r.tick(Sample {
            awake: SECOND / 2,
            continuous: 3600 * SECOND,
            wall: 0,
            skew: 0,
        });
        assert_eq!(r.pending.len(), 1);
        assert_eq!(r.kinds(), [Kind::SuspendGap]);
        r.ack(510);
        r.tick(Sample {
            awake: SECOND,
            continuous: 3600 * SECOND + SECOND / 2,
            wall: 1,
            skew: 0,
        });
        assert_eq!(r.kinds(), [Kind::SuspendGap, Kind::Heartbeat]);
        assert_eq!(r.events[1].duration_ms, Some(510));
    }
    #[test]
    fn awake_observer_delay_is_a_hang_and_wall_jumps_do_not_change_it() {
        let mut r = Rig::new();
        r.tick(Sample {
            wall: u64::MAX,
            ..sample(0)
        });
        r.tick(Sample {
            wall: 0,
            ..sample(5000)
        });
        assert_eq!(r.kinds(), [Kind::HangStarted]);
        assert_eq!(r.events[0].duration_ms, Some(5000));
    }
    #[test]
    fn sleep_during_hang_and_repeated_resume_still_reports_recovery() {
        let mut r = Rig::new();
        r.tick(sample(0));
        r.tick(sample(2000));
        r.tick(Sample {
            continuous: 100 * SECOND,
            ..sample(2100)
        });
        r.tick(Sample {
            continuous: 200 * SECOND,
            ..sample(2200)
        });
        r.ack(2500);
        r.tick(Sample {
            continuous: 201 * SECOND,
            ..sample(3200)
        });
        assert_eq!(
            r.kinds(),
            [
                Kind::HangStarted,
                Kind::SuspendGap,
                Kind::SuspendGap,
                Kind::HangRecovered
            ]
        );
        assert_eq!(r.events.last().unwrap().duration_ms, Some(2500));
    }
    #[test]
    fn post_resume_stuck_ui_is_not_indefinitely_exempt() {
        let mut r = Rig::new();
        r.tick(sample(0));
        r.tick(Sample {
            continuous: 100 * SECOND,
            ..sample(100)
        });
        r.tick(Sample {
            continuous: 102 * SECOND,
            ..sample(2100)
        });
        assert_eq!(r.kinds(), [Kind::SuspendGap, Kind::HangStarted]);
        assert_eq!(r.pending.len(), 1);
    }
    #[test]
    fn clock_regression_and_invalid_ack_stop_without_false_recovery() {
        let mut r = Rig::new();
        r.tick(sample(10));
        assert!(!r.tick(sample(9)));
        assert_eq!(r.kinds(), [Kind::ClockDiscontinuity]);
        let mut r = Rig::new();
        r.tick(sample(10));
        r.ack(9);
        assert!(!r.tick(sample(1000)));
        assert_eq!(r.kinds(), [Kind::ClockDiscontinuity]);
    }
    #[test]
    fn failed_dispatch_stops_without_recovery() {
        let mut d = Detector::default();
        let mut events = vec![];
        assert!(!d.tick(sample(0), &mut |r| events.push(r), &mut |_, _| false, false));
        assert_eq!(events[0].kind, Kind::DispatchFailed);
    }
    #[test]
    fn rejected_clock_epoch_is_never_finalized_as_recovery() {
        let mut r = Rig::new();
        r.tick(sample(0));
        r.tick(sample(1000));
        r.ack(10010);
        let invalid = Sample {
            continuous: 1_520_000_000,
            ..sample(10020)
        };
        assert!(!r.tick(invalid));
        r.detector.stop(invalid, &mut |event| r.events.push(event));
        assert_eq!(r.kinds(), [Kind::ClockDiscontinuity, Kind::MonitorStopped]);
        assert_eq!(r.events.last().unwrap().duration_ms, None);
        assert_eq!(r.pending.len(), 1);
    }

    #[test]
    fn final_clock_sample_must_be_valid_before_ack_is_drained() {
        let mut r = Rig::new();
        r.tick(sample(0));
        r.tick(sample(1000));
        r.ack(10010);
        let invalid = Sample {
            continuous: 1_520_000_000,
            ..sample(10020)
        };
        r.detector.stop(invalid, &mut |event| r.events.push(event));
        assert_eq!(r.kinds(), [Kind::ClockDiscontinuity, Kind::MonitorStopped]);
        assert_eq!(r.events.last().unwrap().duration_ms, None);
        assert_eq!(r.pending.len(), 1);
    }

    #[test]
    fn stop_records_threshold_crossing_ack_before_observer_tick() {
        let mut r = Rig::new();
        r.tick(sample(0));
        r.tick(sample(1000));
        r.ack(2400);
        r.detector
            .stop(sample(2500), &mut |event| r.events.push(event));
        assert_eq!(
            r.kinds(),
            [Kind::HangStarted, Kind::HangRecovered, Kind::MonitorStopped]
        );
        assert_eq!(r.events[0].duration_ms, Some(2400));
        assert_eq!(r.events[1].duration_ms, Some(2400));
        assert_eq!(r.pending.len(), 1, "shutdown must not dispatch");
    }

    #[test]
    fn stop_records_recovery_of_already_reported_hang() {
        let mut r = Rig::new();
        r.tick(sample(0));
        r.tick(sample(2000));
        r.ack(2400);
        r.detector
            .stop(sample(2500), &mut |event| r.events.push(event));
        assert_eq!(
            r.kinds(),
            [Kind::HangStarted, Kind::HangRecovered, Kind::MonitorStopped]
        );
        assert_eq!(r.events[0].duration_ms, Some(2000));
        assert_eq!(r.events[1].duration_ms, Some(2400));
        assert_eq!(r.pending.len(), 1, "shutdown must not dispatch");
    }

    #[test]
    fn stop_does_not_require_pending_ack_and_late_ack_is_inert() {
        let mut r = Rig::new();
        r.tick(sample(0));
        r.detector.stop(sample(500), &mut |e| r.events.push(e));
        r.ack(700);
        assert_eq!(r.kinds(), [Kind::MonitorStopped]);
        assert_eq!(r.events[0].duration_ms, Some(500));
    }
    fn record() -> Record {
        Record {
            timestamp: 1,
            duration_ms: Some(7),
            kind: Kind::Heartbeat,
            app_version: env!("CARGO_PKG_VERSION").into(),
        }
    }
    #[test]
    fn reopened_partial_tail_is_trimmed_before_the_next_record() {
        let dir = tempfile::tempdir().unwrap();
        let first = record();
        let second = Record {
            timestamp: 2,
            ..record()
        };
        let first_line = format!("{}\n", serde_json::to_string(&first).unwrap());
        let second_line = format!("{}\n", serde_json::to_string(&second).unwrap());
        std::fs::write(
            dir.path().join("current.jsonl"),
            format!("{first_line}{{partial"),
        )
        .unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        store.write(&second).unwrap();
        assert_eq!(
            std::fs::read(dir.path().join("current.jsonl")).unwrap(),
            format!("{first_line}{second_line}").as_bytes()
        );
        assert_eq!(
            read_records(false, || dir.path().to_owned()),
            [first, second]
        );
    }

    #[test]
    fn rotation_writes_the_next_record_at_zero_without_padding() {
        let dir = tempfile::tempdir().unwrap();
        let line = format!("{}\n", serde_json::to_string(&record()).unwrap());
        let retained = line.repeat(262_144 / line.len());
        std::fs::write(dir.path().join("current.jsonl"), &retained).unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        store.write(&record()).unwrap();
        assert_eq!(
            std::fs::read(dir.path().join("previous.jsonl")).unwrap(),
            retained.as_bytes()
        );
        assert_eq!(
            std::fs::read(dir.path().join("current.jsonl")).unwrap(),
            line.as_bytes()
        );
    }

    #[test]
    fn rotation_and_reader_remain_bounded_and_allowlisted() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        for _ in 0..10_000 {
            store.write(&record()).unwrap();
        }
        let mut total = 0;
        for name in ["current.jsonl", "previous.jsonl"] {
            let size = std::fs::metadata(dir.path().join(name)).unwrap().len();
            assert!(size <= 262_144);
            total += size;
        }
        assert!(total <= 524_288);
        let records = read_records(false, || dir.path().to_owned());
        assert!(!records.is_empty());
        assert!(records.len() < 10_000);
        let json = serde_json::to_value(&records[0]).unwrap();
        assert_eq!(json.as_object().unwrap().len(), 4);
        assert!(
            serde_json::from_str::<Record>(
                r#"{"timestamp":1,"duration_ms":1,"kind":"url","app_version":"x"}"#
            )
            .is_err()
        );
    }
    #[test]
    fn reader_rejects_corrupt_oversized_and_extra_fields() {
        let dir = tempfile::tempdir().unwrap();
        let valid = serde_json::to_string(&record()).unwrap();
        std::fs::write(
            dir.path().join("current.jsonl"),
            format!(
                "{}\n{{bad\n{}\n{{\"url\":\"secret\"}}\n{}",
                valid,
                "x".repeat(512),
                valid
            ),
        )
        .unwrap();
        assert_eq!(
            read_records(false, || dir.path().to_owned()),
            vec![record()]
        );
    }
    #[test]
    fn startup_truncates_owned_oversized_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("previous.jsonl"), vec![0; 300_000]).unwrap();
        let _s = Store::open(dir.path()).unwrap();
        assert!(
            std::fs::metadata(dir.path().join("previous.jsonl"))
                .unwrap()
                .len()
                <= 262_144
        );
    }
    #[test]
    fn private_never_even_derives_a_diagnostic_path() {
        assert!(persistence_root(true, || panic!("private path derived")).is_none());
        assert!(read_records(true, || panic!("private path read")).is_empty());
    }
    #[test]
    fn fault_gate_rejects_normal_private_missing_flags_and_outside_temp() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            diagnostic_profile(
                false,
                "1",
                "1",
                "1",
                Some(dir.path()),
                &std::env::temp_dir()
            )
            .is_some()
        );
        for (private, diagnostic, disposable, mock) in [
            (true, "1", "1", "1"),
            (false, "0", "1", "1"),
            (false, "1", "0", "1"),
            (false, "1", "1", "0"),
        ] {
            assert!(
                diagnostic_profile(
                    private,
                    diagnostic,
                    disposable,
                    mock,
                    Some(dir.path()),
                    &std::env::temp_dir()
                )
                .is_none()
            );
        }
        assert!(
            diagnostic_profile(
                false,
                "1",
                "1",
                "1",
                Some(Path::new("/")),
                &std::env::temp_dir()
            )
            .is_none()
        );
        assert!(diagnostic_profile(false, "1", "1", "1", None, &std::env::temp_dir()).is_none());
    }
}

mod platform {
    use super::Sample;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[cfg(target_os = "macos")]
    #[allow(unsafe_code)] // Read-only OS clocks; no pointers escape the timebase call.
    mod native {
        use std::sync::OnceLock;
        #[repr(C)]
        struct Timebase {
            numer: u32,
            denom: u32,
        }
        unsafe extern "C" {
            fn mach_absolute_time() -> u64;
            fn mach_continuous_time() -> u64;
            fn mach_timebase_info(info: *mut Timebase) -> i32;
        }
        static TIMEBASE: OnceLock<Option<(u32, u32)>> = OnceLock::new();
        fn convert(ticks: u64) -> Option<u64> {
            let (numer, denom) = TIMEBASE.get().copied().flatten()?;
            super::convert(ticks, numer, denom)
        }
        pub(super) fn init() {
            TIMEBASE.get_or_init(|| {
                let mut info = Timebase { numer: 0, denom: 0 };
                // SAFETY: valid, exclusive pointer to the documented C structure.
                (unsafe { mach_timebase_info(&raw mut info) } == 0 && info.denom != 0)
                    .then_some((info.numer, info.denom))
            });
        }
        pub(super) fn awake() -> Option<u64> {
            // SAFETY: thread-safe, argument-free OS clock read.
            convert(unsafe { mach_absolute_time() })
        }
        pub(super) fn continuous() -> Option<u64> {
            // SAFETY: thread-safe, argument-free OS clock read.
            convert(unsafe { mach_continuous_time() })
        }
    }
    #[cfg(target_os = "windows")]
    #[allow(unsafe_code)] // The bindings own the valid output pointers.
    mod native {
        use windows::Win32::System::WindowsProgramming::{
            QueryInterruptTimePrecise, QueryUnbiasedInterruptTimePrecise,
        };
        pub(super) fn init() {}
        pub(super) fn awake() -> Option<u64> {
            // SAFETY: thread-safe OS clock; supported since Windows 10.
            super::convert(unsafe { QueryUnbiasedInterruptTimePrecise() }, 100, 1)
        }
        pub(super) fn continuous() -> Option<u64> {
            // SAFETY: thread-safe OS clock; supported since Windows 10.
            super::convert(unsafe { QueryInterruptTimePrecise() }, 100, 1)
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    mod native {
        pub(super) fn init() {}
        pub(super) fn awake() -> Option<u64> {
            None
        }
        pub(super) fn continuous() -> Option<u64> {
            None
        }
    }
    pub(super) fn convert(ticks: u64, numerator: u32, denominator: u32) -> Option<u64> {
        u64::try_from(
            u128::from(ticks)
                .checked_mul(u128::from(numerator))?
                .checked_div(u128::from(denominator))?,
        )
        .ok()
    }
    pub(super) fn awake() -> Option<u64> {
        native::awake()
    }
    pub(super) fn sample() -> Option<Sample> {
        native::init(); // Only observer initialization; the UI uses the cached timebase.
        let before = awake()?;
        let continuous = native::continuous()?;
        let awake = awake()?;
        Some(Sample {
            awake,
            continuous,
            skew: awake.checked_sub(before)?,
            wall: u64::try_from(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis(),
            )
            .ok()?,
        })
    }
}
#[cfg(all(test, any(target_os = "macos", target_os = "windows")))]
#[test]
fn platform_clocks_advance_and_atomic_callback_publishes() {
    let before = platform::sample().expect("OS clock available");
    let ack = Acknowledgement::default();
    ack.acknowledge();
    std::thread::sleep(Duration::from_millis(2));
    let after = platform::sample().unwrap();
    assert!(after.awake > before.awake);
    assert!(after.continuous > before.continuous);
    let published = ack.0.load(Ordering::Acquire);
    assert!(published > before.awake && published <= after.awake + 1);
}

/// How often an ordinary heartbeat is written down.
const HEARTBEAT_EVERY_MS: u64 = 60_000;
/// A heartbeat this slow is written down whenever it happens: short of a
/// hang, but the kind of sluggishness worth a line.
const SLOW_HEARTBEAT_MS: u64 = 250;

struct Sink {
    store: Option<Store>,
    recent: VecDeque<Record>,
    disabled: bool,
    /// Wall time of the last heartbeat written to disk.
    heartbeat_written: Option<u64>,
}
impl Sink {
    fn new(path: &Path) -> Self {
        let store = Store::open(path).ok();
        Self {
            disabled: store.is_none(),
            store,
            recent: VecDeque::with_capacity(SAMPLE_LIMIT),
            heartbeat_written: None,
        }
    }
    /// Whether `record` goes to disk. Every probe is kept in memory, but a
    /// healthy heartbeat is one line a minute, not one a second: the disk
    /// was written every second for the life of the app to say nothing had
    /// happened. Hangs, recoveries and everything else are always written.
    fn persists(&mut self, record: &Record) -> bool {
        if record.kind != Kind::Heartbeat
            || record.duration_ms.is_some_and(|ms| ms >= SLOW_HEARTBEAT_MS)
        {
            return true;
        }
        let due = self.heartbeat_written.is_none_or(|last| {
            // A clock set back counts as due, or nothing would be written
            // until it caught up again.
            record.timestamp < last || record.timestamp - last >= HEARTBEAT_EVERY_MS
        });
        if due {
            self.heartbeat_written = Some(record.timestamp);
        }
        due
    }
    fn emit(&mut self, record: Record) {
        let persists = self.persists(&record);
        if persists
            && self
                .store
                .as_mut()
                .is_some_and(|store| store.write(&record).is_err())
        {
            // A failed disk is not retried every second and never blocks UI work.
            self.store = None;
            self.disabled = true;
        }
        if self.recent.len() == SAMPLE_LIMIT {
            self.recent.pop_front();
        }
        self.recent.push_back(record);
    }
}
pub(crate) struct MonitorGuard {
    stop: mpsc::SyncSender<()>,
    worker: Option<JoinHandle<()>>,
}
impl MonitorGuard {
    pub(crate) fn request_stop(&self) {
        let _ = self.stop.try_send(());
    }
    pub(crate) fn join(&mut self) {
        self.request_stop();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Drop for MonitorGuard {
    fn drop(&mut self) {
        self.join();
    }
}
fn spawn_observer(
    mut clock: impl FnMut() -> Option<Sample> + Send + 'static,
    mut sink: impl FnMut(Record) + Send + 'static,
    mut dispatch: impl FnMut(Arc<Acknowledgement>, bool) -> bool + Send + 'static,
    mut fault_requested: impl FnMut() -> bool + Send + 'static,
) -> io::Result<MonitorGuard> {
    let (stop, stopped) = mpsc::sync_channel(1);
    let worker = thread::Builder::new()
        .name("dive-responsiveness".into())
        .spawn(move || {
            let mut detector = Detector::default();
            let mut last = Sample::default();
            let mut started = false;
            loop {
                if !matches!(stopped.try_recv(), Err(mpsc::TryRecvError::Empty)) {
                    break;
                }
                // Fault file checks and startup disk work precede the send timestamp.
                // An old pending token is never replaced, even across machine sleep.
                let Some(now) = clock() else {
                    detector.fail(last, Kind::ClockUnavailable, &mut sink);
                    break;
                };
                if !started {
                    sink(Record::new(now, Kind::MonitorStarted, None));
                    started = true;
                    // Initialization may involve disk work: sample again before send.
                    continue;
                }
                let can_admit = detector
                    .pending
                    .as_ref()
                    .is_none_or(|pending| pending.ack.0.load(Ordering::Acquire) != 0)
                    && detector
                        .last_send
                        .is_none_or(|sent| now.awake.saturating_sub(sent) >= SECOND);
                let fault = can_admit && fault_requested();
                // The request check may touch storage, so timestamp immediately
                // before dispatch, after every possible filesystem operation.
                let Some(now) = clock() else {
                    detector.fail(now, Kind::ClockUnavailable, &mut sink);
                    break;
                };
                last = now;
                // A detector tick emits at most six fixed records. Defer disk I/O
                // until after dispatch, so disk latency cannot inflate UI latency.
                let mut events = Vec::with_capacity(6);
                let healthy =
                    detector.tick(now, &mut |record| events.push(record), &mut dispatch, fault);
                for event in events {
                    sink(event);
                }
                if !healthy {
                    break;
                }
                // No catch-up bursts, and shutdown wakes this wait immediately.
                if !matches!(
                    stopped.recv_timeout(Duration::from_secs(1)),
                    Err(mpsc::RecvTimeoutError::Timeout)
                ) {
                    break;
                }
            }
            let final_sample = clock().unwrap_or_else(|| {
                detector.fail(last, Kind::ClockUnavailable, &mut sink);
                last
            });
            detector.stop(final_sample, &mut sink);
        })?;
    Ok(MonitorGuard {
        stop,
        worker: Some(worker),
    })
}

fn consume_fault(directory: &Path) -> bool {
    let path = directory.join("stall.request");
    let Ok(metadata) = std::fs::symlink_metadata(&path) else {
        return false;
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != 0 {
        return false;
    }
    // An empty regular file is a single request, never a command or a queue.
    std::fs::remove_file(path).is_ok()
}

pub(crate) fn start(
    private: bool,
    root: impl FnOnce() -> PathBuf,
    dispatch: impl FnMut(Arc<Acknowledgement>, bool) -> bool + Send + 'static,
) -> Option<MonitorGuard> {
    // Disable the monitor entirely in private processes, before deriving any
    // normal profile path or touching a diagnostic file (including requests).
    let directory = persistence_root(private, root)?.join("responsiveness");
    let fault_directory = directory.clone();
    let mut sink = None;
    let mut fault_profile = None;
    let mut gate_checked = false;
    spawn_observer(
        platform::sample,
        move |record| {
            sink.get_or_insert_with(|| Sink::new(&directory))
                .emit(record);
        },
        dispatch,
        move || {
            // Executed only on the observer. Production sessions never inspect the
            // request path without all explicit disposable diagnostics flags.
            if !gate_checked {
                gate_checked = true;
                fault_profile = diagnostic_profile(
                    private,
                    &std::env::var("DIVE_RESPONSIVENESS_DIAGNOSTIC").unwrap_or_default(),
                    &std::env::var("DIVE_DISPOSABLE_PROFILE").unwrap_or_default(),
                    &std::env::var("DIVE_USE_MOCK_KEYCHAIN").unwrap_or_default(),
                    std::env::var_os("DIVE_DATA_DIR").as_deref().map(Path::new),
                    &std::env::temp_dir(),
                )
                .filter(|profile| {
                    fault_directory
                        .parent()
                        .and_then(|p| p.canonicalize().ok())
                        .as_ref()
                        == Some(profile)
                });
            }
            fault_profile
                .as_ref()
                .is_some_and(|profile| consume_fault(&profile.join("responsiveness")))
        },
    )
    .ok()
}

#[cfg(test)]
mod ownership_tests {
    use super::*;
    #[test]
    fn observer_drop_joins_with_unacknowledged_ui_callback() {
        let (sent, received) = mpsc::sync_channel(1);
        let (events_tx, events_rx) = mpsc::channel();
        let observer = spawn_observer(
            || Some(Sample::default()),
            move |e| {
                events_tx.send(e).unwrap();
            },
            move |ack, _| {
                sent.send(ack).unwrap();
                true
            },
            || false,
        )
        .unwrap();
        let ack = received
            .recv_timeout(Duration::from_secs(2))
            .expect("observer queues first UI heartbeat independently");
        let started = std::time::Instant::now();
        drop(observer);
        assert!(started.elapsed() < Duration::from_millis(500));
        ack.publish(Some(1));
        let events: Vec<_> = events_rx.try_iter().map(|e| e.kind).collect();
        assert_eq!(events, [Kind::MonitorStarted, Kind::MonitorStopped]);
        assert!(matches!(
            events_rx.try_recv(),
            Err(mpsc::TryRecvError::Disconnected)
        ));
    }
    #[test]
    fn unavailable_clock_after_ack_does_not_claim_recovery_at_stop() {
        let (tx, rx) = mpsc::channel();
        let mut reads = 0;
        let mut observer = spawn_observer(
            move || {
                reads += 1;
                if reads == 4 {
                    return None;
                }
                let time = if reads > 4 { 2_500_000_000 } else { 0 };
                Some(Sample {
                    awake: time,
                    continuous: time,
                    ..Sample::default()
                })
            },
            move |record| {
                tx.send(record).unwrap();
            },
            |ack, _| {
                ack.publish(Some(2_400_000_000));
                true
            },
            || false,
        )
        .unwrap();
        let mut kinds = Vec::new();
        loop {
            let record = rx.recv_timeout(Duration::from_secs(2)).unwrap();
            kinds.push(record.kind);
            if record.kind == Kind::MonitorStopped {
                break;
            }
        }
        observer.join();
        assert_eq!(
            kinds,
            [
                Kind::MonitorStarted,
                Kind::ClockUnavailable,
                Kind::MonitorStopped
            ]
        );
    }

    #[test]
    fn unavailable_clock_terminates_owned_observer() {
        let (tx, rx) = mpsc::channel();
        let mut observer = spawn_observer(
            || None,
            move |r| {
                tx.send(r).unwrap();
            },
            |_, _| panic!("no dispatch without clock"),
            || false,
        )
        .unwrap();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(2)).unwrap().kind,
            Kind::ClockUnavailable
        );
        observer.join();
        assert_eq!(
            rx.try_iter().map(|r| r.kind).collect::<Vec<_>>(),
            [Kind::MonitorStopped]
        );
    }
    #[test]
    fn failed_disk_disables_persistence_without_losing_bounded_recent_events() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("not-directory");
        std::fs::write(&path, b"occupied").unwrap();
        let mut sink = Sink::new(&path);
        for ms in 0..10_000 {
            sink.emit(Record::new(
                Sample {
                    wall: ms,
                    ..Sample::default()
                },
                Kind::Heartbeat,
                Some(1),
            ));
        }
        assert!(sink.disabled);
        assert!(sink.store.is_none());
        assert_eq!(sink.recent.len(), 256);
        assert_eq!(sink.recent.front().unwrap().timestamp, 9744);
    }
    #[test]
    fn healthy_heartbeats_reach_the_disk_once_a_minute_and_everything_else_always() {
        let dir = tempfile::tempdir().unwrap();
        let mut sink = Sink::new(dir.path());
        let at = |ms: u64, kind: Kind, duration: u64| Record {
            duration_ms: Some(duration),
            ..Record::new(
                Sample {
                    wall: ms,
                    ..Sample::default()
                },
                kind,
                None,
            )
        };
        for second in 0..=120 {
            sink.emit(at(second * 1000, Kind::Heartbeat, 3));
        }
        sink.emit(at(121_000, Kind::Heartbeat, SLOW_HEARTBEAT_MS));
        sink.emit(at(122_000, Kind::HangStarted, 2000));
        sink.emit(at(123_000, Kind::HangRecovered, 2500));
        // A clock set back does not silence the heartbeat until it catches up.
        sink.emit(at(1000, Kind::Heartbeat, 3));
        let written = std::fs::read_to_string(dir.path().join("current.jsonl")).unwrap();
        let kinds: Vec<(u64, Kind)> = written
            .lines()
            .map(|line| serde_json::from_str::<Record>(line).unwrap())
            .map(|record| (record.timestamp, record.kind))
            .collect();
        assert_eq!(
            kinds,
            [
                (0, Kind::Heartbeat),
                (60_000, Kind::Heartbeat),
                (120_000, Kind::Heartbeat),
                (121_000, Kind::Heartbeat),
                (122_000, Kind::HangStarted),
                (123_000, Kind::HangRecovered),
                (1000, Kind::Heartbeat),
            ]
        );
        assert_eq!(
            sink.recent.len(),
            125,
            "every probe is still kept in memory"
        );
    }
    #[test]
    fn one_empty_fault_request_is_consumed_and_nonempty_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stall.request");
        std::fs::write(&path, b"").unwrap();
        assert!(consume_fault(dir.path()));
        assert!(!path.exists());
        assert!(!consume_fault(dir.path()));
        std::fs::write(&path, b"arbitrary").unwrap();
        assert!(!consume_fault(dir.path()));
    }
    #[test]
    fn failed_append_is_disabled_and_never_retried() {
        let dir = tempfile::tempdir().unwrap();
        let mut sink = Sink::new(dir.path());
        let bad = Record {
            app_version: "x".repeat(300),
            timestamp: 0,
            duration_ms: None,
            kind: Kind::Heartbeat,
        };
        sink.emit(bad);
        assert!(sink.disabled);
        sink.emit(Record::new(Sample::default(), Kind::Heartbeat, None));
        assert_eq!(
            std::fs::metadata(dir.path().join("current.jsonl"))
                .unwrap()
                .len(),
            0
        );
    }
    #[test]
    fn timebase_overflow_and_zero_denominator_are_rejected() {
        assert_eq!(platform::convert(u64::MAX, 100, 1), None);
        assert_eq!(platform::convert(1, 1, 0), None);
        assert_eq!(platform::convert(125, 125, 3), Some(5208));
    }
}

#[cfg(test)]
mod admission_tests {
    use super::*;
    #[test]
    fn fault_request_survives_startup_and_is_admitted_after_healthy_ack() {
        let ticks = Arc::new(AtomicU64::new(0));
        let (tx, rx) = mpsc::channel();
        let mut calls = 0;
        let mut observer = spawn_observer(
            move || {
                let n = ticks.fetch_add(SECOND, Ordering::Relaxed);
                Some(Sample {
                    awake: n,
                    continuous: n,
                    ..Sample::default()
                })
            },
            |_| {},
            move |ack, fault| {
                ack.publish(Some(2 * SECOND));
                tx.send(fault).unwrap();
                true
            },
            move || {
                calls += 1;
                calls >= 2
            },
        )
        .unwrap();
        assert!(!rx.recv_timeout(Duration::from_secs(2)).unwrap());
        assert!(rx.recv_timeout(Duration::from_secs(2)).unwrap());
        observer.join();
    }
    #[test]
    fn private_start_never_derives_path_or_dispatches() {
        assert!(
            start(
                true,
                || panic!("private profile accessed"),
                |_, _| panic!("private callback dispatched")
            )
            .is_none()
        );
    }
    #[test]
    fn faulty_sample_is_explicitly_marked_and_not_a_healthy_heartbeat() {
        let mut d = Detector::default();
        let mut ack = None;
        let mut events = vec![];
        d.tick(
            Sample::default(),
            &mut |e| events.push(e),
            &mut |a, f| {
                assert!(f);
                ack = Some(a);
                true
            },
            true,
        );
        ack.unwrap().publish(Some(4 * SECOND));
        d.tick(
            Sample {
                awake: 5 * SECOND,
                continuous: 5 * SECOND,
                ..Sample::default()
            },
            &mut |e| events.push(e),
            &mut |_, _| true,
            false,
        );
        assert_eq!(
            events.iter().map(|r| r.kind).collect::<Vec<_>>(),
            [
                Kind::FaultInjected,
                Kind::HangStarted,
                Kind::HangRecovered,
                Kind::FaultAcknowledged
            ]
        );
    }
}
