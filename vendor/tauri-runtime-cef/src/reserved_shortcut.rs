// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! The reserved New Tab accelerator policy, independent of diagnostic flags.

#[cfg(any(target_os = "macos", test))]
use std::sync::Arc;
use std::sync::{Mutex, Weak};

pub(crate) struct TargetBinding<T> {
  target: Mutex<Weak<T>>,
}

impl<T> Default for TargetBinding<T> {
  fn default() -> Self {
    Self {
      target: Mutex::new(Weak::new()),
    }
  }
}

impl<T> TargetBinding<T> {
  pub(crate) fn bind(&self, target: Option<Weak<T>>) {
    *self
      .target
      .lock()
      .unwrap_or_else(|error| error.into_inner()) = target.unwrap_or_default();
  }

  #[cfg(any(target_os = "macos", test))]
  pub(crate) fn resolve(&self) -> Option<Arc<T>> {
    // No callback runs with this guard held, and engine callbacks never wait
    // for a configuration update to release the per-view pointer.
    self.target.try_lock().ok()?.upgrade()
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

/// Return handled only if the bound native chrome accepts the reserved chord.
/// Other keys retain the renderer's normal handling opportunity.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn dispatch_new_tab(
  macos: bool,
  key: ShortcutKey,
  has_native_event: bool,
  dispatch_bound_chrome: impl FnOnce() -> bool,
) -> bool {
  macos
    && key.raw_key_down
    && key.key_code == 84
    && key.command
    && !key.control
    && !key.alt
    && !key.shift
    && has_native_event
    && dispatch_bound_chrome()
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::cell::Cell;
  use std::sync::Arc;

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
  fn accepted_reserved_key_dispatches_once_and_is_consumed_before_renderer() {
    let calls = Cell::new(0);
    assert!(dispatch_new_tab(true, CMD_T, true, || {
      calls.set(calls.get() + 1);
      true
    }));
    assert_eq!(calls.get(), 1);
  }

  #[test]
  fn unavailable_target_leaves_fallback_available() {
    let calls = Cell::new(0);
    assert!(!dispatch_new_tab(true, CMD_T, true, || {
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
      assert!(!dispatch_new_tab(true, key, true, || panic!(
        "must pass through"
      )));
    }
  }

  #[test]
  fn missing_native_event_and_other_platforms_never_dispatch() {
    assert!(!dispatch_new_tab(true, CMD_T, false, || panic!(
      "nil event"
    )));
    assert!(!dispatch_new_tab(false, CMD_T, true, || panic!(
      "other platform"
    )));
  }
}
