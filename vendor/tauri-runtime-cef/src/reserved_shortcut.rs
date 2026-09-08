// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Reserved New Tab and Address accelerator policy, independent of diagnostic flags.

#[cfg(any(target_os = "macos", test))]
use std::sync::Arc;
use std::sync::{Mutex, Weak};

pub(crate) struct WindowRoute<T> {
    pub(crate) source: Weak<T>,
    pub(crate) anchor: Weak<T>,
    pub(crate) expected: [WindowSnapshot; 3],
}
impl<T> Clone for WindowRoute<T> {
    fn clone(&self) -> Self {
        Self {
            source: self.source.clone(),
            anchor: self.anchor.clone(),
            expected: self.expected,
        }
    }
}

struct BoundTarget<T> {
    target: Weak<T>,
    route: Option<WindowRoute<T>>,
}

pub(crate) struct TargetBinding<T> {
    target: Mutex<BoundTarget<T>>,
}

impl<T> Default for TargetBinding<T> {
    fn default() -> Self {
        Self {
            target: Mutex::new(BoundTarget {
                target: Weak::new(),
                route: None,
            }),
        }
    }
}

impl<T> TargetBinding<T> {
    pub(crate) fn bind(&self, target: Option<Weak<T>>) {
        *self
            .target
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = BoundTarget {
            target: target.unwrap_or_default(),
            route: None,
        };
    }

    #[cfg(any(target_os = "macos", test))]
    pub(crate) fn bind_cross_window(&self, target: Weak<T>, route: WindowRoute<T>) {
        *self
            .target
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = BoundTarget {
            target,
            route: Some(route),
        };
    }

    #[cfg(test)]
    pub(crate) fn resolve(&self) -> Option<Arc<T>> {
        self.resolve_route().map(|(target, _)| target)
    }

    #[cfg(any(target_os = "macos", test))]
    pub(crate) fn resolve_route(&self) -> Option<(Arc<T>, Option<WindowRoute<T>>)> {
        // No callback runs with this guard held. Contention falls through without
        // waiting on a configuration update or any application/registry lock.
        let bound = self.target.try_lock().ok()?;
        Some((bound.target.upgrade()?, bound.route.clone()))
    }
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn distinct_live_browsers(
    source_valid: bool,
    target_valid: bool,
    identifiers: impl FnOnce() -> (i32, i32),
) -> bool {
    if !source_valid || !target_valid {
        return false;
    }
    let (source, target) = identifiers();
    source != target
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn bound_source_matches(valid: bool, identifiers: impl FnOnce() -> (i32, i32)) -> bool {
    valid && {
        let (bound, current) = identifiers();
        bound == current
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowSnapshot {
    pub(crate) window: usize,
    pub(crate) epoch: u64,
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn cross_window_matches(
    expected: [WindowSnapshot; 3],
    current: [Option<WindowSnapshot>; 3],
) -> bool {
    expected[0].window != 0
        && expected[2].window != 0
        && expected[0].window == expected[1].window
        && expected[0].window != expected[2].window
        && current == expected.map(Some)
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn address_window_matches(
    expected: [WindowSnapshot; 3],
    current: [Option<WindowSnapshot>; 3],
) -> bool {
    expected[0].window != 0
        && expected[0].window == expected[1].window
        && expected[0].window == expected[2].window
        && current == expected.map(Some)
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn same_native_window<T>(source: Option<&T>, target: Option<&T>) -> bool {
    match (source, target) {
        (Some(source), Some(target)) => std::ptr::eq(source, target),
        _ => false,
    }
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn submit_then_focus(submit: impl FnOnce(), focus: impl FnOnce()) -> bool {
    submit();
    focus();
    true
}

#[derive(Clone, Copy)]
#[cfg(any(target_os = "macos", test))]
pub(crate) struct ShortcutKey {
    pub(crate) raw_key_down: bool,
    pub(crate) key_code: i32,
    pub(crate) command: bool,
    pub(crate) control: bool,
    pub(crate) alt: bool,
    pub(crate) shift: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg(any(target_os = "macos", test))]
pub(crate) enum ShortcutAction {
    NewTab,
    FocusAddress,
}

/// Return handled only if the bound native chrome accepts the reserved chord.
/// Other keys retain the renderer's normal handling opportunity.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn dispatch_shortcut(
    macos: bool,
    key: ShortcutKey,
    has_native_event: bool,
    dispatch_bound_chrome: impl FnOnce(ShortcutAction) -> bool,
) -> bool {
    if !macos
        || !key.raw_key_down
        || !key.command
        || key.control
        || key.alt
        || key.shift
        || !has_native_event
    {
        return false;
    }
    let action = match key.key_code {
        84 => ShortcutAction::NewTab,
        76 => ShortcutAction::FocusAddress,
        _ => return false,
    };
    dispatch_bound_chrome(action)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::sync::Arc;

    #[test]
    fn address_route_accepts_self_or_sibling_only_with_current_window_epochs() {
        let source = WindowSnapshot {
            window: 11,
            epoch: 1,
        };
        let target = WindowSnapshot {
            window: 11,
            epoch: 2,
        };
        for expected in [[source; 3], [source, target, target]] {
            assert!(address_window_matches(expected, expected.map(Some)));
            for i in 0..3 {
                let mut absent = expected.map(Some);
                absent[i] = None;
                assert!(!address_window_matches(expected, absent));
                let mut changed = expected;
                changed[i].window = 22;
                assert!(!address_window_matches(expected, changed.map(Some)));
                let mut returned = expected;
                returned[i].epoch += 2;
                assert!(!address_window_matches(expected, returned.map(Some)));
            }
        }
        let foreign = [
            source,
            target,
            WindowSnapshot {
                window: 22,
                epoch: 2,
            },
        ];
        assert!(!address_window_matches(foreign, foreign.map(Some)));
    }

    #[test]
    fn explicit_cross_window_route_rejects_changed_or_missing_window_owners() {
        let expected = [
            WindowSnapshot {
                window: 11,
                epoch: 1,
            },
            WindowSnapshot {
                window: 11,
                epoch: 2,
            },
            WindowSnapshot {
                window: 22,
                epoch: 3,
            },
        ];
        assert!(cross_window_matches(expected, expected.map(Some)));
        for i in 0..3 {
            let mut missing = expected.map(Some);
            missing[i] = None;
            assert!(!cross_window_matches(expected, missing));
            let mut moved = expected;
            moved[i].window = 33;
            assert!(!cross_window_matches(expected, moved.map(Some)));
            // Moving away and back restores the pointer, but never the epoch.
            let mut returned = expected;
            returned[i].epoch += 2;
            assert!(!cross_window_matches(expected, returned.map(Some)));
        }
        let mut wrong_anchor = expected;
        wrong_anchor[1].window = 44;
        assert!(!cross_window_matches(wrong_anchor, wrong_anchor.map(Some)));
        let same_window = [expected[0]; 3];
        assert!(!cross_window_matches(same_window, same_window.map(Some)));
    }

    #[test]
    fn cross_window_binding_is_weak_and_default_rebind_removes_the_exception() {
        let source = Arc::new(11);
        let anchor = Arc::new(12);
        let target = Arc::new(22);
        let binding = TargetBinding::default();
        binding.bind_cross_window(
            Arc::downgrade(&target),
            WindowRoute {
                source: Arc::downgrade(&source),
                anchor: Arc::downgrade(&anchor),
                expected: [WindowSnapshot {
                    window: 1,
                    epoch: 0,
                }; 3],
            },
        );
        assert_eq!(Arc::strong_count(&source), 1);
        assert_eq!(Arc::strong_count(&anchor), 1);
        assert_eq!(Arc::strong_count(&target), 1);
        let (_, route) = binding.resolve_route().unwrap();
        drop(source);
        drop(anchor);
        let route = route.unwrap();
        assert!(route.source.upgrade().is_none());
        assert!(route.anchor.upgrade().is_none());
        binding.bind(Some(Arc::downgrade(&target)));
        assert!(binding.resolve_route().unwrap().1.is_none());
        drop(target);
        assert!(binding.resolve_route().is_none());
    }

    #[test]
    fn stale_binding_cannot_dispatch_for_a_different_or_closed_source_browser() {
        assert!(bound_source_matches(true, || (11, 11)));
        assert!(!bound_source_matches(true, || (11, 12)));
        assert!(!bound_source_matches(false, || panic!(
            "closed source identifier"
        )));
    }

    #[test]
    fn closed_browsers_are_rejected_before_further_native_inspection() {
        for (source_valid, target_valid) in [(false, true), (true, false), (false, false)] {
            assert!(!distinct_live_browsers(
                source_valid,
                target_valid,
                || panic!("closed browser")
            ));
        }
        assert!(!distinct_live_browsers(true, true, || (11, 11)));
        assert!(distinct_live_browsers(true, true, || (11, 22)));
    }

    #[test]
    fn actual_window_identity_must_match_and_neither_may_be_missing() {
        let main = Box::new(11);
        let other = Box::new(11);
        assert!(same_native_window(Some(&*main), Some(&*main)));
        assert!(!same_native_window(Some(&*main), Some(&*other)));
        assert!(!same_native_window(Some(&*main), None));
        assert!(!same_native_window(None, Some(&*main)));
        assert!(!same_native_window::<i32>(None, None));
    }

    #[test]
    fn direct_route_submits_once_then_focuses_once_before_reporting_handled() {
        let events = std::cell::RefCell::new(Vec::new());
        assert!(submit_then_focus(
            || events.borrow_mut().push("submit"),
            || events.borrow_mut().push("focus"),
        ));
        assert_eq!(&*events.borrow(), &["submit", "focus"]);
    }

    #[test]
    fn binding_is_weak_and_expires_when_native_view_owner_drops() {
        let binding = TargetBinding::default();
        let owner = Arc::new(11);
        binding.bind(Some(Arc::downgrade(&owner)));
        assert_eq!(Arc::strong_count(&owner), 1);
        assert_eq!(binding.resolve().as_deref(), Some(&11));
        drop(owner);
        assert!(binding.resolve().is_none());
    }

    #[test]
    fn rebind_and_clear_never_resolve_previous_target() {
        let binding = TargetBinding::default();
        let main = Arc::new(11);
        let other = Arc::new(22);
        binding.bind(Some(Arc::downgrade(&main)));
        binding.bind(Some(Arc::downgrade(&other)));
        assert_eq!(binding.resolve().as_deref(), Some(&22));
        binding.bind(None);
        assert!(binding.resolve().is_none());
        assert_eq!(Arc::strong_count(&main), 1);
        assert_eq!(Arc::strong_count(&other), 1);
    }

    #[test]
    fn contended_binding_fails_open_without_waiting() {
        let binding = TargetBinding::default();
        let owner = Arc::new(11);
        binding.bind(Some(Arc::downgrade(&owner)));
        let _held = binding.target.lock().unwrap();
        assert!(binding.resolve().is_none());
    }

    const CMD_T: ShortcutKey = ShortcutKey {
        raw_key_down: true,
        key_code: 84,
        command: true,
        control: false,
        alt: false,
        shift: false,
    };

    #[test]
    fn address_chord_selects_its_own_route_and_never_dispatches_new_tab() {
        let cmd_l = ShortcutKey {
            key_code: 76,
            ..CMD_T
        };
        let action = Cell::new(None);
        assert!(dispatch_shortcut(true, cmd_l, true, |selected| {
            action.set(Some(selected));
            true
        }));
        assert_eq!(action.get(), Some(ShortcutAction::FocusAddress));
        for key in [
            ShortcutKey {
                command: false,
                ..cmd_l
            },
            ShortcutKey {
                control: true,
                ..cmd_l
            },
            ShortcutKey { alt: true, ..cmd_l },
            ShortcutKey {
                shift: true,
                ..cmd_l
            },
            ShortcutKey {
                raw_key_down: false,
                ..cmd_l
            },
        ] {
            assert!(!dispatch_shortcut(true, key, true, |_| panic!(
                "unreserved input"
            )));
        }
        assert!(!dispatch_shortcut(true, cmd_l, true, |_| false));
        assert!(!dispatch_shortcut(true, cmd_l, false, |_| panic!(
            "no native event"
        )));
    }

    #[test]
    fn accepted_reserved_key_dispatches_once_and_is_consumed_before_renderer() {
        let calls = Cell::new(0);
        assert!(dispatch_shortcut(true, CMD_T, true, |_| {
            calls.set(calls.get() + 1);
            true
        }));
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn unavailable_target_leaves_fallback_available() {
        let calls = Cell::new(0);
        assert!(!dispatch_shortcut(true, CMD_T, true, |_| {
            calls.set(calls.get() + 1);
            false
        }));
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn nonmatching_keys_and_extra_shortcut_modifiers_never_dispatch() {
        for key in [
            ShortcutKey {
                raw_key_down: false,
                ..CMD_T
            },
            ShortcutKey {
                key_code: 75,
                ..CMD_T
            },
            ShortcutKey {
                key_code: 84,
                command: false,
                ..CMD_T
            },
            ShortcutKey {
                control: true,
                ..CMD_T
            },
            ShortcutKey { alt: true, ..CMD_T },
            ShortcutKey {
                shift: true,
                ..CMD_T
            },
        ] {
            assert!(!dispatch_shortcut(true, key, true, |_| panic!(
                "must pass through"
            )));
        }
    }

    #[test]
    fn missing_native_event_and_other_platforms_never_dispatch() {
        assert!(!dispatch_shortcut(true, CMD_T, false, |_| panic!(
            "nil event"
        )));
        assert!(!dispatch_shortcut(false, CMD_T, true, |_| panic!(
            "other platform"
        )));
    }
}
