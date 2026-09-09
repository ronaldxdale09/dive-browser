// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! JavaScript dialogs (`alert`, `confirm`, `prompt`, `beforeunload`) handed
//! to the application instead of CEF's native modal. A native modal blocks
//! the process's main thread, which freezes every window and every
//! automation call; a bridged dialog only pauses the page's script, the way
//! it does in Chrome, while the chrome shows its own card and answers it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use cef::*;

/// Which dialog the page opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsDialogKind {
    Alert,
    Confirm,
    Prompt,
    /// A `beforeunload` handler asked whether to leave; `is_reload` says why.
    BeforeUnload,
}

/// A dialog the page opened, as the application sees it.
#[derive(Debug, Clone)]
pub struct JsDialogRequest {
    pub id: u64,
    pub kind: JsDialogKind,
    /// The page's origin (`https://example.com`), or empty for `beforeunload`.
    pub origin: String,
    pub message: String,
    /// The prompt's suggested text.
    pub default_value: String,
    pub is_reload: bool,
}

type Handler = Arc<dyn Fn(JsDialogRequest) + Send + Sync>;
type Reset = Arc<dyn Fn(Vec<u64>) + Send + Sync>;
type Answer = Box<dyn FnOnce(bool, Option<String>) + Send>;

/// Per-webview hand-off between CEF's dialog callbacks and the application.
#[derive(Default)]
pub struct JsDialogBridge {
    handlers: Mutex<Option<(Handler, Reset)>>,
    pending: Mutex<HashMap<u64, Answer>>,
    next: AtomicU64,
}

impl JsDialogBridge {
    /// `handler` receives each dialog on its own thread; `reset` hears which
    /// pending dialogs the page took back (a navigation, for one).
    pub fn install(&self, handler: Handler, reset: Reset) {
        *self.handlers.lock().unwrap() = Some((handler, reset));
    }

    fn submit(&self, kind: JsDialogKind, origin: String, message: String, default_value: String, is_reload: bool, answer: Answer) -> bool {
        let Some((handler, _)) = self.handlers.lock().unwrap().clone() else {
            return false;
        };
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.pending.lock().unwrap().insert(id, answer);
        let request = JsDialogRequest { id, kind, origin, message, default_value, is_reload };
        // Called on CEF's UI thread; the application's handler waits for the
        // main thread, so it runs elsewhere (same shape as the context menu).
        std::thread::spawn(move || handler(request));
        true
    }

    /// Answer dialog `id`. Returns whether it was still open.
    pub fn answer(self: &Arc<Self>, id: u64, accept: bool, text: Option<String>) -> bool {
        if !self.pending.lock().unwrap().contains_key(&id) {
            return false;
        }
        if cef::currently_on(ThreadId::UI) != 0 {
            self.complete(id, accept, text);
        } else {
            let mut task = JsDialogTask::new(self.clone(), id, accept, text);
            cef::post_task(ThreadId::UI, Some(&mut task));
        }
        true
    }

    fn complete(&self, id: u64, accept: bool, text: Option<String>) {
        // Continuing the dialog re-enters this bridge at once: CEF calls
        // `on_reset_dialog_state` from inside `cont`. The lock must be gone
        // before the callback runs, or that call waits on this one forever.
        let answer = self.pending.lock().unwrap().remove(&id);
        if let Some(answer) = answer {
            answer(accept, text);
        }
    }

    /// The page moved on: every open dialog is cancelled, and the application hears which.
    fn reset(&self) {
        let (ids, answers): (Vec<u64>, Vec<Answer>) = self.pending.lock().unwrap().drain().unzip();
        for answer in answers {
            answer(false, None);
        }
        if ids.is_empty() {
            return;
        }
        if let Some((_, reset)) = self.handlers.lock().unwrap().clone() {
            std::thread::spawn(move || reset(ids));
        }
    }
}

wrap_task! {
  struct JsDialogTask { bridge: Arc<JsDialogBridge>, id: u64, accept: bool, text: Option<String> }
  impl Task { fn execute(&self) { self.bridge.complete(self.id, self.accept, self.text.clone()); } }
}

fn text(value: Option<&CefString>) -> String {
    value.map(CefString::to_string).unwrap_or_default()
}

wrap_jsdialog_handler! {
  pub struct TauriCefJsDialogHandler { bridge: Arc<JsDialogBridge> }
  impl JsdialogHandler {
    fn on_jsdialog(&self, _browser: Option<&mut Browser>, origin_url: Option<&CefString>, dialog_type: JsdialogType, message_text: Option<&CefString>, default_prompt_text: Option<&CefString>, callback: Option<&mut JsdialogCallback>, _suppress_message: Option<&mut i32>) -> i32 {
      let Some(callback) = callback else { return 0; };
      let kind = if dialog_type == JsdialogType::ALERT { JsDialogKind::Alert } else if dialog_type == JsdialogType::CONFIRM { JsDialogKind::Confirm } else if dialog_type == JsdialogType::PROMPT { JsDialogKind::Prompt } else { return 0; };
      let callback = callback.clone();
      let handled = self.bridge.submit(kind, text(origin_url), text(message_text), text(default_prompt_text), false, Box::new(move |accept, input| {
        let input = input.map(|s| CefString::from(s.as_str()));
        callback.cont(i32::from(accept), input.as_ref());
      }));
      i32::from(handled)
    }
    fn on_before_unload_dialog(&self, _browser: Option<&mut Browser>, message_text: Option<&CefString>, is_reload: i32, callback: Option<&mut JsdialogCallback>) -> i32 {
      let Some(callback) = callback else { return 0; };
      let callback = callback.clone();
      let handled = self.bridge.submit(JsDialogKind::BeforeUnload, String::new(), text(message_text), String::new(), is_reload != 0, Box::new(move |accept, _| {
        callback.cont(i32::from(accept), None);
      }));
      i32::from(handled)
    }
    fn on_reset_dialog_state(&self, _browser: Option<&mut Browser>) {
      self.bridge.reset();
    }
  }
}
