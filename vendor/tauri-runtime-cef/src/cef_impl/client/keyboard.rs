// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use crate::native_input_trace::{self, Stage};
use cef::*;

#[cfg(target_os = "linux")]
type CefOsEvent<'a> = Option<&'a mut cef::sys::XEvent>;
#[cfg(target_os = "macos")]
type CefOsEvent<'a> = *mut u8;
#[cfg(windows)]
type CefOsEvent<'a> = Option<&'a mut cef::sys::MSG>;

fn trace_key(stage: Stage, browser: Option<&Browser>, event: Option<&KeyEvent>) {
  if !native_input_trace::enabled() {
    return;
  }
  let Some(event) = event else { return };
  use cef::sys::{cef_event_flags_t as Flags, cef_key_event_type_t};
  let raw_key_down = event.type_ == cef_key_event_type_t::KEYEVENT_RAWKEYDOWN.into();
  let key_down = raw_key_down || event.type_ == cef_key_event_type_t::KEYEVENT_KEYDOWN.into();
  if !key_down {
    return;
  }
  #[cfg(windows)]
  let modifiers = event.modifiers as i32;
  #[cfg(not(windows))]
  let modifiers = event.modifiers;
  let classification = native_input_trace::classify_key(
    cfg!(target_os = "macos"),
    raw_key_down,
    event.windows_key_code,
    modifiers & Flags::EVENTFLAG_COMMAND_DOWN.0 != 0,
    modifiers & Flags::EVENTFLAG_CONTROL_DOWN.0 != 0,
    modifiers & Flags::EVENTFLAG_ALT_DOWN.0 != 0,
    modifiers & Flags::EVENTFLAG_SHIFT_DOWN.0 != 0,
  );
  native_input_trace::key_event(
    stage,
    key_down,
    classification,
    browser.map(|b| b.identifier()),
  );
}

#[cfg(target_os = "macos")]
fn dispatch_reserved_shortcut(
  binding: &crate::reserved_shortcut_native::NativeShortcutBinding,
  browser: Option<&Browser>,
  event: Option<&KeyEvent>,
  os_event: CefOsEvent<'_>,
) -> bool {
  use crate::reserved_shortcut::{ShortcutKey, dispatch_shortcut};
  use cef::sys::{cef_event_flags_t as Flags, cef_key_event_type_t};
  use objc2::MainThreadMarker;
  use objc2_app_kit::{NSEvent, NSEventType};

  let Some(event) = event else { return false };
  let Some(browser) = browser else { return false };
  let modifiers = event.modifiers;
  dispatch_shortcut(
    true,
    ShortcutKey {
      raw_key_down: event.type_ == cef_key_event_type_t::KEYEVENT_RAWKEYDOWN.into(),
      key_code: event.windows_key_code,
      command: modifiers & Flags::EVENTFLAG_COMMAND_DOWN.0 != 0,
      control: modifiers & Flags::EVENTFLAG_CONTROL_DOWN.0 != 0,
      alt: modifiers & Flags::EVENTFLAG_ALT_DOWN.0 != 0,
      shift: modifiers & Flags::EVENTFLAG_SHIFT_DOWN.0 != 0,
    },
    !os_event.is_null(),
    |action| {
      let Some(_mtm) = MainThreadMarker::new() else {
        return false;
      };
      // SAFETY: CEF supplies the native NSEvent for this UI-thread callback;
      // the event is borrowed here, never retained or stored.
      let Some(event) = (unsafe { os_event.cast::<NSEvent>().as_ref() }) else {
        return false;
      };
      event.r#type() == NSEventType::KeyDown
        && crate::reserved_shortcut_native::dispatch(binding, browser, action)
    },
  )
}

wrap_keyboard_handler! {
  pub struct TauriCefKeyboardHandler {
    devtools_enabled: bool,
    shortcut_binding: std::sync::Arc<crate::reserved_shortcut_native::NativeShortcutBinding>,
  }

  impl KeyboardHandler {
    fn on_pre_key_event(
      &self,
      _browser: Option<&mut Browser>,
      event: Option<&KeyEvent>,
      _os_event: CefOsEvent<'_>,
      _is_keyboard_shortcut: Option<&mut ::std::os::raw::c_int>,
    ) -> ::std::os::raw::c_int {
      trace_key(Stage::PreKey, _browser.as_deref(), event);
      // Bound reserved chords submit directly to the selected chrome before
      // subsequent native input. Unbound chords retain DOM/menu fallback.
      #[cfg(target_os = "macos")]
      if dispatch_reserved_shortcut(&self.shortcut_binding, _browser.as_deref(), event, _os_event) {
        return 1;
      }
      // If devtools is disabled, block devtools keyboard shortcuts.
      if !self.devtools_enabled {
        let Some(event) = event else {
          return 0;
        };

        // Check if this is a keydown event.
        use cef::sys::cef_key_event_type_t;
        let keydown_type: cef::KeyEventType = cef_key_event_type_t::KEYEVENT_RAWKEYDOWN.into();
        if event.type_ != keydown_type {
          return 0;
        }

        // Get modifier keys.
        use cef::sys::cef_event_flags_t;
        #[cfg(windows)]
        let modifiers = event.modifiers as i32;
        #[cfg(not(windows))]
        let modifiers = event.modifiers;

        #[cfg(not(target_os = "macos"))]
        let ctrl = (modifiers & (cef_event_flags_t::EVENTFLAG_CONTROL_DOWN.0)) != 0;
        #[cfg(not(target_os = "macos"))]
        let shift = (modifiers & (cef_event_flags_t::EVENTFLAG_SHIFT_DOWN.0)) != 0;

        let key_code = event.windows_key_code;

        // Block F12 (key code 123).
        if key_code == 123 {
          if let Some(is_keyboard_shortcut) = _is_keyboard_shortcut {
            *is_keyboard_shortcut = 1;
          }
          return 1;
        }

        // Block Ctrl+Shift+I (key code 73 = 'I') on Linux/Windows.
        #[cfg(not(target_os = "macos"))]
        if key_code == 73 && ctrl && shift {
          if let Some(is_keyboard_shortcut) = _is_keyboard_shortcut {
            *is_keyboard_shortcut = 1;
          }
          return 1;
        }

        // Block Cmd+Opt+I on macOS.
        #[cfg(target_os = "macos")]
        {
          let meta = (modifiers & cef_event_flags_t::EVENTFLAG_COMMAND_DOWN.0) != 0;
          let alt = (modifiers & cef_event_flags_t::EVENTFLAG_ALT_DOWN.0) != 0;
          if key_code == 73 && meta && alt {
            if let Some(is_keyboard_shortcut) = _is_keyboard_shortcut {
              *is_keyboard_shortcut = 1;
            }
            return 1;
          }
        }
      }

      0
    }

    fn on_key_event(
      &self,
      browser: Option<&mut Browser>,
      event: Option<&KeyEvent>,
      _os_event: CefOsEvent<'_>,
    ) -> ::std::os::raw::c_int {
      trace_key(Stage::PostKey, browser.as_deref(), event);
      // Preserve the generated handler's default: let CEF continue its fallback.
      0
    }
  }
}
