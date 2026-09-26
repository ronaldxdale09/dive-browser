//! What Dive keeps for diagnosing a problem, and how it is handed over.
//!
//! Three things go into a report: the log (`logs/`), the records of Rust
//! panics (`crashes/`), and the main-thread heartbeat (`responsiveness/`).
//! This module keeps each bounded -- a day's log stops growing at
//! [`LOG_CAP_BYTES`], `crashes/` keeps the newest [`KEEP_CRASHES`] -- and
//! gathers them into one folder the person can attach to a report.

use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// The most one day's log file may grow to. A feed stuck in a loop logged
/// gigabytes in an afternoon; past this, the rest of the day is dropped with
/// one line saying so.
const LOG_CAP_BYTES: u64 = 20 * 1024 * 1024;

/// Panic records kept in `crashes/`, newest first.
const KEEP_CRASHES: usize = 20;

/// Log files included in an export, newest first.
const EXPORT_LOGS: usize = 3;

/// The log file the rolling appender writes today. Its dates are UTC.
fn todays_log(dir: &Path, day: time::Date) -> PathBuf {
    dir.join(format!(
        "dive.{:04}-{:02}-{:02}.log",
        day.year(),
        u8::from(day.month()),
        day.day()
    ))
}

/// A log writer that stops writing once a day's file reaches its cap.
///
/// The rolling appender underneath starts a new file each UTC day, so the
/// count restarts with the date.
pub(crate) struct CappedLog<W> {
    inner: W,
    day: time::Date,
    written: u64,
    cap: u64,
    noted: bool,
}

impl<W: Write> CappedLog<W> {
    /// Wrap `inner`, counting what today's file in `dir` already holds so a
    /// relaunch does not reset the allowance.
    pub(crate) fn new(inner: W, dir: &Path) -> Self {
        let day = time::OffsetDateTime::now_utc().date();
        let written = std::fs::metadata(todays_log(dir, day)).map_or(0, |m| m.len());
        Self::with_cap(inner, day, written, LOG_CAP_BYTES)
    }

    fn with_cap(inner: W, day: time::Date, written: u64, cap: u64) -> Self {
        Self {
            inner,
            day,
            written,
            cap,
            noted: false,
        }
    }

    fn write_on(&mut self, today: time::Date, buf: &[u8]) -> std::io::Result<usize> {
        if today != self.day {
            self.day = today;
            self.written = 0;
            self.noted = false;
        }
        if self.written.saturating_add(buf.len() as u64) > self.cap {
            if !self.noted {
                self.noted = true;
                let _ = self.inner.write_all(
                    b"-- log capped: today's file reached its size limit; later lines are dropped until tomorrow --\n",
                );
            }
            // Reported as written: a logger that sees an error retries or
            // complains, and neither helps here.
            return Ok(buf.len());
        }
        let n = self.inner.write(buf)?;
        self.written += n as u64;
        Ok(n)
    }
}

impl<W: Write> Write for CappedLog<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.write_on(time::OffsetDateTime::now_utc().date(), buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// Write a panic to `crashes/` with a backtrace and the build, then keep
/// only the newest records. Runs inside the panic hook, so nothing here may
/// panic in turn.
pub(crate) fn record_panic(dir: &Path, info: &std::panic::PanicHookInfo<'_>) {
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let stamp = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
        .replace(':', "-");
    // Forced, not `capture`: that one honours RUST_BACKTRACE, which no one
    // sets on a copy installed from a disk image, and a record without the
    // stack says where a panic happened but not how it got there.
    let backtrace = std::backtrace::Backtrace::force_capture();
    let body = format!(
        "dive {} ({})\n{}\nthread: {}\n{}\n\nbacktrace:\n{backtrace}\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        stamp,
        std::thread::current().name().unwrap_or("?"),
        info
    );
    let _ = std::fs::write(dir.join(format!("panic-{stamp}.txt")), body);
    prune(dir, KEEP_CRASHES);
}

/// Keep the newest `keep` files in `dir` by modification time.
fn prune(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| {
            let modified = e
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            (modified, e.path())
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    for (_, path) in files.into_iter().skip(keep) {
        let _ = std::fs::remove_file(path);
    }
}

/// The newest `n` files in `dir`, by name: log and crash files are stamped,
/// so the name orders them.
fn newest_files(dir: &Path, n: usize) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| e.path())
        .collect();
    files.sort();
    files.into_iter().rev().take(n).collect()
}

/// Copy what a report needs from `root` into a new folder in `into`.
fn gather(root: &Path, into: &Path, stamp: &str) -> std::io::Result<PathBuf> {
    let out = into.join(format!("Dive Diagnostics {stamp}"));
    std::fs::create_dir_all(&out)?;
    let parts = [
        ("logs", newest_files(&root.join("logs"), EXPORT_LOGS)),
        ("crashes", newest_files(&root.join("crashes"), KEEP_CRASHES)),
        (
            "responsiveness",
            newest_files(&root.join("responsiveness"), usize::MAX)
                .into_iter()
                .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
                .collect(),
        ),
    ];
    for (name, files) in parts {
        if files.is_empty() {
            continue;
        }
        let dir = out.join(name);
        std::fs::create_dir_all(&dir)?;
        for file in files {
            if let Some(file_name) = file.file_name() {
                std::fs::copy(&file, dir.join(file_name))?;
            }
        }
    }
    std::fs::write(
        out.join("about.txt"),
        format!(
            "Dive {}\n{} {}\nexported {stamp}\n",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH
        ),
    )?;
    Ok(out)
}

/// Gather the log, panic records and heartbeat into one folder in the
/// downloads folder and show it, ready to attach to a report. Returns its
/// path. A folder rather than an archive: no archive format is built into
/// this binary, and a folder is as easy to drag onto a report.
#[tauri::command]
#[specta::specta]
pub(crate) async fn diagnostics_export(state: State<'_, AppState>) -> AppResult<String> {
    let into = state.prefs.get(&state).download_dir();
    let root = crate::state::data_root();
    let stamp = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
        .replace(':', "-");
    let out = tauri::async_runtime::spawn_blocking(move || gather(&root, &into, &stamp))
        .await
        .map_err(AppError::new)?
        .map_err(|e| AppError::new(format!("could not gather the diagnostics: {e}")))?;
    crate::commands::reveal(&out)?;
    Ok(out.to_string_lossy().into_owned())
}

/// Show the log folder in the file manager.
#[tauri::command]
#[specta::specta]
pub(crate) fn diagnostics_reveal_logs() -> AppResult<()> {
    let logs = crate::state::data_root().join("logs");
    std::fs::create_dir_all(&logs).map_err(AppError::new)?;
    crate::commands::reveal(&logs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_days_log_stops_at_its_cap_and_starts_again_the_next_day() {
        let day = time::macros::date!(2026 - 09 - 27);
        let mut log = CappedLog::with_cap(Vec::new(), day, 0, 10);
        assert_eq!(log.write_on(day, b"12345").unwrap(), 5);
        assert_eq!(log.write_on(day, b"67890").unwrap(), 5);
        // Over the cap: swallowed, with one note the first time.
        assert_eq!(log.write_on(day, b"x").unwrap(), 1);
        assert_eq!(log.write_on(day, b"y").unwrap(), 1);
        let text = String::from_utf8(log.inner.clone()).unwrap();
        assert!(text.starts_with("1234567890-- log capped"), "{text}");
        assert_eq!(text.matches("log capped").count(), 1);
        // A new day is a new file with a fresh allowance.
        let next = time::macros::date!(2026 - 09 - 28);
        assert_eq!(log.write_on(next, b"z").unwrap(), 1);
        assert!(log.inner.ends_with(b"z"));
    }

    #[test]
    fn only_the_newest_crash_records_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..25 {
            let path = dir.path().join(format!("panic-{i:02}.txt"));
            std::fs::write(&path, b"x").unwrap();
            let when = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000 + i);
            std::fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(when)
                .unwrap();
        }
        prune(dir.path(), KEEP_CRASHES);
        let mut left: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left.len(), KEEP_CRASHES);
        assert_eq!(left.first().map(String::as_str), Some("panic-05.txt"));
    }

    #[test]
    fn an_export_gathers_logs_crashes_and_the_heartbeat() {
        let root = tempfile::tempdir().unwrap();
        let into = tempfile::tempdir().unwrap();
        for dir in ["logs", "crashes", "responsiveness"] {
            std::fs::create_dir_all(root.path().join(dir)).unwrap();
        }
        for day in 1..=5 {
            std::fs::write(
                root.path().join(format!("logs/dive.2026-09-0{day}.log")),
                b"l",
            )
            .unwrap();
        }
        std::fs::write(root.path().join("crashes/panic-a.txt"), b"p").unwrap();
        std::fs::write(root.path().join("responsiveness/current.jsonl"), b"{}").unwrap();
        std::fs::write(root.path().join("responsiveness/stall.request"), b"").unwrap();
        let out = gather(root.path(), into.path(), "T").unwrap();
        let mut logs: Vec<String> = std::fs::read_dir(out.join("logs"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        logs.sort();
        assert_eq!(
            logs,
            [
                "dive.2026-09-03.log",
                "dive.2026-09-04.log",
                "dive.2026-09-05.log"
            ]
        );
        assert!(out.join("crashes/panic-a.txt").is_file());
        assert!(out.join("responsiveness/current.jsonl").is_file());
        assert!(!out.join("responsiveness/stall.request").exists());
        assert!(out.join("about.txt").is_file());
    }
}
