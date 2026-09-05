// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::sync::Weak;

use crate::reserved_shortcut::TargetBinding;

/// Owned by AppWebview, never by its CEF client. Client bindings are weak so
/// closing a chrome does not leave Browser -> client -> Browser reference cycles.
pub(crate) struct NewTabTarget {
  #[cfg(target_os = "macos")]
  browser: cef::Browser,
  #[cfg(target_os = "macos")]
  webview_id: u32,
}

impl NewTabTarget {
  pub(crate) fn new(_browser: cef::Browser, _webview_id: u32) -> Self {
    Self {
      #[cfg(target_os = "macos")]
      browser: _browser,
      #[cfg(target_os = "macos")]
      webview_id: _webview_id,
    }
  }
}

/// An opaque weak reference to an explicitly selected browser chrome.
#[derive(Clone)]
pub struct NativeNewTabTarget(pub(crate) Weak<NewTabTarget>);

pub(crate) type NativeShortcutBinding = TargetBinding<NewTabTarget>;

#[cfg(target_os = "macos")]
pub(crate) fn dispatch(binding: &NativeShortcutBinding, source: &cef::Browser) -> bool {
  use cef::{CefString, ImplBrowser, ImplBrowserHost, ImplFrame};
  use objc2::MainThreadMarker;
  use objc2_app_kit::NSView;

  use crate::native_input_trace::{self, Stage};
  use crate::reserved_shortcut::{distinct_live_browsers, same_native_window, submit_then_focus};

  let Some(_mtm) = MainThreadMarker::new() else {
    return false;
  };
  let Some(target) = binding.resolve() else {
    return false;
  };
  // CEF can finish native closure before the runtime removes AppWebview.
  if !distinct_live_browsers(
    source.is_valid() != 0,
    target.browser.is_valid() != 0,
    || (source.identifier(), target.browser.identifier()),
  ) {
    return false;
  }
  let target_id = target.browser.identifier();
  let Some(source_host) = source.host() else {
    return false;
  };
  let Some(target_host) = target.browser.host() else {
    return false;
  };
  let Some(frame) = target.browser.main_frame() else {
    return false;
  };
  if frame.is_valid() == 0 {
    return false;
  }

  // SAFETY: these are the live CEF-owned NSViews supplied by window_handle on
  // macOS (the same contract as AppWebview::nsview). Borrow only on CEF UI,
  // after validity checks; never store either pointer or window reference.
  let Some(source_view) = (unsafe { source_host.window_handle().cast::<NSView>().as_ref() }) else {
    return false;
  };
  let Some(target_view) = (unsafe { target_host.window_handle().cast::<NSView>().as_ref() }) else {
    return false;
  };
  let source_window = source_view.window();
  let target_window = target_view.window();
  if !same_native_window(source_window.as_deref(), target_window.as_deref()) {
    return false;
  }

  // Submit to the chrome's renderer directly, before subsequent native input.
  // Submission is asynchronous; the chrome listener commits the launcher with
  // flushSync. No arbitrary script, command payload or page data crosses here.
  let script = CefString::from("window.dispatchEvent(new Event('dive-native-new-tab'))");
  let script_url = CefString::from("");
  submit_then_focus(
    || {
      native_input_trace::record(
        Stage::DirectSubmit,
        Some(target_id),
        Some(target.webview_id),
      );
      frame.execute_java_script(Some(&script), Some(&script_url), 0);
    },
    || {
      target_host.set_focus(1);
      native_input_trace::record(Stage::DirectFocus, Some(target_id), Some(target.webview_id));
    },
  )
}
