// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::sync::Arc;

use cef::*;

use crate::webview::INITIAL_LOAD_URL;

// A popup this webview opened shares its client, so every callback below
// arrives for both browsers. Only the webview's own browser may report a title
// or an address: a sign-in popup that renamed the page behind it -- and rewrote
// the URL the session restores -- is what `is_own_browser` is for.
wrap_display_handler! {
  pub struct TauriCefDisplayHandler {
    document_title_changed_handler: Option<Arc<tauri_runtime::webview::DocumentTitleChangedHandler>>,
    address_changed_handler: Option<Arc<tauri_runtime::webview::AddressChangedHandler>>,
    creation_delivered: Arc<crate::pending_creation::CompletionToken>,
  }

  impl DisplayHandler {
    fn on_title_change(
      &self,
      browser: Option<&mut Browser>,
      title: Option<&CefString>,
    ) {
      if !self.is_own_browser(browser.as_deref()) {
        return;
      }
      let Some(handler) = &self.document_title_changed_handler else {
        return;
      };
      let Some(title) = title else {
        return;
      };

      handler(title.to_string());
    }

    fn on_address_change(
      &self,
      browser: Option<&mut Browser>,
      frame: Option<&mut Frame>,
      url: Option<&CefString>,
    ) {
      if !self.is_own_browser(browser.as_deref()) {
        return;
      }
      // Only fire for main frame URL changes (matches on_before_browse behavior).
      if let Some(frame) = frame
        && frame.is_main() == 0
      {
        return;
      }
      let Some(handler) = &self.address_changed_handler else {
        return;
      };
      let Some(url) = url else {
        return;
      };
      let url = url.to_string();

      if url == INITIAL_LOAD_URL {
        return;
      }

      if let Ok(url) = url::Url::parse(&url) {
        handler(&url);
      }
    }
  }
}

impl TauriCefDisplayHandler {
    /// Whether a callback is about the browser this handler was made for.
    /// A popup opened from this webview shares the client, so it reports here
    /// too; until a browser is claimed nothing can be attributed, and the
    /// callback counts as this webview's own.
    fn is_own_browser(&self, browser: Option<&Browser>) -> bool {
        use cef::ImplBrowser;
        if !self.creation_delivered.claimed() {
            return true;
        }
        browser.is_some_and(|browser| self.creation_delivered.matches(browser.identifier()))
    }
}
