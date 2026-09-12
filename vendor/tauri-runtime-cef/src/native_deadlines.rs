//! Cancellable native-loop deadlines. No workers, threads or channel tombstones.

use std::{
    collections::{BTreeMap, BTreeSet},
    time::Instant,
};

/// Both indexes contain exactly the active entries: cancellation removes the
/// timer rather than leaving tombstones until the original deadline expires.
pub(crate) struct Deadlines<K> {
    by_id: BTreeMap<K, Instant>,
    by_time: BTreeSet<(Instant, K)>,
    capacity: usize,
}

impl<K: Ord + Copy> Deadlines<K> {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            by_id: BTreeMap::new(),
            by_time: BTreeSet::new(),
            capacity,
        }
    }

    pub(crate) fn schedule(&mut self, id: K, at: Instant) -> bool {
        if self.by_id.len() >= self.capacity && !self.by_id.contains_key(&id) {
            return false;
        }
        if let Some(previous) = self.by_id.insert(id, at) {
            self.by_time.remove(&(previous, id));
        }
        self.by_time.insert((at, id));
        true
    }

    pub(crate) fn cancel(&mut self, id: &K) -> bool {
        if let Some(at) = self.by_id.remove(id) {
            self.by_time.remove(&(at, *id));
            true
        } else {
            false
        }
    }

    pub(crate) fn next(&self) -> Option<Instant> {
        self.by_time.first().map(|(at, _)| *at)
    }

    pub(crate) fn pop_due(&mut self, now: Instant) -> Option<K> {
        if self.next().is_none_or(|at| at > now) {
            return None;
        }
        let (_, id) = self.by_time.pop_first()?;
        self.by_id.remove(&id);
        Some(id)
    }

    pub(crate) fn clear(&mut self) {
        self.by_id.clear();
        self.by_time.clear();
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        assert_eq!(self.by_id.len(), self.by_time.len());
        self.by_id.len()
    }
}

pub(crate) fn earliest(first: Option<Instant>, second: Option<Instant>) -> Option<Instant> {
    first.into_iter().chain(second).min()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn completed_and_canceled_creations_do_not_accumulate_timer_entries() {
        let now = Instant::now();
        let mut deadlines = Deadlines::new(8);
        for id in 0..100_000 {
            assert!(deadlines.schedule(id, now + Duration::from_secs(15)));
            assert!(deadlines.cancel(&id));
            assert_eq!(deadlines.len(), 0);
            assert_eq!(deadlines.next(), None);
        }
        assert_eq!(deadlines.pop_due(now + Duration::from_secs(30)), None);
    }

    #[test]
    fn active_entries_are_bounded_and_replacement_removes_old_deadline() {
        let now = Instant::now();
        let mut deadlines = Deadlines::new(2);
        assert!(deadlines.schedule(1, now));
        assert!(deadlines.schedule(2, now + Duration::from_secs(2)));
        assert!(!deadlines.schedule(3, now));
        assert!(deadlines.schedule(1, now + Duration::from_secs(3)));
        assert_eq!(deadlines.len(), 2);
        assert_eq!(deadlines.pop_due(now), None);
        assert_eq!(deadlines.pop_due(now + Duration::from_secs(2)), Some(2));
        assert_eq!(deadlines.pop_due(now + Duration::from_secs(3)), Some(1));
        assert_eq!(deadlines.next(), None);
    }

    #[test]
    fn simultaneous_deadlines_expire_once_and_cancellation_is_immediate() {
        let now = Instant::now();
        let mut deadlines = Deadlines::new(4);
        assert!(deadlines.schedule(3, now));
        assert!(deadlines.schedule(1, now));
        assert!(deadlines.schedule(2, now));
        assert!(deadlines.cancel(&2));
        assert!(!deadlines.cancel(&2));
        assert_eq!(deadlines.pop_due(now), Some(1));
        assert_eq!(deadlines.pop_due(now), Some(3));
        assert_eq!(deadlines.pop_due(now), None);
    }

    #[test]
    fn shutdown_discards_deadlines_without_waiting_or_late_worker_messages() {
        let now = Instant::now();
        let mut deadlines = Deadlines::new(4096);
        for id in 0..4096 {
            assert!(deadlines.schedule(id, now + Duration::from_secs(15)));
        }
        deadlines.clear();
        assert_eq!(deadlines.len(), 0);
        assert_eq!(deadlines.next(), None);
        assert_eq!(deadlines.pop_due(now + Duration::from_secs(30)), None);
        // Reopen starts with no stale IDs or capacity consumed by old timers.
        assert!(deadlines.schedule(4096, now));
        assert_eq!(deadlines.pop_due(now), Some(4096));
    }

    #[test]
    fn event_loop_selects_earliest_timer_without_losing_other_pump_deadline() {
        let now = Instant::now();
        let later = now + Duration::from_secs(1);
        assert_eq!(earliest(Some(now), Some(later)), Some(now));
        assert_eq!(earliest(Some(later), Some(now)), Some(now));
        assert_eq!(earliest(None, Some(now)), Some(now));
        assert_eq!(earliest(Some(now), None), Some(now));
        assert_eq!(earliest(None, None), None);
    }
}
