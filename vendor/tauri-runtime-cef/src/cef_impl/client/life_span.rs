// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::sync::{Arc, mpsc::Sender};

use cef::*;
use tauri_runtime::{
    UserEvent,
    dpi::{LogicalPosition, LogicalSize},
    window::WindowId,
};
use winit::event_loop::EventLoopProxy as WinitEventLoopProxy;

use crate::runtime::{CefRuntime, Message, NewWindowOpener, RuntimeContext};

wrap_life_span_handler! {
  pub struct TauriCefChildLifeSpanHandler<T: UserEvent> {
    sender: Sender<Message<T>>,
    proxy: WinitEventLoopProxy,
    window_id: WindowId,
    webview_id: u32,
    context: RuntimeContext<T>,
    new_window_handler: Option<Arc<tauri_runtime::webview::NewWindowHandler<T, CefRuntime<T>>>>,
    creation_delivered: Arc<crate::pending_creation::CompletionToken>,
    permissions: Arc<super::permission::PermissionBridge>,
    page_events: Arc<super::page_events::PageEvents>,
  }

  impl LifeSpanHandler {
    fn on_after_created(&self, browser: Option<&mut Browser>) {
      if let Some(browser) = browser
        && self.creation_delivered.claim(browser.identifier())
      {
        let _ = self.sender.send(Message::BrowserCreated(self.webview_id, browser.clone()));
        self.proxy.wake_up();
      }
    }

    fn on_before_popup(
      &self,
      _browser: Option<&mut Browser>,
      _frame: Option<&mut Frame>,
      _popup_id: std::os::raw::c_int,
      target_url: Option<&CefString>,
      _target_frame_name: Option<&CefString>,
      _target_disposition: WindowOpenDisposition,
      _user_gesture: std::os::raw::c_int,
      popup_features: Option<&PopupFeatures>,
      _window_info: Option<&mut WindowInfo>,
      _client: Option<&mut Option<Client>>,
      _settings: Option<&mut BrowserSettings>,
      _extra_info: Option<&mut Option<DictionaryValue>>,
      _no_javascript_access: Option<&mut i32>,
    ) -> std::os::raw::c_int {
      let Some(handler) = &self.new_window_handler else {
        return 0;
      };

      let Some(target_url) = target_url else {
        return 1;
      };

      let url_str = target_url.to_string();
      let Ok(url) = url::Url::parse(&url_str) else {
        return 1;
      };

      // window.open() features are CSS pixels, which map to Tauri's logical units.
      let size = popup_features.and_then(|features| {
        (features.width_set != 0 && features.height_set != 0)
          .then(|| LogicalSize::new(features.width as f64, features.height as f64))
      });
      let position = popup_features.and_then(|features| {
        (features.x_set != 0 && features.y_set != 0)
          .then(|| LogicalPosition::new(features.x as f64, features.y as f64))
      });
      let features =
        tauri_runtime::webview::NewWindowFeatures::new(size, position, NewWindowOpener {});

      match handler(url, features) {
        tauri_runtime::webview::NewWindowResponse::Allow => 0,
        tauri_runtime::webview::NewWindowResponse::Create { window_id } => {
          // CEF cannot transplant a popup's contents into an existing
          // browser, so cancel the popup and navigate the designated
          // window's first webview to the URL instead — the closest
          // equivalent of wry hosting the popup in that window's webview.
          // Note `window.opener` is not linked to the new document.
          // Queued like its siblings below, never sent inline: this fires
          // from inside a CEF callback, and `send_message` runs the message
          // there and then when it is already on the main thread -- which can
          // re-enter a handler that is still running.
          let _ = self.sender.send(Message::NavigateFirstWebview {
            window_id,
            url: url_str,
          });
          self.proxy.wake_up();
          1
        }
        tauri_runtime::webview::NewWindowResponse::Deny => 1,
      }
    }

    /// Take over the browser close so it does not take the window down with it.
    ///
    /// Returning 0 runs CEF's default, which sends the standard close
    /// notification to the browser's *top-level parent window* (`performClose:`
    /// on macOS, `WM_CLOSE` on Windows). Every Tauri webview is a child browser
    /// parented to a shared window, so that default turns "close this webview"
    /// into "close the window and every sibling webview" — and with the last
    /// window gone, the app exits.
    ///
    /// Returning 1 leaves the parent window alone and makes us responsible for
    /// completing the close, which means destroying this browser's own child
    /// view/window on the event loop. That destruction is what drives CEF's
    /// `WindowDestroyed` -> `on_before_close` sequence.
    ///
    /// On Linux the default only closes the browser's own X11 child window (and
    /// calls `WindowDestroyed` itself), so the default is already correct there.
    fn do_close(&self, browser: Option<&mut Browser>) -> std::os::raw::c_int {
      if !browser.is_some_and(|browser| self.creation_delivered.matches(browser.identifier())) {
        return 0;
      }
      log::debug!(target: "dive_native_close", "stage=do_close webview={}", self.webview_id);

      // The engine is committed to closing now: a graceful close got past
      // the page's `beforeunload`, or the close was forced. The application
      // hears it after the host view's removal is queued, so its own forced
      // close of the view, which follows, finds the close already under way.
      #[cfg(any(target_os = "macos", windows))]
      {
        let _ = self
          .sender
          .send(Message::DestroyWebviewHostWindow(self.webview_id));
        self.page_events.closing();
        self.proxy.wake_up();
        return 1;
      }

      #[cfg(not(any(target_os = "macos", windows)))]
      {
        self.page_events.closing();
        0
      }
    }

    fn on_before_close(&self, browser: Option<&mut Browser>) {
      let Some(browser) = browser else { return; };
      if !self.creation_delivered.matches(browser.identifier()) { return; }
      self.permissions.navigating(None);
      log::debug!(target: "dive_native_close", "stage=before_close webview={}", self.webview_id);
      let _ = self
        .sender
        .send(Message::BrowserClosed(self.window_id, self.webview_id, browser.identifier()));
      self.proxy.wake_up();
    }
  }
}
