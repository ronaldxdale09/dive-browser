// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::{
    Mutex,
    atomic::{AtomicI32, Ordering},
    mpsc::{self, Receiver, Sender},
};

use cef::*;
use sha2::{Digest, Sha256};
use tauri_runtime::{
    Cookie, Error, Result, Runtime, UserEvent, WebviewDispatch, WebviewEventId,
    dpi::{PhysicalPosition, PhysicalSize, Position, Rect, Size},
    webview::{
        DetachedWebview, InitializationScript, PendingWebview, UriSchemeProtocolHandler,
        WebviewAttributes,
    },
    window::{WebviewEvent, WindowId},
};
use tauri_utils::{Theme, config::Color, html::normalize_script_for_csp};
use url::Url;

use crate::cef_impl::{client as browser_client, cookie, request_context, request_handler};
use crate::pending_creation::{
    Completion, CompletionToken, Creation, PendingQueue, SharedContexts,
};
use crate::runtime::{CefRuntime, Message, NativeDeadline, RuntimeContext, WinitCefApp};
use crate::window::AppWindow;

pub use crate::reserved_shortcut_native::NativeNewTabTarget;
pub use browser_client::permission::{NativePermissionRequest, PermissionContext};
pub use browser_client::{
    ContextMenuAction, ContextMenuCommand, ContextMenuOptions, JsDialogKind, JsDialogRequest,
};

// Weak ownership: the context is released with the last live webview, before
// CEF shutdown. A data directory is only a grouping key for incognito views;
// it is never passed to CEF as their cache path.
static INCOGNITO_CONTEXTS: std::sync::LazyLock<
    Mutex<SharedContexts<std::path::PathBuf, RequestContext>>,
> = std::sync::LazyLock::new(Default::default);

/// A handle to the native CEF browser backing a Tauri webview.
///
/// This is the runtime-specific webview object exposed through
/// [`tauri_runtime::WebviewDispatch::with_webview`].
#[derive(Clone)]
pub struct Webview {
    browser: cef::Browser,
    permissions: Arc<browser_client::permission::PermissionBridge>,
    context_menu: Arc<browser_client::ContextMenuBridge>,
    js_dialog: Arc<browser_client::JsDialogBridge>,
    shortcut_target: std::sync::Weak<crate::reserved_shortcut_native::NewTabTarget>,
    shortcut_binding: Arc<crate::reserved_shortcut_native::NativeShortcutBinding>,
}

impl Webview {
    pub(crate) fn new(
        browser: cef::Browser,
        permissions: Arc<browser_client::permission::PermissionBridge>,
        context_menu: Arc<browser_client::ContextMenuBridge>,
        js_dialog: Arc<browser_client::JsDialogBridge>,
        shortcut_target: std::sync::Weak<crate::reserved_shortcut_native::NewTabTarget>,
        shortcut_binding: Arc<crate::reserved_shortcut_native::NativeShortcutBinding>,
    ) -> Self {
        Self {
            browser,
            permissions,
            context_menu,
            js_dialog,
            shortcut_target,
            shortcut_binding,
        }
    }

    /// Receive the page context menu choices CEF cannot carry out itself
    /// (open in new tab, copy link, save, and the application's own items).
    /// Called on a CEF thread; hop to the main thread before touching windows.
    /// Which of the application's own menu items apply on this view.
    pub fn set_context_menu_options(&self, options: ContextMenuOptions) {
        self.context_menu.set_options(options);
    }

    pub fn set_context_menu_handler(
        &self,
        handler: impl Fn(browser_client::ContextMenuCommand) + Send + Sync + 'static,
    ) {
        self.context_menu.install(Arc::new(handler));
    }

    /// Take over the page's JavaScript dialogs: `handler` receives each one,
    /// `reset` hears which pending ones the page withdrew. Without a handler
    /// CEF shows a native modal that blocks the whole process.
    pub fn set_js_dialog_handler(
        &self,
        handler: impl Fn(browser_client::JsDialogRequest) + Send + Sync + 'static,
        reset: impl Fn(Vec<u64>) + Send + Sync + 'static,
    ) {
        self.js_dialog.install(Arc::new(handler), Arc::new(reset));
    }

    /// Answer a dialog from `set_js_dialog_handler`; false when it is gone.
    pub fn answer_js_dialog(&self, id: u64, accept: bool, text: Option<String>) -> bool {
        self.js_dialog.answer(id, accept, text)
    }

    /// A weak target handle: valid only while this exact native view remains alive.
    /// The embedding app must select its trusted chrome, not a page document.
    pub fn new_tab_shortcut_target(&self) -> NativeNewTabTarget {
        NativeNewTabTarget(self.shortcut_target.clone())
    }

    /// Configure the macOS reserved Cmd+T target on the native UI thread.
    /// Pass None to clear routing; the default target must share the source window.
    pub fn set_new_tab_shortcut_target(&self, target: Option<NativeNewTabTarget>) {
        self.shortcut_binding
            .new_tab
            .bind(target.map(|target| target.0));
    }

    /// Explicit detached-window route. This source must currently share the
    /// anchor's window, distinct from the selected target chrome window.
    /// Reparenting any participant invalidates the route; no native window is retained.
    #[cfg(target_os = "macos")]
    pub fn set_detached_new_tab_shortcut_target(
        &self,
        source_anchor: NativeNewTabTarget,
        target: NativeNewTabTarget,
    ) -> bool {
        crate::reserved_shortcut_native::bind_cross_window(
            &self.shortcut_binding,
            self.shortcut_target.clone(),
            source_anchor,
            target,
        )
    }

    /// Reserve Cmd+L for the explicitly selected chrome in this native window.
    /// Self-targeting is allowed for chrome; page targets must be sibling views.
    /// Captured owner epochs invalidate both routes after reparenting.
    #[cfg(target_os = "macos")]
    pub fn set_address_shortcut_target(&self, target: NativeNewTabTarget) -> bool {
        crate::reserved_shortcut_native::bind_address(
            &self.shortcut_binding,
            self.shortcut_target.clone(),
            target,
        )
    }

    /// Install policy on this native view. Requests default to denial before installation.
    pub fn set_permission_handler(
        &self,
        handler: impl Fn(NativePermissionRequest) + Send + Sync + 'static,
        cancelled: impl Fn(u64) + Send + Sync + 'static,
        navigating: impl Fn(Option<String>, bool) + Send + Sync + 'static,
    ) {
        self.permissions
            .install(Arc::new(handler), Arc::new(cancelled), Arc::new(navigating));
    }

    /// A weak cache handle remains usable after a view closes while its context survives.
    pub fn permission_context(&self) -> Option<PermissionContext> {
        self.permissions.permission_context()
    }
    /// Re-run production startup reconciliation for a seeded disposable context.
    /// Requires CEF UI and DIVE_PERMISSION_CACHE_PROBE=1; never grants permission.
    /// This diagnostic API is not exposed as a renderer IPC command.
    pub fn reconcile_permission_cache_for_diagnostics(&self) -> std::result::Result<(), String> {
        self.permissions
            .reconcile_permission_cache_for_diagnostics()
    }
    /// Clear the native cached decision in this view's actual shared context.
    /// Must run on CEF UI; success includes read-back verification.
    pub fn reset_permission_cache(
        &self,
        origin: &str,
        kind: &str,
    ) -> std::result::Result<(), String> {
        self.permissions.reset_permission_cache(origin, kind)
    }

    /// Returns the [`cef::Browser`] backing this webview.
    ///
    /// From the browser you can reach the rest of the CEF API, such as the
    /// browser host, the main frame or the native window handle.
    pub fn browser(&self) -> cef::Browser {
        self.browser.clone()
    }
}

pub fn webview_version() -> tauri_runtime::Result<String> {
    Ok(format!(
        "{}.{}.{}.{}",
        cef::sys::CHROME_VERSION_MAJOR,
        cef::sys::CHROME_VERSION_MINOR,
        cef::sys::CHROME_VERSION_PATCH,
        cef::sys::CHROME_VERSION_BUILD
    ))
}

#[inline]
fn color_to_argb(color: Color) -> u32 {
    let (r, g, b, a) = color.into();
    ((a as u32) << 24) | ((r as u32) << 16) | ((g as u32) << 8) | (b as u32)
}

/// Maps the subset of [`WebviewAttributes`] that CEF's `BrowserSettings`
/// supports.
///
/// The following Tauri webview attributes have no per-webview equivalent in CEF
/// and are intentionally ignored here:
/// - `user_agent`: CEF only exposes a process-global user agent via
///   `CefSettings.user_agent`, which is fixed before any webview is created.
/// - `additional_browser_args`, `scroll_bar_style`, `general_autofill_enabled`:
///   WebView2 (Windows)-only concepts.
/// - `allow_link_preview`, `accept_first_mouse`: WKWebView (macOS/iOS)-only.
/// - `browser_extensions_enabled`, `extensions_path`: CEF dropped extension
///   support in the Chrome runtime.
/// - `data_store_identifier`: a WKWebView data-store concept with no CEF analog
///   (per-webview isolation is done through the request context cache path).
/// - `zoom_hotkeys_enabled`: handled by Chromium's accelerator table, not a
///   browser setting.
///
/// `proxy_url` is handled separately via the request context preference.
fn browser_settings_from_webview_attributes(
    webview_attributes: &WebviewAttributes,
) -> cef::BrowserSettings {
    cef::BrowserSettings {
        javascript: cef::State::from(if webview_attributes.javascript_disabled {
            cef::sys::cef_state_t::STATE_DISABLED
        } else {
            cef::sys::cef_state_t::STATE_ENABLED
        }),
        javascript_access_clipboard: cef::State::from(if webview_attributes.clipboard {
            cef::sys::cef_state_t::STATE_ENABLED
        } else {
            cef::sys::cef_state_t::STATE_DISABLED
        }),
        background_color: webview_attributes
            .background_color
            .map(color_to_argb)
            .unwrap_or(0),
        ..Default::default()
    }
}

#[derive(Debug, Clone)]
pub enum DevToolsProtocol {
    /// Native creation failed; no page navigation was issued.
    CreationFailed(String),
    Message(Vec<u8>),
    Event {
        method: String,
        params: Vec<u8>,
    },
    MethodResult {
        message_id: i32,
        success: bool,
        result: Vec<u8>,
    },
}

pub(crate) type DevToolsProtocolHandler = dyn Fn(DevToolsProtocol) + Send + Sync;
pub(crate) type WebviewEventHandler = Box<dyn Fn(&WebviewEvent) + Send>;
pub(crate) type WebviewEventListeners = Arc<Mutex<HashMap<WebviewEventId, WebviewEventHandler>>>;

pub(crate) enum WebviewMessage {
    AddEventListener(WebviewEventId, Box<dyn Fn(&WebviewEvent) + Send>),
    EvaluateScript(String),
    EvaluateScriptWithCallback(String, Box<dyn Fn(String) + Send + 'static>),
    Navigate(Url),
    Reload,
    GoBack,
    CanGoBack(Sender<Result<bool>>),
    GoForward,
    CanGoForward(Sender<Result<bool>>),
    Print,
    Close,
    Show,
    Hide,
    SetPosition(Position),
    SetSize(Size),
    SetBounds(Rect),
    SetFocus,
    Reparent(WindowId, Sender<Result<()>>),
    SetAutoResize(bool),
    SetZoom(f64),
    SetBackgroundColor(Option<Color>),
    ClearAllBrowsingData,
    Url(Sender<Result<String>>),
    Bounds(Sender<Result<Rect>>),
    Position(Sender<Result<PhysicalPosition<i32>>>),
    Size(Sender<Result<PhysicalSize<u32>>>),
    WithWebview(Box<dyn FnOnce(Webview) + Send>),
    CookiesForUrl(Url, Sender<Result<Vec<Cookie<'static>>>>),
    Cookies(Sender<Result<Vec<Cookie<'static>>>>),
    SetCookie(Cookie<'static>),
    DeleteCookie(Cookie<'static>),
    #[cfg(any(debug_assertions, feature = "devtools"))]
    OpenDevTools,
    #[cfg(any(debug_assertions, feature = "devtools"))]
    CloseDevTools,
    #[cfg(any(debug_assertions, feature = "devtools"))]
    IsDevToolsOpen(Sender<bool>),
    SendDevToolsMessage(Vec<u8>, Sender<Result<()>>),
    OnDevToolsProtocol(Arc<DevToolsProtocolHandler>, Sender<Result<()>>),
}

impl WebviewMessage {
    /// Page work belongs to the exact browser even if it moved after enqueue.
    /// Native-window work retains its original owner so an old layout/focus
    /// update cannot change the new window. Keep this exhaustive for new APIs.
    fn follows_browser(&self) -> bool {
        match self {
            Self::AddEventListener(..)
            | Self::EvaluateScript(..)
            | Self::EvaluateScriptWithCallback(..)
            | Self::Navigate(..)
            | Self::Reload
            | Self::GoBack
            | Self::CanGoBack(..)
            | Self::GoForward
            | Self::CanGoForward(..)
            | Self::Print
            | Self::Close
            | Self::SetZoom(..)
            | Self::ClearAllBrowsingData
            | Self::Url(..)
            | Self::CookiesForUrl(..)
            | Self::Cookies(..)
            | Self::SetCookie(..)
            | Self::DeleteCookie(..)
            | Self::SendDevToolsMessage(..)
            | Self::OnDevToolsProtocol(..) => true,
            #[cfg(any(debug_assertions, feature = "devtools"))]
            Self::OpenDevTools | Self::CloseDevTools | Self::IsDevToolsOpen(..) => true,
            Self::Show
            | Self::Hide
            | Self::SetPosition(..)
            | Self::SetSize(..)
            | Self::SetBounds(..)
            | Self::SetFocus
            | Self::Reparent(..)
            | Self::SetAutoResize(..)
            | Self::SetBackgroundColor(..)
            | Self::Bounds(..)
            | Self::Position(..)
            | Self::Size(..)
            | Self::WithWebview(..) => false,
        }
    }
}

/// A webview's bounds expressed as a fraction of its parent window, used to
/// reposition/resize auto-resize webviews when the parent window changes size.
#[derive(Clone, Copy)]
pub(crate) struct BoundsRate {
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) width: f32,
    pub(crate) height: f32,
}

impl Default for BoundsRate {
    fn default() -> Self {
        Self {
            x: 0.,
            y: 0.,
            width: 1.,
            height: 1.,
        }
    }
}

pub(crate) struct AppWebview {
    pub(crate) creation: Creation<WindowId>,
    pub(crate) initialization_ready: bool,
    initial_operations: PendingQueue<WebviewMessage>,
    pub(crate) shortcut_target: Arc<crate::reserved_shortcut_native::NewTabTarget>,
    pub(crate) shortcut_binding: Arc<crate::reserved_shortcut_native::NativeShortcutBinding>,
    pub(crate) permissions: Arc<browser_client::permission::PermissionBridge>,
    pub(crate) context_menu: Arc<browser_client::ContextMenuBridge>,
    pub(crate) js_dialog: Arc<browser_client::JsDialogBridge>,
    pub(crate) webview_id: u32,
    pub(crate) label: String,
    pub(crate) browser: cef::Browser,
    pub(crate) browser_id: i32,
    _incognito_context: Option<Arc<RequestContext>>,
    pub(crate) host: cef::BrowserHost,
    #[cfg(target_os = "macos")]
    accessibility_enabled: Arc<Mutex<Option<bool>>>,
    pub(crate) uri_scheme_protocols: Arc<HashMap<String, Arc<Box<UriSchemeProtocolHandler>>>>,
    pub(crate) devtools_protocol_handlers: Arc<Mutex<Vec<Arc<DevToolsProtocolHandler>>>>,
    /// Keeps the DevTools message observer registered. Dropping this unregisters the observer.
    pub(crate) devtools_observer_registration: Arc<Mutex<Option<cef::Registration>>>,
    pub(crate) listeners: WebviewEventListeners,
    pub(crate) bounds_rate: Option<BoundsRate>,
    /// Set once a close was handed to CEF. CEF runs `do_close` for every
    /// `close_browser` call, and a second host-view removal while the first
    /// close is still in flight leaves the browser without its `on_before_close`
    /// acknowledgement, so the window it lives in is retained forever.
    closing: std::sync::atomic::AtomicBool,
    /// Set once `do_close` removed the browser's host view.
    host_destroyed: std::sync::atomic::AtomicBool,
}

impl AppWebview {
    /// Ask CEF to close this browser at most once. Returns whether the request
    /// was issued now; a repeat (graceful, then forced, or the window closing
    /// after its tab) is a no-op because the first close is already draining.
    pub(crate) fn request_close(&self, force: bool) -> bool {
        use std::sync::atomic::Ordering;
        if self.closing.swap(true, Ordering::AcqRel) {
            return false;
        }
        log::debug!(target: "dive_native_close", "stage=request webview={} browser={} force={force}", self.webview_id, self.browser_id);
        self.host.close_browser(i32::from(force));
        true
    }

    /// Remove the browser's host view exactly once; `do_close` may repeat.
    pub(crate) fn destroy_host_window_once(&self) -> bool {
        use std::sync::atomic::Ordering;
        if self.host_destroyed.swap(true, Ordering::AcqRel) {
            return false;
        }
        self.destroy_host_window();
        true
    }

    pub(crate) fn set_bounds(&mut self, parent_size: PhysicalSize<u32>, scale: f64, bounds: Rect) {
        let position = bounds.position.to_physical::<i32>(scale);
        let size = bounds.size.to_physical::<u32>(scale);

        let x = position.x;
        let y = position.y;
        let w = size.width as i32;
        let h = size.height as i32;

        if self.bounds_rate.is_some() {
            let win_w = parent_size.width.max(1) as f32;
            let win_h = parent_size.height.max(1) as f32;
            self.bounds_rate = Some(BoundsRate {
                x: x as f32 / win_w,
                y: y as f32 / win_h,
                width: w as f32 / win_w,
                height: h as f32 / win_h,
            });
        }

        self.host.notify_move_or_resize_started();
        self.apply_physical_bounds(scale, x, y, w, h);
        self.host.was_resized();
    }

    pub(crate) fn set_visible(&self, visible: bool) {
        self.host.was_hidden(if visible { 0 } else { 1 });
        self.apply_visible(visible);
        // Chromium's OnWebContentsRevealed recomputes mode from its scoped
        // accessibility clients, overwriting CEF's direct SetAccessibilityMode.
        // Restore the embedder's request after reveal, without disabling hidden
        // pages or resetting an already enabled tree.
        #[cfg(target_os = "macos")]
        if visible {
            self.apply_requested_accessibility();
        }
    }

    #[cfg(target_os = "macos")]
    fn apply_requested_accessibility(&self) {
        // Release the mutex before calling CEF, which can invoke callbacks.
        let enabled = *self.accessibility_enabled.lock().unwrap();
        if let Some(enabled) = enabled {
            log::debug!(target: "dive_native_accessibility", "restore webview={} enabled={enabled}", self.webview_id);
            self.host.set_accessibility_state(if enabled {
                cef::State::ENABLED
            } else {
                cef::State::DISABLED
            });
        }
    }

    pub fn url(&self) -> Option<String> {
        self.browser
            .main_frame()
            .map(|frame| cef::CefString::from(&frame.url()).to_string())
    }
}

fn register_pending_protocol(
    handlers: &Arc<Mutex<Vec<Arc<DevToolsProtocolHandler>>>>,
    handler: Arc<DevToolsProtocolHandler>,
    tx: Sender<Result<()>>,
) {
    let mut handlers = handlers.lock().unwrap();
    if handlers.len() >= 1024 {
        let _ = tx.send(Err(Error::CreateWebview(
            "CEF pending handler budget exceeded".into(),
        )));
    } else {
        handlers.push(handler);
        let _ = tx.send(Ok(()));
    }
}

fn reject_pending_message(message: WebviewMessage, reason: &str) {
    let error = || Error::CreateWebview(reason.to_owned().into());
    match message {
        WebviewMessage::CanGoBack(tx) | WebviewMessage::CanGoForward(tx) => {
            let _ = tx.send(Err(error()));
        }
        WebviewMessage::Url(tx) => {
            let _ = tx.send(Err(error()));
        }
        WebviewMessage::Bounds(tx) => {
            let _ = tx.send(Err(error()));
        }
        WebviewMessage::Position(tx) => {
            let _ = tx.send(Err(error()));
        }
        WebviewMessage::Size(tx) => {
            let _ = tx.send(Err(error()));
        }
        WebviewMessage::Cookies(tx) | WebviewMessage::CookiesForUrl(_, tx) => {
            let _ = tx.send(Err(error()));
        }
        WebviewMessage::Reparent(_, tx)
        | WebviewMessage::OnDevToolsProtocol(_, tx)
        | WebviewMessage::SendDevToolsMessage(_, tx) => {
            let _ = tx.send(Err(error()));
        }
        #[cfg(any(debug_assertions, feature = "devtools"))]
        WebviewMessage::IsDevToolsOpen(tx) => {
            let _ = tx.send(false);
        }
        _ => {}
    }
}

type SubmitBrowser = Box<dyn FnOnce(&AppWindow, &RequestContext) -> bool>;
type AdoptBrowser = Box<
    dyn FnOnce(cef::Browser, Creation<WindowId>, Option<Arc<RequestContext>>) -> Option<AppWebview>,
>;

pub(crate) struct PendingBrowser {
    pub(crate) creation: Creation<WindowId>,
    context: Option<Arc<RequestContext>>,
    submit: Option<SubmitBrowser>,
    adopt: Option<AdoptBrowser>,
    queue: PendingQueue<WebviewMessage>,
    handlers: Arc<Mutex<Vec<Arc<DevToolsProtocolHandler>>>>,
    listeners: WebviewEventListeners,
    bounds: Rect,
    bounds_rate: Option<BoundsRate>,
    initial_window: bool,
    visible: bool,
    initial_load: Option<Box<dyn FnOnce(&cef::Browser)>>,
    unadopted: Option<Browser>,
}

impl PendingBrowser {
    fn current_bounds(&self, parent: PhysicalSize<u32>) -> Rect {
        if let Some(rate) = self.bounds_rate {
            Rect {
                position: PhysicalPosition::new(
                    (rate.x * parent.width as f32).round() as i32,
                    (rate.y * parent.height as f32).round() as i32,
                )
                .into(),
                size: PhysicalSize::new(
                    (rate.width * parent.width as f32).round() as u32,
                    (rate.height * parent.height as f32).round() as u32,
                )
                .into(),
            }
        } else {
            self.bounds
        }
    }
}

impl<T: UserEvent> WinitCefApp<T> {
    pub(crate) fn create_webview(
        &mut self,
        window_id: WindowId,
        webview_id: u32,
        pending: PendingWebview<T, CefRuntime<T>>,
    ) -> Result<()> {
        self.admit_webview(
            window_id,
            webview_id,
            browser_client::DragDropEventTarget::Webview,
            pending,
        )
    }

    pub(crate) fn admit_webview(
        &mut self,
        window_id: WindowId,
        webview_id: u32,
        target: browser_client::DragDropEventTarget,
        pending: PendingWebview<T, CefRuntime<T>>,
    ) -> Result<()> {
        let window = self
            .state
            .windows
            .get(&window_id)
            .ok_or(Error::WindowNotFound)?;
        if self.state.exiting || self.state.is_window_closing(window_id) {
            return Err(Error::WindowNotFound);
        }
        let theme = window.resolved_theme(*self.context.app_wide_theme.lock().unwrap());
        let prepared = Self::prepare_browser_child(
            &self.context,
            &self.scheme_registry,
            window_id,
            webview_id,
            window.raw_cef_handle(),
            window.window.surface_size(),
            window.window.scale_factor(),
            theme,
            target,
            pending,
        )
        .ok_or_else(|| Error::CreateWebview("CEF request context rejected".into()))?;
        if !self.state.native_deadlines.schedule(
            NativeDeadline::Creation(webview_id),
            std::time::Instant::now() + request_context::CREATION_DEADLINE,
        ) {
            return Err(Error::CreateWebview(
                "CEF pending creation capacity reached".into(),
            ));
        }
        self.state
            .window_orders
            .entry(window_id)
            .or_default()
            .push(webview_id);
        self.state.pending_browsers.insert(webview_id, prepared);
        Ok(())
    }

    fn prepare_browser_child(
        context: &RuntimeContext<T>,
        scheme_registry: &request_handler::SchemeRegistry,
        window_id: WindowId,
        webview_id: u32,
        parent: cef::sys::cef_window_handle_t,
        parent_size: PhysicalSize<u32>,
        scale: f64,
        theme: Option<Theme>,
        drag_drop_event_target: browser_client::DragDropEventTarget,
        mut pending: PendingWebview<T, CefRuntime<T>>,
    ) -> Option<PendingBrowser> {
        let bounds_rate = compute_child_bounds_rate(
            pending.webview_attributes.bounds.as_ref(),
            pending.webview_attributes.auto_resize,
            parent_size,
            scale,
        );
        let initialization_scripts = initialization_scripts(&mut pending.webview_attributes);
        let uri_scheme_protocols: Arc<HashMap<_, _>> = Arc::new(
            pending
                .uri_scheme_protocols
                .into_iter()
                .map(|(scheme, handler)| (scheme, Arc::new(handler)))
                .collect(),
        );
        let on_page_load_handler = pending.on_page_load_handler.take().map(Arc::from);
        let document_title_changed_handler =
            pending.document_title_changed_handler.take().map(Arc::from);
        let address_changed_handler = pending.address_changed_handler.take().map(Arc::from);
        let devtools_enabled = (cfg!(debug_assertions) || cfg!(feature = "devtools"))
            && pending.webview_attributes.devtools.unwrap_or(true);
        let drag_drop_handler_enabled = pending.webview_attributes.drag_drop_handler_enabled;
        let drag_drop_state = Arc::new(Mutex::new(browser_client::DragDropState::default()));
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        let web_content_process_terminate_handler = pending
            .on_web_content_process_terminate_handler
            .take()
            .map(|handler| Arc::from(handler) as Arc<dyn Fn() + Send>);
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        let web_content_process_terminate_handler: Option<Arc<dyn Fn() + Send>> = None;
        let permissions = Arc::new(browser_client::permission::PermissionBridge::default());
        let context_menu = Arc::new(browser_client::ContextMenuBridge::default());
        let js_dialog = Arc::new(browser_client::JsDialogBridge::default());
        let shortcut_binding =
            Arc::new(crate::reserved_shortcut_native::NativeShortcutBinding::default());
        let handlers = browser_client::TauriCefBrowserClientHandlers {
            permissions: permissions.clone(),
            context_menu: context_menu.clone(),
            js_dialog: js_dialog.clone(),
            shortcut_binding: shortcut_binding.clone(),
            ipc_handler: pending.ipc_handler.map(Arc::from),
            on_page_load_handler,
            document_title_changed_handler,
            navigation_handler: pending.navigation_handler.map(Arc::from),
            address_changed_handler,
            new_window_handler: pending.new_window_handler.map(Arc::from),
            download_handler: pending.download_handler.take(),
            web_content_process_terminate_handler,
        };

        let mut client = browser_client::TauriCefBrowserClient::new(
            context.clone(),
            window_id,
            webview_id,
            pending.label.clone(),
            Arc::new(CompletionToken::default()),
            devtools_enabled,
            drag_drop_event_target,
            drag_drop_handler_enabled,
            drag_drop_state,
            handlers,
            context.proxy.clone(),
            context.sender.clone(),
        );

        // If the bounds are not specified, default to the parent window's size and position.
        // aka full-window webview.
        let desired_bounds = pending.webview_attributes.bounds.unwrap_or_else(|| Rect {
            position: PhysicalPosition::new(0, 0).into(),
            size: parent_size.into(),
        });
        let bounds = desired_bounds;
        #[cfg(not(target_os = "macos"))]
        let bounds = bounds.to_physical::<i32, i32>(scale);
        #[cfg(target_os = "macos")]
        let bounds = bounds.to_logical::<i32, i32>(scale);
        let bounds = cef::Rect {
            x: bounds.position.x,
            y: bounds.position.y,
            width: bounds.size.width,
            height: bounds.size.height,
        };

        // Let CEF pick the runtime style unless overridden per-webview.
        let cef_runtime_style = pending
            .platform_specific_attributes
            .iter()
            .map(|attr| match attr {
                WebviewAtribute::RuntimeStyle { style } => match style {
                    RuntimeStyle::Alloy => cef::RuntimeStyle::ALLOY,
                    RuntimeStyle::Chrome => cef::RuntimeStyle::CHROME,
                },
            })
            .next()
            // Windows has no working default here. CEF's default resolves to
            // the Chrome style, which owns its own window and cannot be
            // parented into a child HWND -- asking it to be one crashes
            // inside CreateBrowserSync rather than failing. Alloy is the
            // client-owned style, which is what a chrome drawn by the app
            // needs, and what macOS already gets.
            .unwrap_or(if cfg!(windows) {
                cef::RuntimeStyle::ALLOY
            } else {
                cef::RuntimeStyle::DEFAULT
            });

        log::info!(
            "cef webview {:?}: bounds {}x{} at ({}, {}), scale {scale}, style {cef_runtime_style:?}",
            pending.label,
            bounds.width,
            bounds.height,
            bounds.x,
            bounds.y,
        );
        let mut window_info = cef::WindowInfo::default().set_as_child(parent, &bounds);
        log::info!("cef webview {:?}: window info ready", pending.label);
        window_info.runtime_style = cef_runtime_style;
        #[cfg(target_os = "macos")]
        {
            window_info.hidden = 1;
        }
        #[cfg(windows)]
        {
            window_info.style &= !0x10000000;
        } // WS_VISIBLE: reveal after adoption.

        let settings = browser_settings_from_webview_attributes(&pending.webview_attributes);

        let custom_protocol_scheme = if pending.webview_attributes.use_https_scheme {
            "https"
        } else {
            "http"
        }
        .to_string();
        let custom_scheme_domain_names: Vec<String> = uri_scheme_protocols
            .keys()
            .map(|scheme| format!("{scheme}.localhost"))
            .collect();
        let real_initial_url = pending.url.as_str().to_string();
        let handlers = Arc::new(Mutex::new(Vec::new()));
        let listeners: WebviewEventListeners = Default::default();
        let submit: SubmitBrowser = Box::new({
            let permissions = permissions.clone();
            move |window, request_context| {
                if let Err(error) = permissions.initialize_context(request_context) {
                    log::error!("CEF permission context initialization failed: {error}");
                    return false;
                }
                request_context::apply_theme_scheme(
                    Some(request_context),
                    window.resolved_theme(theme),
                );
                let mut request_context = request_context.clone();
                cef::browser_host_create_browser(
                    Some(&window_info),
                    Some(&mut client),
                    Some(&CefString::from(INITIAL_LOAD_URL)),
                    Some(&settings),
                    None,
                    Some(&mut request_context),
                ) == 1
            }
        });
        let pending_initial_loads: PendingInitialLoads = Arc::new(Mutex::new(HashMap::new()));
        let initial_load: Box<dyn FnOnce(&cef::Browser)> = Box::new({
            let pending_initial_loads = pending_initial_loads.clone();
            let sender = context.sender.clone();
            let proxy = context.proxy.clone();
            let initialization_scripts = initialization_scripts.clone();
            let custom_protocol_scheme = custom_protocol_scheme.clone();
            move |browser| {
                // The observer and every queued native setup operation are installed first.
                load_initial_url_after_registering_initialization_scripts(
                    browser,
                    &initialization_scripts,
                    &custom_protocol_scheme,
                    &custom_scheme_domain_names,
                    Box::new(move |success| {
                        let _ = sender.send(Message::InitialScriptsReady(
                            webview_id,
                            success,
                            real_initial_url,
                        ));
                        proxy.wake_up();
                    }),
                    &pending_initial_loads,
                );
            }
        });
        let adopt: AdoptBrowser = Box::new({
            let scheme_registry = scheme_registry.clone();
            let uri_scheme_protocols = uri_scheme_protocols.clone();
            let label = pending.label.clone();
            let devtools_protocol_handlers = handlers.clone();
            let listeners = listeners.clone();
            let pending_initial_loads = pending_initial_loads.clone();
            #[cfg(target_os = "macos")]
            let accessibility_enabled = context.accessibility_enabled.clone();
            move |browser, creation, incognito_context| {
                let host = browser.host()?;
                let browser_id = browser.identifier();
                {
                    let mut registry = scheme_registry.lock().unwrap();
                    for (scheme, handler) in uri_scheme_protocols.iter() {
                        registry.insert(
                            (browser_id, scheme.clone()),
                            (
                                label.clone(),
                                handler.clone(),
                                initialization_scripts.clone(),
                            ),
                        );
                    }
                }
                let devtools_observer_registration = Arc::new(Mutex::new(add_dev_tools_observer(
                    &browser,
                    devtools_protocol_handlers.clone(),
                    pending_initial_loads,
                )));
                Some(AppWebview {
                    creation,
                    initialization_ready: false,
                    initial_operations: PendingQueue::new(1024, 8 * 1024 * 1024),
                    shortcut_target: Arc::new(crate::reserved_shortcut_native::NewTabTarget::new(
                        browser.clone(),
                        webview_id,
                    )),
                    shortcut_binding,
                    permissions,
                    context_menu,
                    js_dialog,
                    webview_id,
                    label,
                    browser,
                    browser_id,
                    _incognito_context: incognito_context,
                    host,
                    #[cfg(target_os = "macos")]
                    accessibility_enabled,
                    uri_scheme_protocols,
                    devtools_protocol_handlers,
                    devtools_observer_registration,
                    listeners,
                    bounds_rate,
                    closing: std::sync::atomic::AtomicBool::new(false),
                    host_destroyed: std::sync::atomic::AtomicBool::new(false),
                })
            }
        });
        let incognito_key = pending
            .webview_attributes
            .incognito
            .then(|| pending.webview_attributes.data_directory.clone())
            .flatten();
        let shared = incognito_key.as_ref().and_then(|key| {
            INCOGNITO_CONTEXTS
                .lock()
                .unwrap()
                .get(key)
                .map(|context| (*context).clone())
        });
        let sender = context.sender.clone();
        let proxy = context.proxy.clone();
        let on_initialized = Box::new(move |request_context| {
            let _ = sender.send(Message::RequestContextReady(webview_id, request_context));
            proxy.wake_up();
        });
        let request_context = Arc::new(request_context::request_context_from_webview_attributes(
            &context.cache_path,
            &pending.webview_attributes,
            uri_scheme_protocols.keys(),
            &custom_protocol_scheme,
            scheme_registry.clone(),
            on_initialized,
            shared,
        )?);
        // Publish before returning admission: concurrent pending private tabs share
        // the in-memory backing store even while the first context initializes.
        if let Some(key) = incognito_key {
            INCOGNITO_CONTEXTS
                .lock()
                .unwrap()
                .publish(key, &request_context);
        }
        Some(PendingBrowser {
            creation: Creation::new(window_id),
            context: Some(request_context),
            submit: Some(submit),
            adopt: Some(adopt),
            queue: PendingQueue::new(1024, 8 * 1024 * 1024),
            handlers,
            listeners,
            bounds: desired_bounds,
            bounds_rate,
            initial_window: matches!(
                drag_drop_event_target,
                browser_client::DragDropEventTarget::Window
            ),
            visible: true,
            initial_load: Some(initial_load),
            unadopted: None,
        })
    }

    pub(crate) fn initial_scripts_ready(&mut self, id: u32, success: bool, url: String) {
        let Some((owner, child)) = self.state.windows.iter_mut().find_map(|(owner, window)| {
            window
                .children
                .iter_mut()
                .find(|child| child.webview_id == id)
                .map(|child| (*owner, child))
        }) else {
            return;
        };
        if child.initialization_ready || child.closing.load(Ordering::Acquire) {
            return;
        }
        if !success {
            self.fail_attached_creation(id, "ERR_DIVE_DOCUMENT_START_REGISTRATION");
            return;
        }
        self.state
            .native_deadlines
            .cancel(&NativeDeadline::Creation(id));
        child.initialization_ready = true;
        load_initial_url(&child.browser, &url);
        let mut queue = std::mem::replace(
            &mut child.initial_operations,
            PendingQueue::new(1024, 8 * 1024 * 1024),
        );
        while let Some(message) = queue.pop() {
            self.handle_webview_message(owner, id, message);
        }
    }

    pub(crate) fn fail_attached_creation(&mut self, id: u32, reason: &str) {
        self.state
            .native_deadlines
            .cancel(&NativeDeadline::Creation(id));
        let Some(child) = self
            .state
            .windows
            .values_mut()
            .flat_map(|window| window.children.iter_mut())
            .find(|child| child.webview_id == id)
        else {
            return;
        };
        if child.initialization_ready || child.closing.load(Ordering::Acquire) {
            return;
        }
        child.creation.fail();
        child.initial_operations.clear();
        let handlers = std::mem::take(&mut *child.devtools_protocol_handlers.lock().unwrap());
        child.request_close(true);
        for handler in handlers {
            handler(DevToolsProtocol::CreationFailed(reason.to_owned()));
        }
    }

    pub(crate) fn context_ready(&mut self, id: u32, context: Option<RequestContext>) {
        let Some(pending) = self.state.pending_browsers.get_mut(&id) else {
            return;
        };
        if !pending.creation.context_ready() {
            return;
        }
        let owner = pending.creation.owner();
        if self.state.exiting || self.state.is_window_closing(owner) {
            self.cancel_pending_creation(id);
            return;
        }
        let accepted =
            if let (Some(context), Some(window)) = (context, self.state.windows.get(&owner)) {
                self.state
                    .pending_browsers
                    .get_mut(&id)
                    .and_then(|pending| pending.submit.take())
                    .is_some_and(|submit| submit(window, &context))
            } else {
                false
            };
        if accepted {
            if let Some(pending) = self.state.pending_browsers.get_mut(&id) {
                pending.creation.accept();
            }
        } else {
            self.fail_pending_creation(id, "ERR_DIVE_NATIVE_CREATION_REJECTED");
        }
    }

    pub(crate) fn cancel_pending_creation(&mut self, id: u32) {
        self.end_pending_creation(id, None);
    }

    pub(crate) fn fail_pending_creation(&mut self, id: u32, reason: &str) {
        self.end_pending_creation(id, Some(reason));
    }

    fn end_pending_creation(&mut self, id: u32, reason: Option<&str>) {
        self.state
            .native_deadlines
            .cancel(&NativeDeadline::Creation(id));
        let Some(pending) = self.state.pending_browsers.get_mut(&id) else {
            return;
        };
        let changed = if reason.is_some() {
            pending.creation.fail()
        } else {
            pending.creation.cancel()
        };
        if !changed {
            return;
        }
        // Drop handlers outside their mutex: captured application transports may
        // shut down and dispatch more work when their final sender disappears.
        let handlers = std::mem::take(&mut *pending.handlers.lock().unwrap());
        pending.queue.clear();
        pending.initial_load.take();
        pending.submit.take();
        let pinned = pending.creation.pins_parent();
        let owner = pending.creation.owner();
        let initial_window = pending.initial_window;
        if !pinned {
            if let Some(order) = self.state.window_orders.get_mut(&owner) {
                order.retain(|view| *view != id);
            }
            self.state.pending_browsers.remove(&id);
        }
        if reason.is_some() && initial_window {
            let _ = self.context.sender.send(Message::Window {
                window_id: owner,
                message: crate::window::WindowMessage::Destroy,
            });
            self.context.proxy.wake_up();
        }
        if let Some(reason) = reason {
            log::error!("native webview creation {id} failed: {reason}");
            for handler in &handlers {
                handler(DevToolsProtocol::CreationFailed(reason.to_owned()));
            }
        }
    }

    pub(crate) fn browser_created(&mut self, id: u32, browser: Browser) {
        let Some(mut pending) = self.state.pending_browsers.remove(&id) else {
            return;
        };
        let completion = pending.creation.complete();
        if completion == Completion::Ignore {
            self.state.pending_browsers.insert(id, pending);
            return;
        }
        let owner = pending.creation.owner();
        // on_after_created guarantees a host. Retain all ownership and surface
        // failure if a broken implementation ever violates that guarantee.
        if browser.host().is_none() {
            pending.unadopted = Some(browser);
            self.state.pending_browsers.insert(id, pending);
            self.fail_pending_creation(id, "ERR_DIVE_NATIVE_HOST_MISSING");
            return;
        }
        let Some(adopt) = pending.adopt.take() else {
            return;
        };
        let bounds = pending.current_bounds(self.state.windows[&owner].window.surface_size());
        let mut child =
            adopt(browser, pending.creation, pending.context.take()).expect("validated CEF host");
        let Some(window) = self.state.windows.get_mut(&owner) else {
            // The accepted-creation parent pin prevents this branch.
            unreachable!("accepted CEF creation lost its parent");
        };
        child.set_bounds(
            window.window.surface_size(),
            window.window.scale_factor(),
            bounds,
        );
        child.bounds_rate = pending.bounds_rate;
        request_context::apply_theme_scheme(
            child.host.request_context().as_ref(),
            window.resolved_theme(*self.context.app_wide_theme.lock().unwrap()),
        );
        child.set_visible(pending.visible && completion == Completion::Attach);
        #[cfg(target_os = "macos")]
        child.apply_requested_accessibility();
        self.state.live_browsers += 1;
        // Process-unique IDs are allocated at admission. Restore admission order
        // instead of allowing out-of-order CEF completion to reorder overlays.
        let order = self
            .state
            .window_orders
            .get(&owner)
            .expect("admitted child order");
        let rank = order
            .iter()
            .position(|view| *view == id)
            .expect("admitted child rank");
        let index = window
            .children
            .iter()
            .position(|child| {
                order
                    .iter()
                    .position(|view| *view == child.webview_id)
                    .is_some_and(|position| position > rank)
            })
            .unwrap_or(window.children.len());
        window.children.insert(index, child);
        #[cfg(windows)]
        for child in &window.children {
            child.raise_to_top();
        }
        layout_app_window(window);
        if self.state.windows[&owner]
            .children
            .iter()
            .find(|child| child.webview_id == id)
            .is_some_and(|child| {
                child
                    .devtools_observer_registration
                    .lock()
                    .unwrap()
                    .is_none()
            })
        {
            self.fail_attached_creation(id, "ERR_DIVE_DEVTOOLS_OBSERVER_REGISTRATION");
            return;
        }
        if completion == Completion::Close
            || self.state.exiting
            || self.state.is_window_closing(owner)
        {
            self.state.windows[&owner]
                .children
                .iter()
                .find(|child| child.webview_id == id)
                .unwrap()
                .request_close(true);
            return;
        }
        while let Some(message) = pending.queue.pop() {
            self.handle_webview_message(owner, id, message);
        }
        if let Some(load) = pending.initial_load.take()
            && let Some(child) = self
                .state
                .windows
                .get(&owner)
                .and_then(|window| window.children.iter().find(|child| child.webview_id == id))
            && !child.closing.load(Ordering::Acquire)
        {
            load(&child.browser);
        }
    }

    fn handle_pending_message(&mut self, window_id: WindowId, id: u32, message: WebviewMessage) {
        let Some(pending) = self.state.pending_browsers.get_mut(&id) else {
            return;
        };
        if pending.creation.owner() != window_id && !message.follows_browser() {
            reject_pending_message(message, "CEF webview owner changed");
            return;
        }
        if matches!(message, WebviewMessage::Close) {
            self.cancel_pending_creation(id);
            return;
        }
        if pending.creation.is_terminal() {
            reject_pending_message(message, "CEF webview creation has ended");
            return;
        }
        let window = &self.state.windows[&pending.creation.owner()];
        let scale = window.window.scale_factor();
        let parent_size = window.window.surface_size();
        pending.bounds = pending.current_bounds(parent_size);
        match message {
            WebviewMessage::OnDevToolsProtocol(handler, tx) => {
                register_pending_protocol(&pending.handlers, handler, tx);
            }
            WebviewMessage::AddEventListener(id, handler) => {
                pending.listeners.lock().unwrap().insert(id, handler);
            }
            WebviewMessage::Bounds(tx) => {
                let _ = tx.send(Ok(pending.bounds));
            }
            WebviewMessage::Position(tx) => {
                let _ = tx.send(Ok(pending.bounds.position.to_physical(scale)));
            }
            WebviewMessage::Size(tx) => {
                let _ = tx.send(Ok(pending.bounds.size.to_physical(scale)));
            }
            WebviewMessage::Show => pending.visible = true,
            WebviewMessage::Hide => pending.visible = false,
            WebviewMessage::SetBounds(bounds) => {
                pending.bounds = bounds;
                pending.bounds_rate = compute_child_bounds_rate(
                    Some(&pending.bounds),
                    pending.bounds_rate.is_some(),
                    parent_size,
                    scale,
                );
            }
            WebviewMessage::SetPosition(position) => {
                pending.bounds.position = position;
                pending.bounds_rate = compute_child_bounds_rate(
                    Some(&pending.bounds),
                    pending.bounds_rate.is_some(),
                    parent_size,
                    scale,
                );
            }
            WebviewMessage::SetSize(size) => {
                pending.bounds.size = size;
                pending.bounds_rate = compute_child_bounds_rate(
                    Some(&pending.bounds),
                    pending.bounds_rate.is_some(),
                    parent_size,
                    scale,
                );
            }
            WebviewMessage::SetAutoResize(auto) => {
                pending.bounds_rate =
                    compute_child_bounds_rate(Some(&pending.bounds), auto, parent_size, scale);
            }
            // No synchronous caller is ever queued behind a future CEF callback.
            message @ (WebviewMessage::CanGoBack(_)
            | WebviewMessage::CanGoForward(_)
            | WebviewMessage::Url(_)
            | WebviewMessage::Cookies(_)
            | WebviewMessage::CookiesForUrl(..)
            | WebviewMessage::Reparent(..)) => {
                reject_pending_message(message, "CEF webview is not ready")
            }
            #[cfg(any(debug_assertions, feature = "devtools"))]
            WebviewMessage::IsDevToolsOpen(tx) => {
                let _ = tx.send(false);
            }
            message => {
                let bytes = match &message {
                    WebviewMessage::SendDevToolsMessage(bytes, _) => bytes.len(),
                    WebviewMessage::EvaluateScript(script)
                    | WebviewMessage::EvaluateScriptWithCallback(script, _) => script.len(),
                    WebviewMessage::Navigate(url) => url.as_str().len(),
                    WebviewMessage::SetCookie(cookie) | WebviewMessage::DeleteCookie(cookie) => {
                        cookie.name().len()
                            + cookie.value().len()
                            + cookie.domain().map_or(0, str::len)
                            + cookie.path().map_or(0, str::len)
                    }
                    _ => std::mem::size_of::<WebviewMessage>(),
                };
                if let Err(message) = pending.queue.push(message, bytes) {
                    reject_pending_message(message, "CEF pending operation budget exceeded");
                    self.fail_pending_creation(id, "ERR_DIVE_NATIVE_PENDING_OVERFLOW");
                }
            }
        }
    }

    pub(crate) fn handle_webview_message(
        &mut self,
        window_id: WindowId,
        webview_id: u32,
        message: WebviewMessage,
    ) {
        if matches!(message, WebviewMessage::Close) {
            self.state
                .native_deadlines
                .cancel(&NativeDeadline::Creation(webview_id));
        }
        if self.state.pending_browsers.contains_key(&webview_id) {
            self.handle_pending_message(window_id, webview_id, message);
            return;
        }
        // If the runtime is exiting, don't process any more messages to avoid macOS crash on exit.
        if self.state.exiting {
            return;
        }

        // The dispatcher updates future sends after reparent succeeds, but work
        // already in the queue still carries the old window ID. Resolve only
        // browser-owned work by the runtime's unique webview ID; never by label,
        // active tab, or whichever child occupies the former slot.
        let Some(window_id) = crate::webview_routing::resolve_owner(
            window_id,
            message.follows_browser(),
            |owner| {
                self.state.windows.get(&owner).is_some_and(|window| {
                    window
                        .children
                        .iter()
                        .any(|child| child.webview_id == webview_id)
                })
            },
            || {
                self.state.windows.iter().find_map(|(owner, window)| {
                    window
                        .children
                        .iter()
                        .any(|child| child.webview_id == webview_id)
                        .then_some(*owner)
                })
            },
            |owner| self.state.is_window_closing(owner),
        ) else {
            return;
        };

        let Some(appwindow) = self.state.windows.get_mut(&window_id) else {
            return;
        };
        let Some(child) = appwindow
            .children
            .iter_mut()
            .find(|child| child.webview_id == webview_id)
        else {
            return;
        };

        if !child.initialization_ready
            && matches!(
                message,
                WebviewMessage::Navigate(_)
                    | WebviewMessage::Reload
                    | WebviewMessage::GoBack
                    | WebviewMessage::GoForward
            )
        {
            let bytes = match &message {
                WebviewMessage::Navigate(url) => url.as_str().len(),
                _ => 0,
            };
            if child.initial_operations.push(message, bytes).is_err() {
                self.fail_attached_creation(webview_id, "ERR_DIVE_NATIVE_PENDING_OVERFLOW");
            }
            return;
        }
        match message {
            WebviewMessage::EvaluateScript(script) => {
                if let Some(frame) = child.browser.main_frame() {
                    let script = cef::CefString::from(script.as_str());
                    let url = cef::CefString::from("");
                    frame.execute_java_script(Some(&script), Some(&url), 0);
                }
            }
            WebviewMessage::EvaluateScriptWithCallback(script, callback) => {
                let host = &child.host;
                let message_id = self.context.next_webview_event_id() as i32 + 1;
                let message_id = Arc::new(AtomicI32::new(message_id));
                let callback = Arc::new(Mutex::new(Some(callback)));
                let registration = Arc::new(Mutex::new(None));
                let mut observer = EvalScriptWithCallbackDevToolsObserver::new(
                    message_id.clone(),
                    callback.clone(),
                    registration.clone(),
                );

                if let Some(observer_registration) =
                    host.add_dev_tools_message_observer(Some(&mut observer))
                {
                    *registration.lock().unwrap() = Some(observer_registration);

                    let message = serde_json::json!({
                      "id": message_id.load(Ordering::Relaxed),
                      "method": "Runtime.evaluate",
                      "params": {
                        "expression": script,
                        "returnByValue": true,
                      }
                    })
                    .to_string();

                    if host.send_dev_tools_message(Some(message.as_bytes())) != 1 {
                        let _ = registration.lock().unwrap().take();
                        if let Some(callback) = callback.lock().unwrap().take() {
                            callback(String::new());
                        }
                    }
                } else if let Some(callback) = callback.lock().unwrap().take() {
                    callback(String::new());
                }
            }
            WebviewMessage::Navigate(url) => {
                if let Some(frame) = child.browser.main_frame() {
                    frame.load_url(Some(&cef::CefString::from(url.as_str())));
                }
            }
            WebviewMessage::Reload => child.browser.reload(),
            WebviewMessage::GoBack => child.browser.go_back(),
            WebviewMessage::CanGoBack(tx) => _ = tx.send(Ok(child.browser.can_go_back() == 1)),
            WebviewMessage::GoForward => child.browser.go_forward(),
            WebviewMessage::CanGoForward(tx) => {
                _ = tx.send(Ok(child.browser.can_go_forward() == 1))
            }
            WebviewMessage::Close => {
                // Forced: the embedder has already forgotten the view, so a page that
                // vetoed a graceful close would keep painting with nobody to hide it.
                child.request_close(true);
            }
            WebviewMessage::SetBounds(bounds) => {
                let parent_size = appwindow.window.surface_size();
                let scale = appwindow.window.scale_factor();
                child.set_bounds(parent_size, scale, bounds);
            }
            WebviewMessage::SetSize(size) => {
                let parent_size = appwindow.window.surface_size();
                let scale = appwindow.window.scale_factor();
                let bounds = child.bounds().unwrap_or_default();
                let new_bounds = Rect {
                    position: bounds.position,
                    size,
                };
                child.set_bounds(parent_size, scale, new_bounds);
            }
            WebviewMessage::SetPosition(position) => {
                let parent_size = appwindow.window.surface_size();
                let scale = appwindow.window.scale_factor();
                let bounds = child.bounds().unwrap_or_default();
                let new_bounds = Rect {
                    position,
                    size: bounds.size,
                };
                child.set_bounds(parent_size, scale, new_bounds);
            }
            WebviewMessage::SetFocus => {
                let browser_id =
                    crate::native_input_trace::enabled().then(|| child.browser.identifier());
                crate::native_input_trace::record(
                    crate::native_input_trace::Stage::SetFocusBegin,
                    browser_id,
                    Some(webview_id),
                );
                child.host.set_focus(1);
                crate::native_input_trace::record(
                    crate::native_input_trace::Stage::SetFocusEnd,
                    browser_id,
                    Some(webview_id),
                );
            }
            WebviewMessage::Url(tx) => {
                let url = child.url().unwrap_or_default();
                let _ = tx.send(Ok(url));
            }
            WebviewMessage::Bounds(tx) => {
                let bounds = child.bounds().ok_or(Error::FailedToSendMessage);
                let _ = tx.send(bounds);
            }
            WebviewMessage::Position(tx) => {
                let bounds = child.bounds().ok_or(Error::FailedToSendMessage);
                let position = bounds.map(|b| b.position);
                let position =
                    position.map(|p| p.to_physical::<i32>(appwindow.window.scale_factor()));
                let _ = tx.send(position);
            }
            WebviewMessage::Size(tx) => {
                let bounds = child.bounds().ok_or(Error::FailedToSendMessage);
                let size =
                    bounds.map(|b| b.size.to_physical::<u32>(appwindow.window.scale_factor()));
                let _ = tx.send(size);
            }
            WebviewMessage::WithWebview(f) => f(Webview::new(
                child.browser.clone(),
                child.permissions.clone(),
                child.context_menu.clone(),
                child.js_dialog.clone(),
                Arc::downgrade(&child.shortcut_target),
                child.shortcut_binding.clone(),
            )),
            WebviewMessage::Print => child.host.print(),
            WebviewMessage::AddEventListener(event_id, handler) => {
                child.listeners.lock().unwrap().insert(event_id, handler);
            }
            WebviewMessage::Show => child.set_visible(true),
            WebviewMessage::Hide => child.set_visible(false),
            WebviewMessage::SetZoom(scale_factor) => {
                // CEF uses a logarithmic zoom level where percentage = 1.2^level
                // (Chromium's kTextSizeMultiplierRatio). Convert from Tauri linear
                // scale factor (1.0 = 100%) to CEF's level (0.0 = 100%)
                const CEF_ZOOM_BASE: f64 = 1.2;
                let zoom_level = if scale_factor > 0.0 {
                    scale_factor.ln() / CEF_ZOOM_BASE.ln()
                } else {
                    0.0
                };
                child.host.set_zoom_level(zoom_level);
            }
            WebviewMessage::SetAutoResize(auto_resize) => {
                if auto_resize {
                    let bounds = child.bounds();
                    let parent_size = appwindow.window.surface_size();
                    let scale = appwindow.window.scale_factor();
                    child.bounds_rate =
                        compute_child_bounds_rate(bounds.as_ref(), true, parent_size, scale);
                } else {
                    child.bounds_rate = None;
                }
            }
            WebviewMessage::SetBackgroundColor(color) => child.set_background_color(color),
            WebviewMessage::ClearAllBrowsingData => {
                if let Some(manager) = child.cookie_manager() {
                    manager.delete_cookies(None, None, None);
                    manager.flush_store(None);
                }
                if let Some(request_context) = child.host.request_context() {
                    request_context.clear_http_cache(None);
                }
            }
            WebviewMessage::CookiesForUrl(url, tx) => {
                if let Some(manager) = child.cookie_manager() {
                    cookie::visit_url_cookies(manager, url, tx);
                } else {
                    let _ = tx.send(Ok(Vec::new()));
                }
            }
            WebviewMessage::Cookies(tx) => {
                if let Some(manager) = child.cookie_manager() {
                    cookie::visit_all_cookies(manager, tx);
                } else {
                    let _ = tx.send(Ok(Vec::new()));
                }
            }
            WebviewMessage::SetCookie(cookie) => {
                if let Some(manager) = child.cookie_manager() {
                    let url = child.url();
                    cookie::set_cookie(manager, url, cookie);
                }
            }
            WebviewMessage::DeleteCookie(cookie) => {
                if let Some(manager) = child.cookie_manager() {
                    let url = child.url();
                    cookie::delete_cookie(manager, url, cookie);
                }
            }
            WebviewMessage::Reparent(target_window_id, tx) => {
                if child.closing.load(Ordering::Acquire) {
                    let _ = tx.send(Err(Error::CreateWebview("CEF webview is closing".into())));
                    return;
                }
                if window_id == target_window_id {
                    let _ = tx.send(Ok(()));
                    return;
                }

                if !self.state.windows.contains_key(&target_window_id) {
                    let _ = tx.send(Err(Error::WindowNotFound));
                    return;
                }

                let Some(mut child) =
                    self.state
                        .windows
                        .get_mut(&window_id)
                        .and_then(|appwindow| {
                            appwindow
                                .children
                                .iter()
                                .position(|child| child.webview_id == webview_id)
                                .map(|index| appwindow.children.remove(index))
                        })
                else {
                    let _ = tx.send(Err(Error::WindowNotFound));
                    return;
                };

                let Some(target_appwindow) = self.state.windows.get_mut(&target_window_id) else {
                    let _ = tx.send(Err(Error::WindowNotFound));
                    return;
                };

                let bounds = child.bounds().unwrap_or_else(|| Rect {
                    position: PhysicalPosition::new(0, 0).into(),
                    size: target_appwindow.window.surface_size().into(),
                });
                // Invalidate cross-window shortcuts before changing native ownership,
                // including a later move back to the very same NSWindow address.
                child.shortcut_target.invalidate_parent();
                child.reparent(target_appwindow);
                child.set_bounds(
                    target_appwindow.window.surface_size(),
                    target_appwindow.window.scale_factor(),
                    bounds,
                );
                // Re-parenting does not preserve z-order: a view docked back into a
                // window that already owns a full-window main webview must be put back
                // on top, or it lands behind it and renders nothing.
                #[cfg(windows)]
                child.raise_to_top();

                child.creation.reparent(target_window_id);
                if let Some(order) = self.state.window_orders.get_mut(&window_id) {
                    order.retain(|id| *id != webview_id);
                }
                self.state
                    .window_orders
                    .entry(target_window_id)
                    .or_default()
                    .push(webview_id);
                target_appwindow.children.push(child);
                let _ = tx.send(Ok(()));
            }
            #[cfg(any(debug_assertions, feature = "devtools"))]
            WebviewMessage::OpenDevTools => {
                #[cfg(target_os = "macos")]
                let bounds = child.devtools_bounds_now();
                child.host.show_dev_tools(None, None, None, None);
                // Chrome opens the window on its own schedule and at its own
                // small default; poll briefly and move it once it exists.
                #[cfg(target_os = "macos")]
                if let Some(bounds) = bounds {
                    let context = self.context.clone();
                    std::thread::spawn(move || {
                        for _ in 0..20 {
                            std::thread::sleep(std::time::Duration::from_millis(100));
                            let (tx, rx) = mpsc::channel();
                            let sent = context.run_on_main_thread(move || {
                                let placed = objc2::MainThreadMarker::new().is_some_and(|mtm| {
                                    crate::platform::macos::place_devtools_window(bounds, mtm)
                                });
                                let _ = tx.send(placed);
                            });
                            if sent.is_err() || rx.recv().unwrap_or(true) {
                                break;
                            }
                        }
                    });
                }
            }
            #[cfg(any(debug_assertions, feature = "devtools"))]
            WebviewMessage::CloseDevTools => child.host.close_dev_tools(),
            #[cfg(any(debug_assertions, feature = "devtools"))]
            WebviewMessage::IsDevToolsOpen(tx) => _ = tx.send(child.host.has_dev_tools() == 1),
            WebviewMessage::SendDevToolsMessage(message, tx) => {
                let result = child.host.send_dev_tools_message(Some(&message));
                if result != 1 {
                    // Sending is asynchronous; the dispatcher no longer waits
                    // on tx. Resolve the actual protocol call immediately when
                    // CEF rejects it, instead of making it wait out its timeout.
                    if let Some(reply) = rejected_devtools_reply(&message) {
                        let handlers = child.devtools_protocol_handlers.lock().unwrap().clone();
                        for handler in handlers {
                            handler(DevToolsProtocol::Message(reply.clone()));
                        }
                    }
                }
                let _ = tx.send(if result == 1 {
                    Ok(())
                } else {
                    Err(Error::FailedToSendMessage)
                });
            }
            WebviewMessage::OnDevToolsProtocol(handler, tx) => {
                child
                    .devtools_protocol_handlers
                    .lock()
                    .unwrap()
                    .push(handler);

                let needs_devtools_observer = child
                    .devtools_observer_registration
                    .lock()
                    .unwrap()
                    .is_none();
                if needs_devtools_observer {
                    if let Some(registration) = add_dev_tools_observer(
                        &child.browser,
                        child.devtools_protocol_handlers.clone(),
                        Arc::new(Mutex::new(HashMap::new())),
                    ) {
                        *child.devtools_observer_registration.lock().unwrap() = Some(registration);
                        let _ = tx.send(Ok(()));
                    } else {
                        let _ = tx.send(Err(Error::FailedToSendMessage));
                    }
                } else {
                    let _ = tx.send(Ok(()));
                }
            }
        }
    }
}

fn rejected_devtools_reply(message: &[u8]) -> Option<Vec<u8>> {
    let message: serde_json::Value = serde_json::from_slice(message).ok()?;
    let id = message.get("id")?.as_i64()?;
    serde_json::to_vec(&serde_json::json!({
        "id": id,
        "error": {"code": -32000, "message": "CEF rejected the DevTools command"}
    }))
    .ok()
}

#[cfg(test)]
mod rejected_command_tests {
    #[test]
    fn pending_cdp_registration_acknowledges_without_native_creation() {
        let handlers = Default::default();
        let (tx, rx) = std::sync::mpsc::channel();
        super::register_pending_protocol(&handlers, std::sync::Arc::new(|_| {}), tx);
        assert!(rx.try_recv().unwrap().is_ok());
        assert_eq!(handlers.lock().unwrap().len(), 1);
    }

    #[test]
    fn pending_getters_and_reparent_fail_immediately() {
        use super::{WebviewMessage, reject_pending_message};
        let (tx, rx) = std::sync::mpsc::channel();
        reject_pending_message(WebviewMessage::CanGoBack(tx), "CEF webview is not ready");
        assert!(
            rx.try_recv()
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("not ready")
        );
        let (tx, rx) = std::sync::mpsc::channel();
        reject_pending_message(WebviewMessage::Url(tx), "CEF webview is not ready");
        assert!(rx.try_recv().unwrap().is_err());
        let (tx, rx) = std::sync::mpsc::channel();
        reject_pending_message(
            WebviewMessage::Reparent(tauri_runtime::window::WindowId::from(9), tx),
            "CEF webview is not ready",
        );
        assert!(rx.try_recv().unwrap().is_err());
    }

    #[test]
    fn rejection_resolves_the_original_call_and_ignores_notifications() {
        let reply =
            super::rejected_devtools_reply(br#"{"id":10000042,"method":"Fetch.continueRequest"}"#)
                .unwrap();
        let reply: serde_json::Value = serde_json::from_slice(&reply).unwrap();
        assert_eq!(reply["id"], 10000042);
        assert_eq!(reply["error"]["code"], -32000);
        assert!(super::rejected_devtools_reply(br#"{"method":"event"}"#).is_none());
        assert!(super::rejected_devtools_reply(b"invalid").is_none());
    }
}

#[derive(Clone, Copy, Debug)]
pub enum RuntimeStyle {
    Alloy,
    Chrome,
}

#[derive(Debug)]
pub enum WebviewAtribute {
    RuntimeStyle { style: RuntimeStyle },
}

unsafe impl Send for WebviewAtribute {}
unsafe impl Sync for WebviewAtribute {}

#[derive(Debug, Clone)]
pub struct CefInitScript {
    pub(crate) script: String,
    pub(crate) hash: String,
    for_main_frame_only: bool,
}

impl CefInitScript {
    fn new(script: InitializationScript) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(normalize_script_for_csp(script.script.as_bytes()));
        let hash = format!(
            "'sha256-{}'",
            base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                hasher.finalize()
            )
        );
        Self {
            script: script.script,
            hash,
            for_main_frame_only: script.for_main_frame_only,
        }
    }
}

pub(crate) fn initialization_scripts(attrs: &mut WebviewAttributes) -> Arc<Vec<CefInitScript>> {
    let mut initialization_scripts = Vec::new();

    if attrs.drag_drop_handler_enabled {
        let drag_script = browser_client::drag_drop_initialization_script();
        initialization_scripts.push(CefInitScript::new(drag_script));
    }

    initialization_scripts.extend(
        std::mem::take(&mut attrs.initialization_scripts)
            .into_iter()
            .map(CefInitScript::new),
    );

    Arc::new(initialization_scripts)
}

#[derive(Debug, Clone)]
pub struct CefWebviewDispatcher<T: UserEvent> {
    pub(crate) window_id: Arc<Mutex<WindowId>>,
    pub(crate) webview_id: u32,
    pub(crate) context: RuntimeContext<T>,
}

impl<T: UserEvent> CefWebviewDispatcher<T> {
    /// Queue a DevTools protocol message for the webview.
    ///
    /// This does not wait for the main thread to hand the message to CEF. Every
    /// protocol call the host makes -- and request interception makes one per
    /// subresource -- used to park a worker thread here until the main thread
    /// next drained its queue, which both added the main thread's latency to
    /// every request and could exhaust the worker pool under load. The reply
    /// only said whether CEF accepted the message; a message for a browser that
    /// is gone is answered by the session closing, so nothing is lost by not
    /// waiting for it.
    pub fn send_dev_tools_message(&self, message: &[u8]) -> Result<()> {
        let (tx, _rx) = mpsc::channel();
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::SendDevToolsMessage(message.to_vec(), tx),
        })
    }

    pub fn on_dev_tools_protocol<F: Fn(DevToolsProtocol) + Send + Sync + 'static>(
        &self,
        f: F,
    ) -> Result<()> {
        let (tx, rx) = mpsc::channel();
        let handler =
            Arc::new(move |protocol: DevToolsProtocol| f(protocol)) as Arc<DevToolsProtocolHandler>;
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::OnDevToolsProtocol(handler, tx),
        })?;
        rx.recv().map_err(|_| Error::FailedToReceiveMessage)?
    }
}

pub(crate) fn create_webview_detached<T: UserEvent>(
    context: &RuntimeContext<T>,
    window_id: WindowId,
    pending: PendingWebview<T, CefRuntime<T>>,
) -> Result<DetachedWebview<T, CefRuntime<T>>> {
    let label = pending.label.clone();
    let webview_id = context.next_webview_id();
    let (result_tx, result_rx) = mpsc::channel();
    context.send_message(Message::CreateWebview {
        window_id,
        webview_id,
        pending: Box::new(pending),
        result_tx,
    })?;
    // Block until the event loop has created the browser so a creation failure
    // is surfaced to the caller instead of leaving a detached, dead webview.
    result_rx
        .recv()
        .map_err(|_| Error::FailedToReceiveMessage)??;
    Ok(DetachedWebview {
        label,
        dispatcher: CefWebviewDispatcher {
            window_id: Arc::new(Mutex::new(window_id)),
            webview_id,
            context: context.clone(),
        },
    })
}

fn getter<T: UserEvent, R>(
    context: &RuntimeContext<T>,
    message: Message<T>,
    receiver: Receiver<Result<R>>,
) -> Result<R> {
    context.send_message(message)?;
    receiver.recv().map_err(|_| Error::FailedToReceiveMessage)?
}

macro_rules! webview_getter {
    ($self:ident, $variant:ident) => {{
        let (tx, rx) = mpsc::channel();
        getter(
            &$self.context,
            Message::Webview {
                window_id: *$self.window_id.lock().unwrap(),
                webview_id: $self.webview_id,
                message: WebviewMessage::$variant(tx),
            },
            rx,
        )
    }};
}

impl<T: UserEvent> WebviewDispatch<T> for CefWebviewDispatcher<T> {
    type Runtime = CefRuntime<T>;

    fn run_on_main_thread<F: FnOnce() + Send + 'static>(&self, f: F) -> Result<()> {
        self.context.run_on_main_thread(f)
    }

    fn on_webview_event<F: Fn(&WebviewEvent) + Send + 'static>(&self, f: F) -> WebviewEventId {
        let id = self.context.next_webview_event_id();
        let _ = self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::AddEventListener(id, Box::new(f)),
        });
        id
    }

    fn with_webview<F: FnOnce(<Self::Runtime as Runtime<T>>::Webview) + Send + 'static>(
        &self,
        f: F,
    ) -> Result<()> {
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::WithWebview(Box::new(f)),
        })
    }

    #[cfg(any(debug_assertions, feature = "devtools"))]
    fn open_devtools(&self) {
        let _ = self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::OpenDevTools,
        });
    }

    #[cfg(any(debug_assertions, feature = "devtools"))]
    fn close_devtools(&self) {
        let _ = self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::CloseDevTools,
        });
    }

    #[cfg(any(debug_assertions, feature = "devtools"))]
    fn is_devtools_open(&self) -> Result<bool> {
        let (tx, rx) = mpsc::channel();
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::IsDevToolsOpen(tx),
        })?;
        rx.recv().map_err(|_| Error::FailedToReceiveMessage)
    }

    fn url(&self) -> Result<String> {
        webview_getter!(self, Url)
    }

    fn bounds(&self) -> Result<Rect> {
        webview_getter!(self, Bounds)
    }

    fn position(&self) -> Result<PhysicalPosition<i32>> {
        webview_getter!(self, Position)
    }

    fn size(&self) -> Result<PhysicalSize<u32>> {
        webview_getter!(self, Size)
    }

    fn navigate(&self, url: Url) -> Result<()> {
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::Navigate(url),
        })
    }

    fn reload(&self) -> Result<()> {
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::Reload,
        })
    }

    fn go_back(&self) -> Result<()> {
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::GoBack,
        })
    }

    fn can_go_back(&self) -> Result<bool> {
        webview_getter!(self, CanGoBack)
    }

    fn go_forward(&self) -> Result<()> {
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::GoForward,
        })
    }

    fn can_go_forward(&self) -> Result<bool> {
        webview_getter!(self, CanGoForward)
    }

    fn print(&self) -> Result<()> {
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::Print,
        })
    }

    fn close(&self) -> Result<()> {
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::Close,
        })
    }

    fn set_bounds(&self, bounds: Rect) -> Result<()> {
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::SetBounds(bounds),
        })
    }

    fn set_size(&self, size: Size) -> Result<()> {
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::SetSize(size),
        })
    }

    fn set_position(&self, position: Position) -> Result<()> {
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::SetPosition(position),
        })
    }

    fn set_focus(&self) -> Result<()> {
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::SetFocus,
        })
    }

    fn hide(&self) -> Result<()> {
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::Hide,
        })
    }

    fn show(&self) -> Result<()> {
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::Show,
        })
    }

    fn eval_script<S: Into<String>>(&self, script: S) -> Result<()> {
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::EvaluateScript(script.into()),
        })
    }

    fn eval_script_with_callback<S: Into<String>>(
        &self,
        script: S,
        callback: impl Fn(String) + Send + 'static,
    ) -> Result<()> {
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::EvaluateScriptWithCallback(script.into(), Box::new(callback)),
        })
    }

    fn reparent(&self, window_id: WindowId) -> Result<()> {
        let (tx, rx) = mpsc::channel();
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::Reparent(window_id, tx),
        })?;
        let result = rx.recv().map_err(|_| Error::FailedToReceiveMessage)?;
        if result.is_ok() {
            *self.window_id.lock().unwrap() = window_id;
        }
        result
    }

    fn cookies_for_url(&self, url: Url) -> Result<Vec<Cookie<'static>>> {
        let (tx, rx) = mpsc::channel();
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::CookiesForUrl(url, tx),
        })?;
        rx.recv().map_err(|_| Error::FailedToReceiveMessage)?
    }

    fn cookies(&self) -> Result<Vec<Cookie<'static>>> {
        webview_getter!(self, Cookies)
    }

    fn set_cookie(&self, cookie: Cookie<'_>) -> Result<()> {
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::SetCookie(cookie.into_owned()),
        })
    }

    fn delete_cookie(&self, cookie: Cookie<'_>) -> Result<()> {
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::DeleteCookie(cookie.into_owned()),
        })
    }

    fn set_auto_resize(&self, auto_resize: bool) -> Result<()> {
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::SetAutoResize(auto_resize),
        })
    }

    fn set_zoom(&self, scale_factor: f64) -> Result<()> {
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::SetZoom(scale_factor),
        })
    }

    fn set_background_color(&self, color: Option<Color>) -> Result<()> {
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::SetBackgroundColor(color),
        })
    }

    fn clear_all_browsing_data(&self) -> Result<()> {
        self.context.send_message(Message::Webview {
            window_id: *self.window_id.lock().unwrap(),
            webview_id: self.webview_id,
            message: WebviewMessage::ClearAllBrowsingData,
        })
    }
}

/// Reposition every child webview to follow the parent window size.
///
/// Children with a bounds rate (auto-resize / window-filling) are recomputed
/// from the current window size; children with fixed bounds keep whatever bounds
/// they were last given.
pub(crate) fn layout_app_window(appwindow: &AppWindow) {
    let parent_size = appwindow.window.surface_size();
    let win_w = parent_size.width as f32;
    let win_h = parent_size.height as f32;
    let scale = appwindow.window.scale_factor();
    for child in &appwindow.children {
        let Some(rate) = child.bounds_rate else {
            continue;
        };
        let x = (rate.x * win_w).round() as i32;
        let y = (rate.y * win_h).round() as i32;
        let w = (rate.width * win_w).round() as i32;
        let h = (rate.height * win_h).round() as i32;
        child.host.notify_move_or_resize_started();
        child.apply_physical_bounds(scale, x, y, w, h);
        child.host.was_resized();
    }
}

/// Compute the bounds rate of a child webview relative to its parent window.
///
/// For webiews filling the window, default rate is used, otherwise the rate is computed from the current bounds and parent size
/// if auto_resize is enabled, otherwise None is returned.
pub(crate) fn compute_child_bounds_rate(
    bounds: Option<&Rect>,
    auto_resize: bool,
    parent_size: PhysicalSize<u32>,
    scale: f64,
) -> Option<BoundsRate> {
    let Some(bounds) = bounds else {
        return Some(BoundsRate::default());
    };

    if !auto_resize {
        return None;
    }

    let min_w = parent_size.width.max(1) as i32;
    let min_h = parent_size.height.max(1) as i32;

    let pos = bounds.position.to_physical::<i32>(scale);
    let size = bounds.size.to_physical::<u32>(scale);

    let x = pos.x;
    let y = pos.y;
    let w = size.width;
    let h = size.height;

    Some(BoundsRate {
        x: x as f32 / min_w as f32,
        y: y as f32 / min_h as f32,
        width: w as f32 / min_w as f32,
        height: h as f32 / min_h as f32,
    })
}

pub(crate) const INITIAL_LOAD_URL: &str = concat!(
    "data:text/html;charset=utf-8,",
    "%3C!doctype%20html%3E",
    "%3Chtml%20data-tauri-cef-internal%3D%22initial-load%22%3E",
    "%3Chead%3E",
    "%3Cmeta%20charset%3D%22utf-8%22%3E",
    "%3Ctitle%3ETauri%20CEF%20Initial%20Load%3C%2Ftitle%3E",
    "%3C%2Fhead%3E",
    "%3Cbody%20data-tauri-cef-internal%3D%22initial-load%22%3E",
    "%3C!--%20Tauri%20CEF%20internal%20initial%20load%20placeholder%20--%3E",
    "%3C%2Fbody%3E",
    "%3C%2Fhtml%3E",
);
static NEXT_INIT_SCRIPT_DEVTOOLS_MESSAGE_ID: AtomicI32 = AtomicI32::new(1_000_000);

/// Maps a pending `Page.addScriptToEvaluateOnNewDocument` CDP message id to the
/// `(browser, real_url)` whose real navigation is deferred until that message is
/// acknowledged.
pub(crate) type InitialScriptCompletion = Box<dyn FnOnce(bool) + Send>;
pub(crate) type PendingInitialLoads = Arc<Mutex<HashMap<i32, InitialScriptCompletion>>>;

cef::wrap_dev_tools_message_observer! {
  struct TauriDevToolsProtocolObserver {
    handlers: Arc<Mutex<Vec<Arc<DevToolsProtocolHandler>>>>,
    pending_initial_loads: PendingInitialLoads,
  }

  impl DevToolsMessageObserver {
    fn on_dev_tools_message(
      &self,
      _browser: Option<&mut cef::Browser>,
      message: Option<&[u8]>,
    ) -> std::os::raw::c_int {
      // This runs on CEF's UI thread, which is the window's main thread, for
      // every protocol message a page produces -- hundreds a second under
      // load. One copy per handler (there is one in practice) is the floor;
      // the old `clone()` per handler on top of the initial `to_vec` doubled it.
      if let Some(message) = message
        && let Ok(handlers) = self.handlers.lock()
      {
        for handler in handlers.iter() {
          handler(DevToolsProtocol::Message(message.to_vec()));
        }
      }
      0
    }

    fn on_dev_tools_method_result(
      &self,
      _browser: Option<&mut Browser>,
      message_id: std::os::raw::c_int,
      success: std::os::raw::c_int,
      result: Option<&[u8]>,
    ) {
      // The real navigation was deferred until the document-start script was
      // registered; this result acknowledges that, so kick off the real load.
      if let Some(completion) = self
        .pending_initial_loads
        .lock()
        .unwrap()
        .remove(&message_id)
      {
        completion(success != 0);
      }

      // The raw message delivered to `on_dev_tools_message` already carries
      // this result; handlers parse that one. Building and copying a second,
      // pre-parsed variant per handler for every result was pure main-thread
      // waste, so it is no longer dispatched. The variant stays in the enum
      // for API stability.
      let _ = (success, result);
    }

    fn on_dev_tools_event(
      &self,
      _browser: Option<&mut Browser>,
      method: Option<&CefString>,
      params: Option<&[u8]>,
    ) {
      // Same as method results: the raw message is the one consumed, so the
      // per-event `format!` + copy + per-handler clone are skipped.
      let _ = (method, params);
    }
  }
}

fn runtime_evaluate_result_to_json(result: Option<&[u8]>) -> String {
    let Some(result) = result else {
        return String::new();
    };
    let Ok(result) = serde_json::from_slice::<serde_json::Value>(result) else {
        return String::new();
    };

    if result.get("exceptionDetails").is_some() {
        return String::new();
    }

    let remote_object = result.get("result").unwrap_or(&result);
    remote_object
        .get("value")
        .and_then(|value| serde_json::to_string(value).ok())
        .unwrap_or_default()
}

type EvalScriptCallback = Box<dyn Fn(String) + Send + 'static>;

cef::wrap_dev_tools_message_observer! {
  struct EvalScriptWithCallbackDevToolsObserver {
    message_id: Arc<AtomicI32>,
    callback: Arc<Mutex<Option<EvalScriptCallback>>>,
    registration: Arc<Mutex<Option<cef::Registration>>>,
  }

  impl DevToolsMessageObserver {
    fn on_dev_tools_method_result(
      &self,
      _browser: Option<&mut Browser>,
      message_id: std::os::raw::c_int,
      success: std::os::raw::c_int,
      result: Option<&[u8]>,
    ) {
      if message_id != self.message_id.load(Ordering::Relaxed) {
        return;
      }

      let Some(callback) = self.callback.lock().unwrap().take() else {
        return;
      };

      let result = if success != 0 {
        runtime_evaluate_result_to_json(result)
      } else {
        String::new()
      };
      callback(result);

      let _ = self.registration.lock().unwrap().take();
    }
  }
}

/// Registers a DevTools protocol observer. Returns the [`cef::Registration`] which must be
/// kept alive for the observer to stay registered. The observer is unregistered when
/// the Registration is dropped.
pub(crate) fn add_dev_tools_observer(
    browser: &Browser,
    handlers: Arc<Mutex<Vec<Arc<DevToolsProtocolHandler>>>>,
    pending_initial_loads: PendingInitialLoads,
) -> Option<cef::Registration> {
    browser.host().and_then(|host| {
        let mut observer = TauriDevToolsProtocolObserver::new(handlers, pending_initial_loads);
        host.add_dev_tools_message_observer(Some(&mut observer))
    })
}

fn devtools_initialization_script_source(
    initialization_scripts: &[CefInitScript],
    custom_protocol_scheme: &str,
    custom_scheme_domain_names: &[String],
) -> Option<String> {
    if initialization_scripts.is_empty() {
        return None;
    }

    let custom_protocol = serde_json::to_string(&format!("{custom_protocol_scheme}:")).ok()?;
    let custom_domains = serde_json::to_string(custom_scheme_domain_names).ok()?;
    let mut source = format!(
        r#"{{
  const __TAURI_CEF_INIT_CUSTOM_PROTOCOL__ = {custom_protocol};
  const __TAURI_CEF_INIT_CUSTOM_DOMAINS__ = new Set({custom_domains});
  const __TAURI_CEF_INIT_IS_CUSTOM_PROTOCOL__ =
    location.protocol === __TAURI_CEF_INIT_CUSTOM_PROTOCOL__
    && __TAURI_CEF_INIT_CUSTOM_DOMAINS__.has(location.hostname);
  const __TAURI_CEF_INIT_IS_MAIN_FRAME__ = (() => {{
    try {{
      return window.top === window;
    }} catch (_) {{
      return false;
    }}
  }})();
"#
    );

    for init_script in initialization_scripts {
        source.push_str("  if (!__TAURI_CEF_INIT_IS_CUSTOM_PROTOCOL__");
        if init_script.for_main_frame_only {
            source.push_str(" && __TAURI_CEF_INIT_IS_MAIN_FRAME__");
        }
        source.push_str(") {\n");
        source.push_str(init_script.script.as_str());
        source.push_str("\n  }\n");
    }

    source.push_str("}\n");
    Some(source)
}

fn register_initialization_scripts(
    browser: &Browser,
    initialization_scripts: &[CefInitScript],
    custom_protocol_scheme: &str,
    custom_scheme_domain_names: &[String],
    completion: InitialScriptCompletion,
    pending_initial_loads: &PendingInitialLoads,
) {
    let Some(source) = devtools_initialization_script_source(
        initialization_scripts,
        custom_protocol_scheme,
        custom_scheme_domain_names,
    ) else {
        completion(true);
        return;
    };
    let Some(host) = browser.host() else {
        completion(false);
        return;
    };
    let page_enable_message_id =
        NEXT_INIT_SCRIPT_DEVTOOLS_MESSAGE_ID.fetch_add(1, Ordering::Relaxed);
    let page_enable_message = serde_json::json!({
        "id": page_enable_message_id, "method": "Page.enable", "params": {}
    })
    .to_string();
    if host.send_dev_tools_message(Some(page_enable_message.as_bytes())) != 1 {
        completion(false);
        return;
    }
    let message_id = NEXT_INIT_SCRIPT_DEVTOOLS_MESSAGE_ID.fetch_add(1, Ordering::Relaxed);
    let message = serde_json::json!({
        "id": message_id, "method": "Page.addScriptToEvaluateOnNewDocument", "params": { "source": source }
    }).to_string();
    pending_initial_loads
        .lock()
        .unwrap()
        .insert(message_id, completion);
    if host.send_dev_tools_message(Some(message.as_bytes())) != 1 {
        let completion = pending_initial_loads.lock().unwrap().remove(&message_id);
        if let Some(completion) = completion {
            completion(false);
        }
    }
}

/// Completion posts back to the runtime; no callback may navigate independently
/// of current cancellation, document-start or application setup state.
pub(crate) fn load_initial_url_after_registering_initialization_scripts(
    browser: &Browser,
    initialization_scripts: &[CefInitScript],
    custom_protocol_scheme: &str,
    custom_scheme_domain_names: &[String],
    completion: InitialScriptCompletion,
    pending_initial_loads: &PendingInitialLoads,
) {
    register_initialization_scripts(
        browser,
        initialization_scripts,
        custom_protocol_scheme,
        custom_scheme_domain_names,
        completion,
        pending_initial_loads,
    );
}

fn load_initial_url(browser: &Browser, initial_url: &str) {
    if let Some(frame) = browser.main_frame() {
        frame.load_url(Some(&CefString::from(initial_url)));
    }
}
