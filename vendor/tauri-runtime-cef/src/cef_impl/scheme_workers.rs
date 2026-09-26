// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Threads that answer custom-scheme requests.
//!
//! Every IPC call from a page and every asset the app serves over its own
//! scheme used to get a fresh OS thread, started and torn down per request.
//! A small set of threads is kept instead. A request never waits for one,
//! though: synchronous commands run on these threads, and some of them wait
//! on the main thread or on each other, so when every kept thread is busy the
//! request gets a thread of its own, as before.

use std::sync::{
  Arc, Mutex, OnceLock,
  atomic::{AtomicUsize, Ordering},
  mpsc,
};

type Job = Box<dyn FnOnce() + Send + 'static>;

/// Threads kept for requests.
const WORKERS: usize = 8;

struct Pool {
  jobs: mpsc::Sender<Job>,
  /// Kept threads not running a job. A job is only queued after claiming
  /// one of these, so a queued job never waits behind a busy thread.
  idle: Arc<AtomicUsize>,
}

impl Pool {
  fn start(workers: usize) -> Self {
    let (jobs, receiver) = mpsc::channel::<Job>();
    let receiver = Arc::new(Mutex::new(receiver));
    let idle = Arc::new(AtomicUsize::new(0));
    for index in 0..workers {
      let receiver = receiver.clone();
      let worker_idle = idle.clone();
      let started = std::thread::Builder::new()
        .name(format!("scheme-worker-{index}"))
        .spawn(move || {
          loop {
            let job = {
              let receiver = receiver
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
              receiver.recv()
            };
            let Ok(job) = job else { return };
            // A handler that panics loses its request, as it did on a thread
            // of its own, but not this thread.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
            worker_idle.fetch_add(1, Ordering::AcqRel);
          }
        });
      if started.is_ok() {
        idle.fetch_add(1, Ordering::AcqRel);
      }
    }
    Self { jobs, idle }
  }

  fn run(&self, job: Job) {
    let claimed = self
      .idle
      .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_sub(1))
      .is_ok();
    if claimed {
      match self.jobs.send(job) {
        Ok(()) => return,
        Err(mpsc::SendError(job)) => {
          self.idle.fetch_add(1, Ordering::AcqRel);
          spawn(job);
        }
      }
    } else {
      spawn(job);
    }
  }
}

fn spawn(job: Job) {
  if let Err(error) = std::thread::Builder::new()
    .name("scheme-request".into())
    .spawn(job)
  {
    log::error!("could not start a thread for a custom-scheme request: {error}");
  }
}

/// Answer a request on a kept thread, or on a new one when all are busy.
pub(crate) fn run(job: impl FnOnce() + Send + 'static) {
  static POOL: OnceLock<Pool> = OnceLock::new();
  POOL.get_or_init(|| Pool::start(WORKERS)).run(Box::new(job));
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::Barrier;
  use std::time::Duration;

  #[test]
  fn requests_run_on_kept_threads_and_overflow_never_waits() {
    let pool = Pool::start(2);
    // Two jobs hold both kept threads until the third has run.
    let gate = Arc::new(Barrier::new(3));
    let (done, finished) = mpsc::channel::<String>();
    for _ in 0..2 {
      let gate = gate.clone();
      let done = done.clone();
      pool.run(Box::new(move || {
        gate.wait();
        let _ = done.send(std::thread::current().name().unwrap_or_default().to_owned());
      }));
    }
    let overflow = done.clone();
    pool.run(Box::new(move || {
      let _ = overflow.send(std::thread::current().name().unwrap_or_default().to_owned());
    }));
    // The third job ran although both kept threads were blocked.
    let first = finished.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(first, "scheme-request");
    gate.wait();
    let mut kept: Vec<_> = (0..2)
      .map(|_| finished.recv_timeout(Duration::from_secs(5)).unwrap())
      .collect();
    kept.sort();
    assert_eq!(kept, ["scheme-worker-0", "scheme-worker-1"]);
    // Both threads are free again, and a panicking job does not lose one.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while pool.idle.load(Ordering::Acquire) != 2 && std::time::Instant::now() < deadline {
      std::thread::yield_now();
    }
    pool.run(Box::new(|| panic!("handler failed")));
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while pool.idle.load(Ordering::Acquire) != 2 && std::time::Instant::now() < deadline {
      std::thread::yield_now();
    }
    assert_eq!(pool.idle.load(Ordering::Acquire), 2);
  }
}
