// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Page lifecycle and find results handed to the application.
//!
//! Two CEF callbacks have nothing to do with a Tauri webview event but
//! everything to do with a browser tab: the moment a page agrees to close
//! (after its `beforeunload` handler had its say), and the results of the
//! engine's own find in page. Both are delivered on CEF's UI thread, so the
//! application's handlers must hand the work on rather than re-enter the
//! runtime from inside the callback.

use std::sync::{Arc, Mutex};

use cef::*;

/// One report from the engine's find in page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FindUpdate {
    /// The search this report belongs to; a new query starts a new one.
    pub identifier: i32,
    /// Matches found so far on the page, frames included.
    pub count: i32,
    /// 1-based position of the highlighted match, 0 when there is none.
    pub active_match_ordinal: i32,
    /// Whether the engine has finished counting for this search.
    pub final_update: bool,
}

type CloseListener = Arc<dyn Fn() + Send + Sync>;
type FindListener = Arc<dyn Fn(FindUpdate) + Send + Sync>;

/// Per-webview hand-off for page close acceptance and find results.
#[derive(Default)]
pub struct PageEvents {
    close: Mutex<Option<CloseListener>>,
    find: Mutex<Option<FindListener>>,
}

impl PageEvents {
    /// `handler` hears when the engine has committed to closing this page,
    /// whoever asked: a graceful close the page allowed, a forced close, or
    /// the page's own `window.close()`.
    pub fn install_close(&self, handler: CloseListener) {
        *self.close.lock().unwrap() = Some(handler);
    }

    /// `handler` receives every find report for this page.
    pub fn install_find(&self, handler: FindListener) {
        *self.find.lock().unwrap() = Some(handler);
    }

    pub(crate) fn closing(&self) {
        // Taken out of the lock before the call, so a handler that installs
        // another (or drops this webview's last reference) cannot deadlock.
        let handler = self.close.lock().unwrap().clone();
        if let Some(handler) = handler {
            handler();
        }
    }

    fn found(&self, update: FindUpdate) {
        let handler = self.find.lock().unwrap().clone();
        if let Some(handler) = handler {
            handler(update);
        }
    }
}

wrap_find_handler! {
  pub struct TauriCefFindHandler { events: Arc<PageEvents> }
  impl FindHandler {
    fn on_find_result(&self, _browser: Option<&mut Browser>, identifier: i32, count: i32, _selection_rect: Option<&Rect>, active_match_ordinal: i32, final_update: i32) {
      self.events.found(FindUpdate { identifier, count, active_match_ordinal, final_update: final_update != 0 });
    }
  }
}
