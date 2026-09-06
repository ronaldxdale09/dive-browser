//! Per-export capabilities and private files. Cancellation waits for worker cleanup.
use crate::{
    error::{AppError, AppResult},
    screencast::{RecordingResult, program_name, stop_child, wait_with_deadline},
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::HashMap,
    fs::File,
    io::Write as _,
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::{
        Arc, Condvar, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

pub(super) const CHUNK_LIMIT: usize = 8 * 1024 * 1024;
const TOTAL_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const JOB_LIMIT: usize = 16;
const TERMINAL_LIMIT: usize = 64;
const CANCEL_WAIT: Duration = Duration::from_secs(15);
const PROCESS_LIMIT: Duration = Duration::from_mins(30);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CancelResult {
    Cancelled,
    Completed,
}

#[derive(Clone, Default)]
pub(crate) struct Registry {
    jobs: Arc<Mutex<HashMap<String, Arc<Job>>>>,
    lifecycle: Arc<Lifecycle>,
    /// Staging left by a crashed run is removed once, before the first job.
    swept: Arc<AtomicBool>,
}

// Admission and Quit publish to separate atomics, then read the other one.
// All lifecycle accesses use SeqCst: if begin admits before its exit check,
// Quit must observe its active lease; if Quit observes zero active leases,
// begin must observe the closed admission state. Acquire/Release alone permits
// both loads to observe the old zero (a store-buffering execution).
#[derive(Default)]
struct Lifecycle {
    active: AtomicUsize,
    exit: AtomicU8,
}
struct ActiveLease(Arc<Lifecycle>);
impl Drop for ActiveLease {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}

enum Phase {
    Uploading {
        file: File,
        bytes: u64,
    },
    Running,
    Terminal {
        completed: bool,
        cleanup_error: Option<String>,
    },
}

pub(crate) struct Job {
    owner: String,
    root: PathBuf,
    path: PathBuf,
    directory: Mutex<Option<tempfile::TempDir>>,
    phase: Mutex<Phase>,
    cancelled: AtomicBool,
    published: AtomicBool,
    settled: Condvar,
    unreaped: Mutex<Vec<Child>>,
    activity: Mutex<Option<ActiveLease>>,
    lifecycle: Arc<Lifecycle>,
}

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ExitAction {
    Immediate,
    Drain,
    InProgress,
}

impl Registry {
    /// Main-thread admission is atomics only, never a file/job mutex.
    pub fn prepare_exit(&self) -> ExitAction {
        loop {
            let state = self.lifecycle.exit.load(Ordering::SeqCst);
            match state {
                1 => return ExitAction::InProgress,
                3 => return ExitAction::Immediate,
                _ => {
                    if self
                        .lifecycle
                        .exit
                        .compare_exchange(state, 1, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok()
                    {
                        if self.lifecycle.active.load(Ordering::SeqCst) == 0 {
                            self.lifecycle.exit.store(3, Ordering::SeqCst);
                            return ExitAction::Immediate;
                        }
                        return ExitAction::Drain;
                    }
                }
            }
        }
    }
    pub fn finish_exit(&self, success: bool) {
        self.lifecycle
            .exit
            .store(if success { 3 } else { 2 }, Ordering::SeqCst);
    }
    /// Background only: one aggregate wait budget, all workers already signaled.
    pub fn drain_shutdown(&self, timeout: Duration) -> AppResult<()> {
        let deadline = Instant::now() + timeout;
        let jobs: Vec<_> = lock(&self.jobs)
            .iter()
            .map(|(id, job)| (id.clone(), job.owner.clone()))
            .collect();
        let mut first_error = None;
        for (id, owner) in jobs {
            if let Err(error) = self.cancel_for(
                &owner,
                &id,
                deadline.saturating_duration_since(Instant::now()),
            ) {
                first_error.get_or_insert(error);
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }
        if self.lifecycle.active.load(Ordering::SeqCst) != 0 {
            return Err(AppError::new("export cleanup has not been confirmed"));
        }
        Ok(())
    }

    pub fn begin(&self, root: &Path, owner: &str) -> AppResult<String> {
        let mut jobs = lock(&self.jobs);
        if self.lifecycle.exit.load(Ordering::SeqCst) != 0 {
            return Err(AppError::new("application is stopping exports"));
        }
        self.lifecycle.active.fetch_add(1, Ordering::SeqCst);
        let activity = ActiveLease(self.lifecycle.clone());
        if self.lifecycle.exit.load(Ordering::SeqCst) != 0 {
            return Err(AppError::new("application is stopping exports"));
        }
        let active = jobs
            .values()
            .filter(|job| {
                !matches!(
                    *lock(&job.phase),
                    Phase::Terminal {
                        cleanup_error: None,
                        ..
                    }
                )
            })
            .count();
        if active >= JOB_LIMIT {
            return Err(AppError::new("too many active exports"));
        }
        if jobs.len() >= TERMINAL_LIMIT + JOB_LIMIT {
            jobs.retain(|_, job| {
                !matches!(
                    *lock(&job.phase),
                    Phase::Terminal {
                        cleanup_error: None,
                        ..
                    }
                )
            });
        }
        let root = root.canonicalize()?;
        let staging = root.join(".export");
        std::fs::create_dir_all(&staging)?;
        let staging = staging.canonicalize()?;
        if !staging.starts_with(&root) {
            return Err(AppError::new("export staging escapes captures"));
        }
        if !self.swept.swap(true, Ordering::SeqCst) {
            sweep_stale(&root, &staging);
        }
        let directory = tempfile::Builder::new()
            .prefix("job-")
            .tempdir_in(&staging)?;
        let path = directory.path().to_path_buf();
        let file = File::create_new(path.join("render.webm"))?;
        let id = dive_core::TabId::new().to_string();
        jobs.insert(
            id.clone(),
            Arc::new(Job {
                owner: owner.into(),
                root,
                path,
                directory: Mutex::new(Some(directory)),
                phase: Mutex::new(Phase::Uploading { file, bytes: 0 }),
                cancelled: AtomicBool::new(false),
                published: AtomicBool::new(false),
                settled: Condvar::new(),
                unreaped: Mutex::new(Vec::new()),
                activity: Mutex::new(Some(activity)),
                lifecycle: self.lifecycle.clone(),
            }),
        );
        Ok(id)
    }

    fn get(&self, owner: &str, id: &str) -> AppResult<Arc<Job>> {
        lock(&self.jobs)
            .get(id)
            .filter(|job| job.owner == owner)
            .cloned()
            .ok_or_else(|| AppError::new("unknown export job"))
    }

    pub fn append(&self, owner: &str, id: &str, offset: u64, bytes: &[u8]) -> AppResult<()> {
        if bytes.len() > CHUNK_LIMIT {
            return Err(AppError::new("export chunk exceeds limit"));
        }
        let job = self.get(owner, id)?;
        let mut phase = lock(&job.phase);
        let Phase::Uploading {
            file,
            bytes: written,
        } = &mut *phase
        else {
            return Err(AppError::new("export is no longer accepting frames"));
        };
        job.check()?;
        let next = written
            .checked_add(bytes.len() as u64)
            .filter(|next| *next <= TOTAL_LIMIT)
            .ok_or_else(|| AppError::new("export exceeds size limit"))?;
        if offset != *written {
            return Err(AppError::new("export chunk is out of order"));
        }
        if let Err(error) = file.write_all(bytes) {
            job.cancelled.store(true, Ordering::Release);
            return Err(error.into());
        }
        *written = next;
        Ok(())
    }

    pub fn claim(&self, owner: &str, id: &str) -> AppResult<Arc<Job>> {
        let job = self.get(owner, id)?;
        {
            let mut phase = lock(&job.phase);
            let Phase::Uploading { file, bytes } = &mut *phase else {
                return Err(AppError::new(
                    "export has already been finished or cancelled",
                ));
            };
            job.check()?;
            if *bytes == 0 {
                return Err(AppError::new("export has no frames"));
            }
            file.sync_all()?;
            *phase = Phase::Running;
        }
        Ok(job)
    }

    pub fn cancel(&self, owner: &str, id: &str) -> AppResult<CancelResult> {
        self.cancel_for(owner, id, CANCEL_WAIT)
    }

    fn cancel_for(&self, owner: &str, id: &str, timeout: Duration) -> AppResult<CancelResult> {
        let job = self.get(owner, id)?;
        let mut phase = lock(&job.phase);
        if matches!(
            *phase,
            Phase::Uploading { .. }
                | Phase::Terminal {
                    cleanup_error: Some(_),
                    ..
                }
        ) {
            job.cancelled.store(true, Ordering::Release);
            // Drop the upload handle before removing its exclusively owned directory.
            *phase = Phase::Running;
            drop(phase);
            let cleanup = job.cleanup();
            phase = lock(&job.phase);
            *phase = Phase::Terminal {
                completed: job.published.load(Ordering::Acquire),
                cleanup_error: cleanup.err().map(|error| error.to_string()),
            };
            job.settled.notify_all();
        } else if matches!(*phase, Phase::Running) {
            job.cancelled.store(true, Ordering::Release);
            let (next, _) = job
                .settled
                .wait_timeout_while(phase, timeout, |phase| matches!(phase, Phase::Running))
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            phase = next;
        }
        match &*phase {
            Phase::Terminal {
                cleanup_error: Some(error),
                ..
            } => Err(AppError::new(error)),
            Phase::Terminal {
                completed: true, ..
            } => Ok(CancelResult::Completed),
            Phase::Terminal {
                completed: false, ..
            } => Ok(CancelResult::Cancelled),
            _ => Err(AppError::new("export cancellation has not been confirmed")),
        }
    }
}

impl Job {
    pub fn staged(&self) -> PathBuf {
        self.path.join("render.webm")
    }
    pub fn output(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }
    pub fn source(&self, source: &str) -> AppResult<PathBuf> {
        let path = Path::new(source).canonicalize()?;
        if !path.starts_with(&self.root)
            || path.starts_with(self.root.join(".export"))
            || !path.is_file()
        {
            return Err(AppError::new("not a source recording"));
        }
        Ok(path)
    }
    pub fn check(&self) -> AppResult<()> {
        if self.cancelled.load(Ordering::Acquire) || self.lifecycle.exit.load(Ordering::SeqCst) != 0
        {
            Err(AppError::new("export cancelled"))
        } else {
            Ok(())
        }
    }
    fn cleanup(&self) -> AppResult<()> {
        let mut unreaped = lock(&self.unreaped);
        unreaped.retain_mut(|child| stop_child(child).is_err());
        if !unreaped.is_empty() {
            return Err(AppError::new("export child exit could not be confirmed"));
        }
        drop(unreaped);
        if let Some(directory) = lock(&self.directory).take() {
            let _ = directory.keep();
        }
        match std::fs::remove_dir_all(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        lock(&self.activity).take();
        Ok(())
    }
    /// Called after the owned worker has reaped every spawned child.
    pub fn settle(&self, result: AppResult<RecordingResult>) -> AppResult<RecordingResult> {
        let cleanup = self.cleanup();
        let mut phase = lock(&self.phase);
        // Publication already won the same mutex against cancellation.
        let completed = self.published.load(Ordering::Acquire);
        *phase = Phase::Terminal {
            completed,
            cleanup_error: cleanup.as_ref().err().map(ToString::to_string),
        };
        self.settled.notify_all();
        cleanup?;
        result
    }
    /// Publish the final media last, so Library never observes an unfinished file.
    pub fn publish(
        &self,
        output: &Path,
        preview: Option<&Path>,
        name: &str,
    ) -> AppResult<(PathBuf, Option<PathBuf>)> {
        let _phase = lock(&self.phase);
        self.check()?;
        let final_path = self.root.join(name);
        let final_preview = if let Some(preview) = preview {
            let directory = self.root.join(crate::screencast::PREVIEW_DIR);
            std::fs::create_dir_all(&directory)?;
            if !directory.canonicalize()?.starts_with(&self.root) {
                return Err(AppError::new("preview directory escapes captures"));
            }
            let target = directory.join(Path::new(name).with_extension("webm"));
            // Hard links atomically expose complete bytes and refuse existing destinations.
            std::fs::hard_link(preview, &target)?;
            Some(target)
        } else {
            None
        };
        if let Err(error) = std::fs::hard_link(output, &final_path) {
            if let Some(preview) = &final_preview {
                let _ = std::fs::remove_file(preview);
            }
            return Err(error.into());
        }
        self.published.store(true, Ordering::Release);
        Ok((final_path, final_preview))
    }
    pub fn run(&self, command: &mut Command) -> AppResult<Output> {
        self.run_for(command, PROCESS_LIMIT)
    }
    fn run_for(&self, command: &mut Command, timeout: Duration) -> AppResult<Output> {
        self.check()?;
        let name = program_name(command);
        let mut stdout = tempfile::tempfile()?;
        let mut stderr = tempfile::tempfile()?;
        let child = command
            .stdin(Stdio::null())
            .stdout(stdout.try_clone()?)
            .stderr(stderr.try_clone()?)
            .spawn()?;
        let mut child = OwnedChild {
            child: Some(child),
            unreaped: &self.unreaped,
        };
        let waited = wait_with_deadline(
            child.child.as_mut().expect("worker owns child"),
            &mut stdout,
            &mut stderr,
            Instant::now() + timeout,
            &name,
            || self.check(),
        );
        let output = match waited {
            Ok(output) => output,
            Err(error) => {
                child.stop()?;
                return Err(error);
            }
        };
        self.check()?;
        Ok(output)
    }
}

/// Remove `job-*` directories a crashed run left in `staging`. Nothing else
/// is touched: `staging` must be the canonical `.export` directly under
/// the canonical captures `root`.
fn sweep_stale(root: &Path, staging: &Path) {
    if staging.parent() != Some(root) || staging.file_name().is_none_or(|n| n != ".export") {
        return;
    }
    let Ok(entries) = std::fs::read_dir(staging) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let stale = path
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with("job-"))
            && entry.file_type().is_ok_and(|t| t.is_dir())
            && path.parent() == Some(staging);
        if stale {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/// Retain a process whose termination failed; its files must remain owned.
struct OwnedChild<'a> {
    child: Option<Child>,
    unreaped: &'a Mutex<Vec<Child>>,
}
impl OwnedChild<'_> {
    fn stop(&mut self) -> AppResult<()> {
        stop_child(self.child.as_mut().expect("worker owns child"))
    }
}
impl Drop for OwnedChild<'_> {
    fn drop(&mut self) {
        if self.stop().is_err()
            && let Some(child) = self.child.take()
        {
            lock(self.unreaped).push(child);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn raw_recording_path_is_never_an_append_or_finish_capability() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("original.mp4");
        std::fs::write(&source, b"original recording").unwrap();
        let jobs = Registry::default();
        let raw = source.to_str().unwrap();
        assert!(jobs.append("chrome", raw, 0, b"damage").is_err());
        assert!(jobs.claim("chrome", raw).is_err());
        assert_eq!(std::fs::read(source).unwrap(), b"original recording");
    }
    #[test]
    fn job_id_is_opaque_and_bound_to_its_chrome_owner() {
        let root = tempfile::tempdir().unwrap();
        let jobs = Registry::default();
        let id = jobs.begin(root.path(), "chrome").unwrap();
        assert!(!id.contains('/'));
        assert!(jobs.append("other-chrome", &id, 0, b"frames").is_err());
        assert!(jobs.claim("other-chrome", &id).is_err());
    }
    #[test]
    fn uploads_are_ordered_and_finish_is_exclusive() {
        let root = tempfile::tempdir().unwrap();
        let jobs = Registry::default();
        let id = jobs.begin(root.path(), "chrome").unwrap();
        jobs.append("chrome", &id, 0, b"frames").unwrap();
        assert!(jobs.append("chrome", &id, 0, b"duplicate").is_err());
        jobs.claim("chrome", &id).unwrap();
        assert!(jobs.claim("chrome", &id).is_err());
        assert!(jobs.append("chrome", &id, 6, b"late").is_err());
    }
    #[test]
    fn rejects_oversized_chunks_and_cancel_cleans_only_its_own_upload() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("original.mp4");
        std::fs::write(&source, b"original").unwrap();
        let jobs = Registry::default();
        let id = jobs.begin(root.path(), "chrome").unwrap();
        let job = jobs.get("chrome", &id).unwrap();
        assert!(
            jobs.append("chrome", &id, 0, &vec![0; CHUNK_LIMIT + 1])
                .is_err()
        );
        assert_eq!(std::fs::metadata(job.staged()).unwrap().len(), 0);
        jobs.append("chrome", &id, 0, b"frames").unwrap();
        assert_eq!(jobs.cancel("chrome", &id).unwrap(), CancelResult::Cancelled);
        assert!(!job.path.exists());
        assert_eq!(std::fs::read(source).unwrap(), b"original");
        assert_eq!(jobs.cancel("chrome", &id).unwrap(), CancelResult::Cancelled);
        assert!(jobs.append("chrome", &id, 6, b"late").is_err());
    }

    fn completed(path: &Path) -> RecordingResult {
        RecordingResult {
            path: path.to_string_lossy().into_owned(),
            duration_secs: 1.0,
            bytes: 5.0,
            width: 64,
            height: 64,
            format: "mp4".into(),
            frames: 1,
            has_audio: false,
            events: None,
            preview: None,
        }
    }

    #[test]
    fn publication_wins_cancellation_without_overwriting_or_deleting_finished_media() {
        let root = tempfile::tempdir().unwrap();
        let jobs = Registry::default();
        let id = jobs.begin(root.path(), "chrome").unwrap();
        jobs.append("chrome", &id, 0, b"frames").unwrap();
        let job = jobs.claim("chrome", &id).unwrap();
        let output = job.output("finished.mp4");
        std::fs::write(&output, b"video").unwrap();
        let (published, _) = job.publish(&output, None, "finished.mp4").unwrap();
        job.settle(Ok(completed(&published))).unwrap();
        assert_eq!(jobs.cancel("chrome", &id).unwrap(), CancelResult::Completed);
        assert_eq!(std::fs::read(published).unwrap(), b"video");
        assert!(!job.path.exists());
    }

    #[test]
    fn publication_failure_preserves_existing_media_and_cleans_new_preview() {
        let root = tempfile::tempdir().unwrap();
        let jobs = Registry::default();
        let id = jobs.begin(root.path(), "chrome").unwrap();
        jobs.append("chrome", &id, 0, b"frames").unwrap();
        let job = jobs.claim("chrome", &id).unwrap();
        std::fs::write(root.path().join("existing.mp4"), b"original").unwrap();
        let output = job.output("finished.mp4");
        let preview = job.output("preview.webm");
        std::fs::write(&output, b"new").unwrap();
        std::fs::write(&preview, b"preview").unwrap();
        assert!(
            job.publish(&output, Some(&preview), "existing.mp4")
                .is_err()
        );
        assert_eq!(
            std::fs::read(root.path().join("existing.mp4")).unwrap(),
            b"original"
        );
        assert!(
            !root
                .path()
                .join(crate::screencast::PREVIEW_DIR)
                .join("existing.webm")
                .exists()
        );
        assert!(
            job.settle(Err(AppError::new("publication failed")))
                .is_err()
        );
        assert!(!job.path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_reaps_the_owned_child_before_confirming_and_blocks_publication() {
        for shutdown in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let jobs = Registry::default();
            let id = jobs.begin(root.path(), "chrome").unwrap();
            jobs.append("chrome", &id, 0, b"frames").unwrap();
            let job = jobs.claim("chrome", &id).unwrap();
            let pid_file = job.output("child.pid");
            let worker_job = job.clone();
            let child_pid_file = pid_file.clone();
            let worker = std::thread::spawn(move || {
                let mut command = Command::new("/bin/sh");
                command
                    .args(["-c", "echo $$ > \"$1\"; exec sleep 30", "fixture"])
                    .arg(child_pid_file);
                let error = worker_job
                    .run_for(&mut command, Duration::from_secs(5))
                    .unwrap_err();
                assert!(error.to_string().contains("cancelled"));
                assert!(
                    worker_job
                        .publish(&worker_job.staged(), None, "never.mp4")
                        .is_err()
                );
                worker_job.settle(Err(error))
            });
            let deadline = Instant::now() + Duration::from_secs(2);
            while !pid_file.exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            let pid = std::fs::read_to_string(&pid_file).unwrap();
            if shutdown {
                assert_eq!(jobs.prepare_exit(), ExitAction::Drain);
                jobs.drain_shutdown(Duration::from_secs(1)).unwrap();
                jobs.finish_exit(true);
                assert_eq!(jobs.prepare_exit(), ExitAction::Immediate);
            } else {
                assert_eq!(jobs.cancel("chrome", &id).unwrap(), CancelResult::Cancelled);
            }
            assert!(worker.join().unwrap().is_err());
            assert!(
                !Command::new("/bin/kill")
                    .args(["-0", pid.trim()])
                    .stderr(Stdio::null())
                    .status()
                    .unwrap()
                    .success()
            );
            assert!(!job.path.exists());
            assert!(!root.path().join("never.mp4").exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn subprocess_deadline_reaps_child_and_cleans_staging() {
        let root = tempfile::tempdir().unwrap();
        let jobs = Registry::default();
        let id = jobs.begin(root.path(), "chrome").unwrap();
        jobs.append("chrome", &id, 0, b"frames").unwrap();
        let job = jobs.claim("chrome", &id).unwrap();
        let mut command = Command::new("/bin/sleep");
        command.arg("30");
        let error = job
            .run_for(&mut command, Duration::from_millis(40))
            .unwrap_err();
        assert!(error.to_string().contains("timed out"));
        assert!(job.settle(Err(error)).is_err());
        assert!(!job.path.exists());
    }
    #[test]
    fn first_begin_sweeps_stale_staging_and_leaves_live_jobs_and_captures_alone() {
        let root = tempfile::tempdir().unwrap();
        let staging = root.path().join(".export");
        std::fs::create_dir_all(staging.join("job-stale")).unwrap();
        std::fs::write(staging.join("job-stale").join("render.webm"), b"half").unwrap();
        std::fs::write(staging.join("notes.txt"), b"keep").unwrap();
        std::fs::write(root.path().join("job-lookalike.mp4"), b"keep").unwrap();
        std::fs::create_dir_all(root.path().join("job-dir")).unwrap();
        let jobs = Registry::default();
        let first = jobs.begin(root.path(), "chrome").unwrap();
        assert!(!staging.join("job-stale").exists());
        assert!(staging.join("notes.txt").exists());
        assert!(root.path().join("job-lookalike.mp4").exists());
        assert!(root.path().join("job-dir").exists());
        let live = jobs.get("chrome", &first).unwrap();
        assert!(live.path.exists());
        // A second admission never sweeps: the first job's directory survives.
        jobs.begin(root.path(), "chrome").unwrap();
        assert!(live.path.exists());
    }

    #[test]
    fn unconfirmed_cancellation_can_be_retried_after_worker_cleanup() {
        let root = tempfile::tempdir().unwrap();
        let jobs = Registry::default();
        let id = jobs.begin(root.path(), "chrome").unwrap();
        jobs.append("chrome", &id, 0, b"frames").unwrap();
        let job = jobs.claim("chrome", &id).unwrap();
        let error = jobs
            .cancel_for("chrome", &id, Duration::from_millis(5))
            .unwrap_err();
        assert!(error.to_string().contains("not been confirmed"));
        assert!(job.path.exists());
        assert!(job.settle(Err(AppError::new("export cancelled"))).is_err());
        assert_eq!(jobs.cancel("chrome", &id).unwrap(), CancelResult::Cancelled);
        assert!(!job.path.exists());
    }

    #[test]
    fn cancellation_between_publication_and_cleanup_reports_completed() {
        let root = tempfile::tempdir().unwrap();
        let jobs = Registry::default();
        let id = jobs.begin(root.path(), "chrome").unwrap();
        jobs.append("chrome", &id, 0, b"frames").unwrap();
        let job = jobs.claim("chrome", &id).unwrap();
        let output = job.output("finished.mp4");
        std::fs::write(&output, b"video").unwrap();
        let (published, _) = job.publish(&output, None, "finished.mp4").unwrap();
        let cancel_jobs = jobs.clone();
        let cancel_id = id.clone();
        let cancel = std::thread::spawn(move || cancel_jobs.cancel("chrome", &cancel_id));
        let deadline = Instant::now() + Duration::from_secs(1);
        while !job.cancelled.load(Ordering::Acquire) && Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert!(job.cancelled.load(Ordering::Acquire));
        job.settle(Ok(completed(&published))).unwrap();
        assert_eq!(cancel.join().unwrap().unwrap(), CancelResult::Completed);
        assert_eq!(std::fs::read(published).unwrap(), b"video");
        assert!(!job.path.exists());
    }
    #[test]
    fn quit_is_immediate_without_owned_work_and_drains_uploads_once() {
        assert_eq!(Registry::default().prepare_exit(), ExitAction::Immediate);
        let root = tempfile::tempdir().unwrap();
        let jobs = Registry::default();
        let id = jobs.begin(root.path(), "chrome").unwrap();
        let job = jobs.get("chrome", &id).unwrap();
        assert_eq!(jobs.prepare_exit(), ExitAction::Drain);
        assert_eq!(jobs.prepare_exit(), ExitAction::InProgress);
        assert!(jobs.begin(root.path(), "chrome").is_err());
        jobs.drain_shutdown(Duration::from_secs(1)).unwrap();
        assert!(!job.path.exists());
        jobs.finish_exit(true);
        assert_eq!(jobs.prepare_exit(), ExitAction::Immediate);
    }

    #[test]
    fn failed_quit_drain_stays_retryable_and_signals_running_worker_immediately() {
        let root = tempfile::tempdir().unwrap();
        let jobs = Registry::default();
        let id = jobs.begin(root.path(), "chrome").unwrap();
        jobs.append("chrome", &id, 0, b"frames").unwrap();
        let job = jobs.claim("chrome", &id).unwrap();
        assert_eq!(jobs.prepare_exit(), ExitAction::Drain);
        assert!(job.check().is_err());
        assert!(jobs.drain_shutdown(Duration::from_millis(5)).is_err());
        jobs.finish_exit(false);
        assert_eq!(jobs.prepare_exit(), ExitAction::Drain);
        assert!(job.settle(Err(AppError::new("export cancelled"))).is_err());
        jobs.drain_shutdown(Duration::from_millis(5)).unwrap();
        jobs.finish_exit(true);
        assert_eq!(jobs.prepare_exit(), ExitAction::Immediate);
    }
    #[test]
    fn concurrent_admission_and_quit_never_admit_work_behind_immediate_exit() {
        use std::sync::Barrier;
        let root = tempfile::tempdir().unwrap();
        for _ in 0..256 {
            let jobs = Registry::default();
            let start = Barrier::new(3);
            let (admission, exit) = std::thread::scope(|scope| {
                let admission = scope.spawn(|| {
                    start.wait();
                    jobs.begin(root.path(), "chrome")
                });
                let exit = scope.spawn(|| {
                    start.wait();
                    jobs.prepare_exit()
                });
                start.wait();
                (admission.join().unwrap(), exit.join().unwrap())
            });
            match exit {
                ExitAction::Immediate => {
                    assert!(admission.is_err(), "Quit bypassed an admitted export");
                    assert_eq!(jobs.lifecycle.active.load(Ordering::SeqCst), 0);
                }
                ExitAction::Drain => {
                    // A reservation may be noticed before begin's second gate
                    // rejects it; both that case and an admitted job must drain.
                    jobs.drain_shutdown(Duration::from_secs(1)).unwrap();
                    jobs.finish_exit(true);
                    assert_eq!(jobs.prepare_exit(), ExitAction::Immediate);
                }
                ExitAction::InProgress => panic!("only one Quit ran"),
            }
        }
    }
}
