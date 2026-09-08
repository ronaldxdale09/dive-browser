// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! The page's right-click menu. CEF builds a native menu from a model; the
//! model is rebuilt here with the items a browser is expected to offer, and
//! the ones CEF cannot carry out itself are handed to the application
//! through a per-webview bridge.

use std::sync::{Arc, Mutex};

use cef::*;

/// What the person chose, with the page state the choice was made on.
#[derive(Debug, Clone)]
pub struct ContextMenuCommand {
    pub action: ContextMenuAction,
    pub page_url: String,
    pub link_url: String,
    pub source_url: String,
    pub selection: String,
}

/// Items the application carries out; CEF handles navigation, print, view
/// source and the editing commands on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextMenuAction {
    OpenLinkInNewTab,
    CopyLink,
    OpenImageInNewTab,
    SaveImage,
    CopyImageAddress,
    SearchSelection,
    SavePage,
    QrCode,
    AskAgent,
    DeviceSimulator,
    ViewSource,
    Inspect,
}

impl ContextMenuAction {
    const ALL: [Self; 12] = [
        Self::OpenLinkInNewTab,
        Self::CopyLink,
        Self::OpenImageInNewTab,
        Self::SaveImage,
        Self::CopyImageAddress,
        Self::SearchSelection,
        Self::SavePage,
        Self::QrCode,
        Self::AskAgent,
        Self::DeviceSimulator,
        Self::ViewSource,
        Self::Inspect,
    ];

    fn id(self) -> i32 {
        // MENU_ID_USER_FIRST: ids below it belong to CEF's own commands.
        let first = cef::sys::cef_menu_id_t::MENU_ID_USER_FIRST as i32;
        first + Self::ALL.iter().position(|a| *a == self).unwrap_or(0) as i32
    }

    fn from_id(id: i32) -> Option<Self> {
        let first = cef::sys::cef_menu_id_t::MENU_ID_USER_FIRST as i32;
        usize::try_from(id - first)
            .ok()
            .and_then(|i| Self::ALL.get(i).copied())
    }
}

type Handler = Arc<dyn Fn(ContextMenuCommand) + Send + Sync>;

/// Where the application's handler for a webview's menu choices lives.
#[derive(Default)]
///
/// A choice is held until CEF reports the menu dismissed: the choice
/// callback runs inside the native menu's own event loop, where anything
/// that waits on the application's event loop (opening a tab does) never
/// returns. Dismissal comes once that loop has unwound.
pub struct ContextMenuBridge {
    handler: Mutex<Option<Handler>>,
    pending: Mutex<Option<ContextMenuCommand>>,
}

impl ContextMenuBridge {
    pub fn install(&self, handler: Handler) {
        *self.handler.lock().unwrap() = Some(handler);
    }

    fn installed(&self) -> bool {
        self.handler.lock().unwrap().is_some()
    }

    fn hold(&self, command: ContextMenuCommand) {
        *self.pending.lock().unwrap() = Some(command);
    }

    fn release(&self) {
        let Some(command) = self.pending.lock().unwrap().take() else {
            return;
        };
        let handler = self.handler.lock().unwrap().clone();
        if let Some(handler) = handler {
            // Off this thread and after a beat: the dismissal itself can
            // still arrive on the way out of the menu's loop.
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(60));
                handler(command);
            });
        }
    }
}

fn text(s: CefStringUserfree) -> String {
    CefString::from(&s).to_string()
}

fn item(model: &MenuModel, action: ContextMenuAction, label: &str) {
    model.add_item(action.id(), Some(&CefString::from(label)));
}

fn native(model: &MenuModel, id: MenuId, label: &str, enabled: bool) {
    let id = cef::sys::cef_menu_id_t::from(id) as i32;
    model.add_item(id, Some(&CefString::from(label)));
    model.set_enabled(id, i32::from(enabled));
}

/// Shorten a selection for a menu label.
fn quoted(selection: &str) -> String {
    let flat: String = selection.split_whitespace().collect::<Vec<_>>().join(" ");
    let short: String = flat.chars().take(32).collect();
    if short.len() < flat.len() {
        format!("“{short}…”")
    } else {
        format!("“{short}”")
    }
}

wrap_context_menu_handler! {
  pub struct TauriCefContextMenuHandler {
    devtools_enabled: bool,
    bridge: Arc<ContextMenuBridge>,
  }

  impl ContextMenuHandler {
    fn on_before_context_menu(
      &self,
      browser: Option<&mut Browser>,
      _frame: Option<&mut Frame>,
      params: Option<&mut ContextMenuParams>,
      model: Option<&mut MenuModel>,
    ) {
      let (Some(browser), Some(params), Some(model)) = (browser, params, model) else {
        return;
      };
      // Text fields keep Chromium's own editing menu (undo, cut, paste,
      // spelling); only its trailing Inspect goes when DevTools are off.
      if params.is_editable() != 0 {
        if !self.devtools_enabled && model.count() > 0 {
          model.remove_at(model.count() - 1);
        }
        return;
      }
      let flags = params.type_flags();
      let link = text(params.link_url());
      let image = params.media_type() == ContextMenuMediaType::IMAGE;
      let selection = text(params.selection_text());
      model.clear();
      if !link.is_empty() {
        item(model, ContextMenuAction::OpenLinkInNewTab, "Open Link in New Tab");
        item(model, ContextMenuAction::CopyLink, "Copy Link Address");
        model.add_separator();
      }
      if image {
        item(model, ContextMenuAction::OpenImageInNewTab, "Open Image in New Tab");
        item(model, ContextMenuAction::SaveImage, "Save Image As…");
        item(model, ContextMenuAction::CopyImageAddress, "Copy Image Address");
        model.add_separator();
      }
      if !selection.trim().is_empty() {
        native(model, MenuId::COPY, "Copy", true);
        item(model, ContextMenuAction::SearchSelection, &format!("Search the Web for {}", quoted(&selection)));
        model.add_separator();
      }
      let _ = flags;
      native(model, MenuId::BACK, "Back", browser.can_go_back() != 0);
      native(model, MenuId::FORWARD, "Forward", browser.can_go_forward() != 0);
      native(model, MenuId::RELOAD, "Reload", true);
      model.add_separator();
      item(model, ContextMenuAction::SavePage, "Save As…");
      native(model, MenuId::PRINT, "Print…", true);
      model.add_separator();
      item(model, ContextMenuAction::QrCode, "Create QR Code for This Page");
      model.add_separator();
      item(model, ContextMenuAction::AskAgent, "Ask the Agent About This Page");
      item(model, ContextMenuAction::DeviceSimulator, "Device Simulator");
      model.add_separator();
      // CEF's own View Source opens a popup window, which the application
      // routes elsewhere; the application opens the source in a tab instead.
      item(model, ContextMenuAction::ViewSource, "View Page Source");
      if self.devtools_enabled {
        item(model, ContextMenuAction::Inspect, "Inspect");
      }
    }

    fn on_context_menu_command(
      &self,
      _browser: Option<&mut Browser>,
      _frame: Option<&mut Frame>,
      params: Option<&mut ContextMenuParams>,
      command_id: ::std::os::raw::c_int,
      _event_flags: EventFlags,
    ) -> ::std::os::raw::c_int {
      let Some(action) = ContextMenuAction::from_id(command_id) else {
        return 0;
      };
      let Some(params) = params else {
        return 0;
      };
      if !self.bridge.installed() {
        return 0;
      }
      self.bridge.hold(ContextMenuCommand {
        action,
        page_url: text(params.page_url()),
        link_url: text(params.link_url()),
        source_url: text(params.source_url()),
        selection: text(params.selection_text()),
      });
      1
    }

    fn on_context_menu_dismissed(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>) {
      self.bridge.release();
    }
  }
}
