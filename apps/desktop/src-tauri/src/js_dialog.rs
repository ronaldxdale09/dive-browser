//! JavaScript dialogs (`alert`, `confirm`, `prompt` and the `beforeunload`
//! question) shown by Dive's chrome instead of a native modal. A native
//! modal freezes the whole process: every window, the MCP server and the
//! agent. Here the page's script waits, the chrome shows a card over the
//! page, and the person, the agent or an MCP client answers it.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_runtime_cef::{JsDialogKind, JsDialogRequest};
use tauri_specta::Event;

use dive_core::TabId;

use crate::Runtime;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// A dialog a page has open. Answering it resumes the page's script.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct JsDialogAsked {
    pub tab_id: TabId,
    /// Opaque; pass it back to `js_dialog_answer`.
    pub dialog_id: String,
    /// `alert`, `confirm`, `prompt` or `beforeunload`.
    pub kind: String,
    /// The page's origin, empty for `beforeunload`.
    pub origin: String,
    pub message: String,
    /// A prompt's suggested text.
    pub default_value: String,
    /// A `beforeunload` raised by a reload rather than a navigation.
    pub is_reload: bool,
}

/// A dialog went away: answered, or withdrawn by the page moving on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct JsDialogClosed {
    pub tab_id: TabId,
    pub dialog_id: String,
}

/// The dialogs currently open, per tab, in the order they were raised.
#[derive(Default)]
pub struct Registry {
    open: Mutex<HashMap<TabId, Vec<JsDialogAsked>>>,
}

impl Registry {
    /// The oldest open dialog on `tab`, the one the page is waiting on.
    pub fn open(&self, tab: TabId) -> Option<JsDialogAsked> {
        lock(&self.open)
            .get(&tab)
            .and_then(|list| list.first().cloned())
    }

    fn add(&self, dialog: JsDialogAsked) {
        lock(&self.open)
            .entry(dialog.tab_id)
            .or_default()
            .push(dialog);
    }

    fn remove(&self, tab: TabId, id: &str) -> bool {
        let mut open = lock(&self.open);
        let Some(list) = open.get_mut(&tab) else {
            return false;
        };
        let before = list.len();
        list.retain(|d| d.dialog_id != id);
        let removed = list.len() != before;
        if list.is_empty() {
            open.remove(&tab);
        }
        removed
    }

    /// The tab is gone; nothing is waiting any more.
    pub fn forget_tab(&self, tab: TabId) {
        lock(&self.open).remove(&tab);
    }
}

fn kind_name(kind: JsDialogKind) -> &'static str {
    match kind {
        JsDialogKind::Alert => "alert",
        JsDialogKind::Confirm => "confirm",
        JsDialogKind::Prompt => "prompt",
        JsDialogKind::BeforeUnload => "beforeunload",
    }
}

/// Take over the dialogs of a page view. Requests arrive on a CEF thread
/// and are recorded and announced from the main thread.
pub fn attach(app: &AppHandle<Runtime>, tab_id: TabId, view: &tauri::Webview<Runtime>) {
    let asked_app = app.clone();
    let reset_app = app.clone();
    if let Err(error) = view.with_webview(move |native| {
        native.set_js_dialog_handler(
            move |request: JsDialogRequest| {
                let app = asked_app.clone();
                let _ = app.clone().run_on_main_thread(move || {
                    let dialog = JsDialogAsked {
                        tab_id,
                        dialog_id: request.id.to_string(),
                        kind: kind_name(request.kind).to_owned(),
                        origin: request.origin,
                        message: request.message,
                        default_value: request.default_value,
                        is_reload: request.is_reload,
                    };
                    tracing::debug!(%tab_id, kind = dialog.kind, "page opened a dialog");
                    app.state::<AppState>().js_dialogs.add(dialog.clone());
                    let _ = dialog.emit(&app);
                });
            },
            move |ids: Vec<u64>| {
                let app = reset_app.clone();
                let _ = app.clone().run_on_main_thread(move || {
                    let state = app.state::<AppState>();
                    for id in ids {
                        let dialog_id = id.to_string();
                        if state.js_dialogs.remove(tab_id, &dialog_id) {
                            let _ = JsDialogClosed { tab_id, dialog_id }.emit(&app);
                        }
                    }
                });
            },
        );
    }) {
        tracing::warn!(%tab_id, "page dialogs stay native on this tab: {error}");
    }
}

/// Answer dialog `dialog_id` on `tab_id`. `text` is what a prompt receives
/// when accepted; the other kinds ignore it. Main thread only.
pub fn answer(
    app: &AppHandle<Runtime>,
    state: &AppState,
    tab_id: TabId,
    dialog_id: &str,
    accept: bool,
    text: Option<String>,
) -> AppResult<JsDialogAsked> {
    let dialog = lock(&state.js_dialogs.open)
        .get(&tab_id)
        .and_then(|list| list.iter().find(|d| d.dialog_id == dialog_id).cloned())
        .ok_or_else(|| AppError::new("that dialog is no longer open"))?;
    let id: u64 = dialog_id
        .parse()
        .map_err(|_| AppError::new("that dialog is no longer open"))?;
    let text = if accept && dialog.kind == "prompt" {
        Some(text.unwrap_or_else(|| dialog.default_value.clone()))
    } else {
        None
    };
    // `with_webview` runs its closure on the runtime's thread and wants it
    // `'static`, so the outcome comes back through a shared flag.
    let answered = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = answered.clone();
    crate::commands::with_view(state, tab_id, |view| {
        view.with_webview(move |native| {
            flag.store(
                native.answer_js_dialog(id, accept, text),
                std::sync::atomic::Ordering::SeqCst,
            );
        })
    })?;
    let answered = answered.load(std::sync::atomic::Ordering::SeqCst);
    state.js_dialogs.remove(tab_id, dialog_id);
    let _ = JsDialogClosed {
        tab_id,
        dialog_id: dialog_id.to_owned(),
    }
    .emit(app);
    if !answered {
        return Err(AppError::new("that dialog is no longer open"));
    }
    Ok(dialog)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asked(tab: TabId, id: &str) -> JsDialogAsked {
        JsDialogAsked {
            tab_id: tab,
            dialog_id: id.into(),
            kind: "confirm".into(),
            origin: "https://example.com".into(),
            message: "Leave?".into(),
            default_value: String::new(),
            is_reload: false,
        }
    }

    #[test]
    fn the_oldest_dialog_is_the_open_one_and_removal_keeps_order() {
        let registry = Registry::default();
        let tab = TabId::new();
        registry.add(asked(tab, "1"));
        registry.add(asked(tab, "2"));
        assert_eq!(registry.open(tab).map(|d| d.dialog_id), Some("1".into()));
        assert!(registry.remove(tab, "1"));
        assert!(!registry.remove(tab, "1"));
        assert_eq!(registry.open(tab).map(|d| d.dialog_id), Some("2".into()));
        registry.forget_tab(tab);
        assert!(registry.open(tab).is_none());
    }
}
