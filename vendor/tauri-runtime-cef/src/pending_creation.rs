//! CEF-independent creation ownership and bounded ordered work.
//!
//! Admission -> ContextReady -> Submitted -> Attached -> Retired.
//! Cancellation/failure before submission is terminal and releases the parent.
//! Cancellation/failure after submission retains the parent; late completion is
//! adopted for close only, and only a close acknowledgement retires ownership.
//! Pending reparent is rejected without changing either logical or native owner.

use std::collections::VecDeque;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase {
    Admitted,
    ContextReady,
    Submitted,
    Attached,
    Retired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Completion {
    Attach,
    Close,
    Ignore,
}

pub(crate) struct Creation<Owner> {
    phase: Phase,
    owner: Owner,
    parent: Owner,
    terminal: bool,
}

impl<Owner: Copy> Creation<Owner> {
    pub(crate) fn new(owner: Owner) -> Self {
        Self {
            phase: Phase::Admitted,
            owner,
            parent: owner,
            terminal: false,
        }
    }
    pub(crate) fn owner(&self) -> Owner {
        self.owner
    }
    pub(crate) fn parent(&self) -> Owner {
        self.parent
    }
    pub(crate) fn context_ready(&mut self) -> bool {
        if self.phase != Phase::Admitted || self.terminal {
            return false;
        }
        self.phase = Phase::ContextReady;
        true
    }
    pub(crate) fn accept(&mut self) -> bool {
        if self.phase != Phase::ContextReady || self.terminal {
            return false;
        }
        self.phase = Phase::Submitted;
        true
    }
    pub(crate) fn cancel(&mut self) -> bool {
        self.fail()
    }
    pub(crate) fn fail(&mut self) -> bool {
        if self.terminal || self.phase == Phase::Retired {
            return false;
        }
        self.terminal = true;
        true
    }
    pub(crate) fn is_terminal(&self) -> bool {
        self.terminal
    }
    pub(crate) fn pins_parent(&self) -> bool {
        matches!(self.phase, Phase::Submitted | Phase::Attached)
    }
    pub(crate) fn complete(&mut self) -> Completion {
        if self.phase != Phase::Submitted {
            return Completion::Ignore;
        }
        self.phase = Phase::Attached;
        if self.terminal {
            Completion::Close
        } else {
            Completion::Attach
        }
    }
    pub(crate) fn retire(&mut self) -> bool {
        if self.phase != Phase::Attached {
            return false;
        }
        self.phase = Phase::Retired;
        true
    }
    pub(crate) fn reparent(&mut self, owner: Owner) -> bool {
        if self.phase != Phase::Attached || self.terminal {
            return false;
        }
        self.owner = owner;
        true
    }
}

pub(crate) struct PendingQueue<T> {
    entries: VecDeque<(T, usize)>,
    bytes: usize,
    max_count: usize,
    max_bytes: usize,
}
impl<T> PendingQueue<T> {
    pub(crate) fn new(max_count: usize, max_bytes: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            bytes: 0,
            max_count,
            max_bytes,
        }
    }
    pub(crate) fn push(&mut self, value: T, bytes: usize) -> Result<(), T> {
        if self.entries.len() >= self.max_count || bytes > self.max_bytes.saturating_sub(self.bytes)
        {
            return Err(value);
        }
        self.bytes += bytes;
        self.entries.push_back((value, bytes));
        Ok(())
    }
    pub(crate) fn pop(&mut self) -> Option<T> {
        self.entries.pop_front().map(|(value, bytes)| {
            self.bytes -= bytes;
            value
        })
    }
    pub(crate) fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }
}

/// Handler factories share this token instead of allocating one per handler.
#[derive(Default)]
pub(crate) struct CompletionToken(std::sync::atomic::AtomicI32);
impl CompletionToken {
    pub(crate) fn claim(&self, browser: i32) -> bool {
        browser > 0
            && self
                .0
                .compare_exchange(
                    0,
                    browser,
                    std::sync::atomic::Ordering::AcqRel,
                    std::sync::atomic::Ordering::Acquire,
                )
                .is_ok()
    }
    /// Whether a browser has been claimed at all. Before that, a callback
    /// cannot be attributed either way, so callers treat it as their own.
    pub(crate) fn claimed(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::Acquire) != 0
    }
    pub(crate) fn matches(&self, browser: i32) -> bool {
        browser > 0 && self.0.load(std::sync::atomic::Ordering::Acquire) == browser
    }
}

/// Weak registry with strong ownership held by both pending and live views.
pub(crate) struct SharedContexts<K, V>(std::collections::HashMap<K, Vec<std::sync::Weak<V>>>);
impl<K, V> Default for SharedContexts<K, V> {
    fn default() -> Self {
        Self(Default::default())
    }
}
impl<K: Eq + std::hash::Hash, V> SharedContexts<K, V> {
    pub(crate) fn get(&mut self, key: &K) -> Option<std::sync::Arc<V>> {
        self.0.retain(|_, values| {
            values.retain(|value| value.strong_count() > 0);
            !values.is_empty()
        });
        self.0
            .get(key)
            .and_then(|values| values.iter().find_map(std::sync::Weak::upgrade))
    }
    pub(crate) fn publish(&mut self, key: K, value: &std::sync::Arc<V>) {
        self.0
            .entry(key)
            .or_default()
            .push(std::sync::Arc::downgrade(value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[test]
    fn delayed_context_cancellation_suppresses_submission() {
        let mut creation = Creation::new(7);
        assert!(creation.cancel());
        assert!(!creation.context_ready());
        assert!(!creation.accept());
        assert!(!creation.pins_parent());
    }

    #[test]
    fn accepted_cancellation_pins_parent_until_close_ack() {
        let mut creation = submitted();
        assert!(creation.cancel());
        assert!(creation.pins_parent());
        assert_eq!(creation.complete(), Completion::Close);
        assert!(creation.pins_parent());
        assert!(creation.retire());
        assert!(!creation.pins_parent());
        assert!(!creation.retire());
    }

    #[test]
    fn duplicate_completion_cannot_adopt_or_close_another_browser() {
        let mut creation = submitted();
        assert_eq!(creation.complete(), Completion::Attach);
        assert_eq!(creation.complete(), Completion::Ignore);
        assert!(creation.retire());
        assert_eq!(creation.complete(), Completion::Ignore);
    }

    #[test]
    fn timeout_is_failure_not_cef_retirement() {
        let mut creation = submitted();
        assert!(creation.fail());
        assert!(!creation.fail());
        assert!(creation.is_terminal());
        assert!(creation.pins_parent());
        assert_eq!(creation.complete(), Completion::Close);
        assert!(creation.retire());
    }

    #[test]
    fn context_and_submission_rejection_release_parent() {
        let mut creation = Creation::new(7);
        assert!(creation.fail());
        assert!(!creation.context_ready());
        assert!(!creation.pins_parent());
        let mut creation = Creation::new(7);
        assert!(creation.context_ready());
        assert!(creation.fail());
        assert!(!creation.pins_parent());
    }

    #[test]
    fn pending_reparent_preserves_owner_and_captured_parent() {
        let mut creation = submitted();
        assert!(!creation.reparent(9));
        assert_eq!(creation.owner(), 7);
        assert_eq!(creation.parent(), 7);
        assert_eq!(creation.complete(), Completion::Attach);
        assert!(creation.reparent(9));
        assert_eq!(creation.owner(), 9);
        assert_eq!(creation.parent(), 7);
    }

    #[test]
    fn shutdown_keeps_every_accepted_child_until_acknowledged() {
        let mut creations = [Creation::new(7), submitted(), submitted()];
        for creation in &mut creations {
            creation.cancel();
        }
        assert_eq!(creations.iter().filter(|c| c.pins_parent()).count(), 2);
        assert_eq!(creations[1].complete(), Completion::Close);
        assert!(creations[1].retire());
        assert!(!creations[1].retire());
        assert_eq!(creations.iter().filter(|c| c.pins_parent()).count(), 1);
    }

    #[test]
    fn ordered_work_is_bounded_by_count_and_bytes_without_losing_ownership() {
        let mut queue = PendingQueue::new(2, 5);
        assert!(queue.push("one", 3).is_ok());
        assert!(queue.push("two", 2).is_ok());
        assert_eq!(queue.push("overflow", 0), Err("overflow"));
        assert_eq!(queue.pop(), Some("one"));
        assert_eq!(queue.push("large", 4), Err("large"));
        assert_eq!(queue.pop(), Some("two"));
        assert!(queue.push("exact", 5).is_ok());
    }

    #[test]
    fn cancellation_releases_queued_callbacks() {
        struct Callback(Arc<AtomicUsize>);
        impl Drop for Callback {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(AtomicUsize::new(0));
        let mut queue = PendingQueue::new(4, 10);
        assert!(queue.push(Callback(dropped.clone()), 1).is_ok());
        queue.clear();
        queue.clear();
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn shared_factory_instances_deliver_completion_once() {
        let token = Arc::new(CompletionToken::default());
        let second_handler = token.clone();
        assert!(token.claim(17));
        assert!(!second_handler.claim(18));
        assert!(second_handler.matches(17));
        assert!(!second_handler.matches(18));
    }

    #[test]
    fn private_context_is_shared_while_first_creation_is_still_pending() {
        let mut contexts = SharedContexts::default();
        let first = Arc::new(7);
        contexts.publish("private", &first);
        let second = contexts.get(&"private").unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        assert!(contexts.get(&"other").is_none());
        contexts.publish("private", &second);
        drop(first);
        assert!(contexts.get(&"private").is_some());
        drop(second);
        assert!(contexts.get(&"private").is_none());
    }

    fn submitted() -> Creation<u32> {
        let mut creation = Creation::new(7);
        assert!(creation.context_ready());
        assert!(creation.accept());
        creation
    }
}
