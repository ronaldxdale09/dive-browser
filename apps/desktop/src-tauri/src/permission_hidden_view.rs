//! Opt-in hidden Chrome Views host for the permission service diagnostic only.
//! Follows pinned cefsimple's macOS hidden Views pattern; never calls Show.
// Pinned cef wrap_* macros generate this reference cast; handwritten code uses no transmute.
#![allow(clippy::transmute_ptr_to_ptr)]

use super::super::on_main;
use crate::{AppError, Runtime, state::lock};
use cef::*;
use dive_cdp::{CdpError, CdpSession, Transport};
use serde_json::{Value as Json, json};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

const MAX_MESSAGE: usize = 1024 * 1024;
#[derive(Default, Debug, PartialEq, Eq)]
enum Stage {
    #[default]
    Absent,
    Live,
    Closed,
}
#[derive(Default)]
struct Evidence {
    browser: Stage,
    window: Stage,
    activated: bool,
}
impl Evidence {
    fn check_hidden(&self, visible: bool, chrome: bool, shared: bool) -> Result<(), AppError> {
        if visible
            || !chrome
            || !shared
            || self.activated
            || self.browser != Stage::Live
            || self.window != Stage::Live
        {
            return Err(AppError::new(format!(
                "hidden diagnostic invariant: visible={visible}, chrome={chrome}, shared={shared}, activated={}, browser={:?}, window={:?}",
                self.activated, self.browser, self.window
            )));
        }
        Ok(())
    }
    fn closed(&self) -> bool {
        self.browser == Stage::Closed && self.window == Stage::Closed
    }
    fn disposed(&self) -> bool {
        self.browser != Stage::Live && self.window != Stage::Live
    }
}
#[derive(Default)]
struct Handles {
    browser: Option<Browser>,
    browser_id: Option<i32>,
    view: Option<BrowserView>,
    window: Option<Window>,
    registration: Option<Registration>,
    evidence: Evidence,
    error: Option<String>,
}
struct Shared {
    handles: Mutex<Handles>,
    session: OnceLock<CdpSession>,
    context: RequestContext,
    path: PathBuf,
    closing: AtomicBool,
}
impl Shared {
    fn fail(&self, message: impl Into<String>) {
        lock(&self.handles).error.get_or_insert(message.into());
        if let Some(session) = self.session.get() {
            session.close();
        }
    }
    fn validate(&self) -> Result<Browser, AppError> {
        if self.closing.load(Ordering::Acquire) {
            return Err(AppError::new("hidden diagnostic closing"));
        }
        let (browser, view, window) = {
            let handles = lock(&self.handles);
            if let Some(error) = &handles.error {
                return Err(AppError::new(error));
            }
            (
                handles.browser.clone(),
                handles.view.clone(),
                handles.window.clone(),
            )
        };
        let browser = browser
            .filter(|b| b.is_valid() != 0)
            .ok_or_else(|| AppError::new("hidden browser unavailable"))?;
        let view = view.ok_or_else(|| AppError::new("hidden BrowserView unavailable"))?;
        let window = window.ok_or_else(|| AppError::new("hidden window unavailable"))?;
        let host = browser
            .host()
            .ok_or_else(|| AppError::new("hidden browser host unavailable"))?;
        let mut expected = self.context.clone();
        let context = host
            .request_context()
            .ok_or_else(|| AppError::new("hidden context unavailable"))?;
        let shared = context.is_sharing_with(Some(&mut expected)) != 0
            && Path::new(&CefString::from(&context.cache_path()).to_string()) == self.path;
        let chrome = host.runtime_style() == RuntimeStyle::CHROME
            && view.runtime_style() == RuntimeStyle::CHROME
            && window.runtime_style() == RuntimeStyle::CHROME;
        let visible = window.is_visible() != 0;
        lock(&self.handles)
            .evidence
            .check_hidden(visible, chrome, shared)?;
        Ok(browser)
    }
}
struct Wire {
    app: tauri::AppHandle<Runtime>,
    shared: Weak<Shared>,
}
impl Transport for Wire {
    fn send(&self, message: &str) -> Result<(), CdpError> {
        let shared = self.shared.upgrade().ok_or(CdpError::Closed)?;
        if message.len() > MAX_MESSAGE {
            return Err(CdpError::Transport("diagnostic message too large".into()));
        }
        let message = message.as_bytes().to_vec();
        self.app
            .run_on_main_thread(move || {
                let result = shared.validate().and_then(|browser| {
                    let host = browser
                        .host()
                        .ok_or_else(|| AppError::new("diagnostic host closed"))?;
                    if host.send_dev_tools_message(Some(&message)) != 1 {
                        return Err(AppError::new("diagnostic native CDP rejected message"));
                    }
                    Ok(())
                });
                if let Err(error) = result {
                    shared.fail(error.to_string());
                }
            })
            .map_err(|error| CdpError::Transport(error.to_string()))
    }
}
cef::wrap_dev_tools_message_observer! {
    struct Observer { shared: Weak<Shared> }
    impl DevToolsMessageObserver {
        fn on_dev_tools_message(&self, browser: Option<&mut Browser>, message: Option<&[u8]>) -> i32 {
            let Some(shared) = self.shared.upgrade() else { return 1; };
            let expected = lock(&shared.handles).browser_id;
            if browser.as_ref().map(|b| b.identifier()) != expected { shared.fail("wrong diagnostic browser callback"); return 1; }
            let result = message.filter(|bytes| bytes.len() <= MAX_MESSAGE)
                .and_then(|bytes| std::str::from_utf8(bytes).ok())
                .ok_or_else(|| AppError::new("invalid/oversized diagnostic CDP message"))
                .and_then(|raw| shared.session.get().ok_or_else(|| AppError::new("diagnostic CDP uninitialized"))?.handle_incoming(raw).map_err(AppError::new));
            if let Err(error) = result { shared.fail(error.to_string()); }
            1
        }
        fn on_dev_tools_agent_detached(&self, _browser: Option<&mut Browser>) {
            if let Some(shared) = self.shared.upgrade() { shared.fail("diagnostic DevTools agent detached"); }
        }
    }
}
cef::wrap_life_span_handler! {
    struct Life { shared: Arc<Shared> }
    impl LifeSpanHandler {
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            let Some(browser) = browser else { self.shared.fail("missing created diagnostic browser"); return; };
            let id = browser.identifier();
            let duplicate = {
                let mut handles = lock(&self.shared.handles);
                if handles.browser_id.is_some() { true } else {
                    handles.evidence.browser = Stage::Live;
                    handles.browser_id = Some(id);
                    handles.browser = Some(browser.clone());
                    false
                }
            };
            if duplicate {
                self.shared.fail("unexpected extra diagnostic browser");
                if let Some(host) = browser.host() { host.close_browser(1); }
                return;
            }
            if self.shared.closing.load(Ordering::Acquire) {
                if let Some(host) = browser.host() { host.close_browser(1); }
                return;
            }
            let mut observer = Observer::new(Arc::downgrade(&self.shared));
            let registration = browser.host().and_then(|host| host.add_dev_tools_message_observer(Some(&mut observer)));
            if registration.is_none() { self.shared.fail("diagnostic observer registration failed"); }
            lock(&self.shared.handles).registration = registration;
        }
        fn on_before_close(&self, browser: Option<&mut Browser>) {
            if browser.as_ref().map(|b| b.identifier()) != lock(&self.shared.handles).browser_id {
                self.shared.fail("wrong diagnostic close callback");
                return;
            }
            let (browser, registration) = {
                let mut handles = lock(&self.shared.handles);
                handles.evidence.browser = Stage::Closed;
                (handles.browser.take(), handles.registration.take())
            };
            if let Some(session) = self.shared.session.get() { session.close(); }
            drop((browser, registration));
        }
        fn on_before_popup(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, _popup_id: i32, _target_url: Option<&CefString>, _target_frame_name: Option<&CefString>, _target_disposition: WindowOpenDisposition, _user_gesture: i32, _popup_features: Option<&PopupFeatures>, _window_info: Option<&mut WindowInfo>, _client: Option<&mut Option<Client>>, _settings: Option<&mut BrowserSettings>, _extra_info: Option<&mut Option<DictionaryValue>>, _no_javascript_access: Option<&mut i32>) -> i32 { 1 }
    }
}
cef::wrap_browser_view_delegate! {
    struct ProbeBrowserDelegate {}
    impl ViewDelegate {}
    impl BrowserViewDelegate { fn browser_runtime_style(&self) -> RuntimeStyle { RuntimeStyle::CHROME } }
}
cef::wrap_window_delegate! {
    struct WindowCallbacks { shared: Arc<Shared> }
    impl ViewDelegate {
        fn preferred_size(&self, _view: Option<&mut View>) -> Size { Size { width: 800, height: 600 } }
    }
    impl PanelDelegate {}
    impl WindowDelegate {
        fn window_runtime_style(&self) -> RuntimeStyle { RuntimeStyle::CHROME }
        fn initial_show_state(&self, _window: Option<&mut Window>) -> ShowState { ShowState::HIDDEN }
        fn on_window_created(&self, window: Option<&mut Window>) {
            let Some(window) = window else { self.shared.fail("missing diagnostic window"); return; };
            let view = { let mut handles = lock(&self.shared.handles); handles.evidence.window = Stage::Live; handles.window = Some(window.clone()); handles.view.clone() };
            if let Some(view) = view { window.add_child_view(Some(&mut View::from(&view))); }
            // No Show or SetVisible(true): cefsimple's explicit hidden pattern.
            if window.is_visible() != 0 { self.shared.fail("diagnostic window unexpectedly visible"); }
        }
        fn can_close(&self, _window: Option<&mut Window>) -> i32 {
            let browser = lock(&self.shared.handles).browser.clone();
            browser.and_then(|b| b.host()).map_or(1, |h| h.try_close_browser())
        }
        fn on_window_destroyed(&self, _window: Option<&mut Window>) {
            let removed = { let mut handles = lock(&self.shared.handles); handles.evidence.window = Stage::Closed; (handles.window.take(), handles.view.take()) };
            drop(removed);
        }
        fn on_window_activation_changed(&self, _window: Option<&mut Window>, active: i32) {
            if active != 0 { lock(&self.shared.handles).evidence.activated = true; self.shared.fail("hidden diagnostic window activated"); }
        }
    }
}
cef::wrap_permission_handler! {
    struct DenyPermissions;
    impl PermissionHandler {
        fn on_request_media_access_permission(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, _requesting_origin: Option<&CefString>, _requested_permissions: u32, callback: Option<&mut MediaAccessCallback>) -> i32 {
            if let Some(callback) = callback { callback.cancel(); } 1
        }
        fn on_show_permission_prompt(&self, _browser: Option<&mut Browser>, _prompt_id: u64, _requesting_origin: Option<&CefString>, _requested_permissions: u32, callback: Option<&mut PermissionPromptCallback>) -> i32 {
            if let Some(callback) = callback { callback.cont(PermissionRequestResult::DISMISS); } 1
        }
    }
}
cef::wrap_download_handler! {
    struct DenyDownloads;
    impl DownloadHandler {
        fn can_download(&self, _browser: Option<&mut Browser>, _url: Option<&CefString>, _request_method: Option<&CefString>) -> i32 { 0 }
        fn on_before_download(&self, _browser: Option<&mut Browser>, _download_item: Option<&mut DownloadItem>, _suggested_name: Option<&CefString>, _callback: Option<&mut BeforeDownloadCallback>) -> i32 { 1 }
    }
}
cef::wrap_dialog_handler! {
    struct DenyDialogs;
    impl DialogHandler {
        fn on_file_dialog(&self, _browser: Option<&mut Browser>, _mode: FileDialogMode, _title: Option<&CefString>, _default_file_path: Option<&CefString>, _accept_filters: Option<&mut CefStringList>, _accept_extensions: Option<&mut CefStringList>, _accept_descriptions: Option<&mut CefStringList>, callback: Option<&mut FileDialogCallback>) -> i32 {
            if let Some(callback) = callback { callback.cancel(); } 1
        }
    }
}
cef::wrap_focus_handler! {
    struct DenyFocus;
    impl FocusHandler { fn on_set_focus(&self, _browser: Option<&mut Browser>, _source: FocusSource) -> i32 { 1 } }
}
fn allowed_navigation(url: &str) -> bool {
    url == "about:blank" || url == "chrome://ignore/" || url.starts_with("chrome://settings/")
}
cef::wrap_resource_request_handler! {
    struct DenyExternal;
    impl ResourceRequestHandler {
        fn on_protocol_execution(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, _request: Option<&mut Request>, allow_os_execution: Option<&mut i32>) {
            if let Some(allow) = allow_os_execution { *allow = 0; }
        }
    }
}
cef::wrap_request_handler! {
    struct Requests;
    impl RequestHandler {
        fn on_before_browse(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, request: Option<&mut Request>, _user_gesture: i32, _is_redirect: i32) -> i32 {
            i32::from(!request.is_some_and(|r| allowed_navigation(&CefString::from(&r.url()).to_string())))
        }
        fn resource_request_handler(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, _request: Option<&mut Request>, _is_navigation: i32, _is_download: i32, _request_initiator: Option<&CefString>, _disable_default_handling: Option<&mut i32>) -> Option<ResourceRequestHandler> { Some(DenyExternal::new()) }
    }
}
cef::wrap_client! {
    struct DiagnosticClient { shared: Arc<Shared> }
    impl Client {
        fn life_span_handler(&self) -> Option<LifeSpanHandler> { Some(Life::new(self.shared.clone())) }
        fn permission_handler(&self) -> Option<PermissionHandler> { Some(DenyPermissions::new()) }
        fn download_handler(&self) -> Option<DownloadHandler> { Some(DenyDownloads::new()) }
        fn dialog_handler(&self) -> Option<DialogHandler> { Some(DenyDialogs::new()) }
        fn focus_handler(&self) -> Option<FocusHandler> { Some(DenyFocus::new()) }
        fn request_handler(&self) -> Option<RequestHandler> { Some(Requests::new()) }
    }
}

pub(super) struct Hidden {
    shared: Arc<Shared>,
    pub session: CdpSession,
    established: bool,
}
impl Hidden {
    pub async fn create(
        app: &tauri::AppHandle<Runtime>,
        context: RequestContext,
        path: PathBuf,
    ) -> Result<Self, AppError> {
        if !cfg!(target_os = "macos") {
            return Err(AppError::new(
                "hidden Chrome Views probe is qualified for macOS only",
            ));
        }
        let shared = Arc::new(Shared {
            handles: Mutex::default(),
            session: OnceLock::new(),
            context,
            path,
            closing: AtomicBool::new(false),
        });
        let session = CdpSession::new(Wire {
            app: app.clone(),
            shared: Arc::downgrade(&shared),
        });
        let _ = shared.session.set(session.clone());
        let creating = shared.clone();
        let result = on_main(app, move |_| {
            if creating.closing.load(Ordering::Acquire) {
                return Err(AppError::new("hidden creation cancelled before dispatch"));
            }
            let mut client = DiagnosticClient::new(creating.clone());
            let mut delegate = ProbeBrowserDelegate::new();
            let mut context = creating.context.clone();
            let view = cef::browser_view_create(
                Some(&mut client),
                Some(&CefString::from("")),
                Some(&BrowserSettings::default()),
                None,
                Some(&mut context),
                Some(&mut delegate),
            )
            .ok_or_else(|| AppError::new("Chrome BrowserView creation failed"))?;
            if creating.closing.load(Ordering::Acquire) {
                drop(view);
                return Err(AppError::new(
                    "hidden creation cancelled before window creation",
                ));
            }
            lock(&creating.handles).view = Some(view);
            let mut window_delegate = WindowCallbacks::new(creating.clone());
            cef::window_create_top_level(Some(&mut window_delegate))
                .ok_or_else(|| AppError::new("hidden Chrome window creation failed"))?;
            Ok(())
        })
        .await;
        let mut hidden = Self {
            shared,
            session,
            established: false,
        };
        let result = match result {
            Ok(()) => tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let ready = {
                        let handles = lock(&hidden.shared.handles);
                        if let Some(error) = &handles.error {
                            return Err(AppError::new(error));
                        }
                        handles.browser.is_some()
                            && handles.window.is_some()
                            && handles.registration.is_some()
                    };
                    if ready {
                        return Ok(());
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            })
            .await
            .map_err(|_| AppError::new("hidden browser creation callback timeout"))
            .and_then(std::convert::identity),
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            let cleanup = hidden.close(app).await;
            return Err(AppError::new(format!(
                "hidden creation: {error}; cleanup={cleanup:?}"
            )));
        }
        hidden.established = true;
        Ok(hidden)
    }
    pub async fn navigate(&self, app: &tauri::AppHandle<Runtime>) -> Result<(), AppError> {
        let shared = self.shared.clone();
        on_main(app, move |_| {
            let browser = shared.validate()?;
            let frame = browser
                .main_frame()
                .ok_or_else(|| AppError::new("hidden frame missing"))?;
            frame.load_url(Some(&CefString::from(super::SETTINGS)));
            Ok(())
        })
        .await
    }
    pub async fn evidence(&self, app: &tauri::AppHandle<Runtime>) -> Result<Json, AppError> {
        let shared = self.shared.clone();
        on_main(app, move |_| {
            let browser = shared.validate()?;
            Ok(json!({"browser_id":browser.identifier(),"chrome":true,"shared_context":true,"visible":false,
                "url":browser.main_frame().map(|f| CefString::from(&f.url()).to_string()),"loading":browser.is_loading()}))
        }).await
    }
    pub async fn close(&self, app: &tauri::AppHandle<Runtime>) -> Result<(), AppError> {
        self.shared.closing.store(true, Ordering::Release);
        let shared = self.shared.clone();
        on_main(app, move |_| {
            let (browser, window, unparented) = {
                let mut handles = lock(&shared.handles);
                let unparented = if handles.window.is_none() {
                    handles.view.take()
                } else {
                    None
                };
                (handles.browser.clone(), handles.window.clone(), unparented)
            };
            // Break the BrowserView -> client -> Shared ownership cycle even if
            // no top-level Window was ever created. Native drops occur off-lock.
            drop(unparented);
            if let Some(host) = browser.and_then(|b| b.host()) {
                host.close_browser(1);
            }
            if let Some(window) = window {
                window.close();
            }
            Ok(())
        })
        .await?;
        tokio::time::timeout(Duration::from_secs(10), async {
            while !{
                let handles = lock(&self.shared.handles);
                if self.established {
                    handles.evidence.closed()
                } else {
                    handles.evidence.disposed()
                }
            } {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .map_err(|_| AppError::new("hidden cleanup missing OnBeforeClose or OnWindowDestroyed"))?;
        if self.established {
            println!("DIVE_PERMISSION_WEBUI_PHASE: hidden browser and window destroyed");
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn live() -> Evidence {
        Evidence {
            browser: Stage::Live,
            window: Stage::Live,
            activated: false,
        }
    }
    #[test]
    fn service_dispatch_rejects_visible_wrong_runtime_or_context() {
        let clean = live();
        assert!(clean.check_hidden(false, true, true).is_ok());
        for (visible, chrome, shared) in [
            (true, true, true),
            (false, false, true),
            (false, true, false),
        ] {
            assert!(clean.check_hidden(visible, chrome, shared).is_err());
        }
        let activated = Evidence {
            activated: true,
            ..live()
        };
        assert!(activated.check_hidden(false, true, true).is_err());
        assert!(Evidence::default().check_hidden(false, true, true).is_err());
    }
    #[test]
    fn native_policy_denies_external_execution_downloads_and_escaped_navigation() {
        let handler = DenyExternal::new();
        let mut allow = 1;
        handler.on_protocol_execution(None, None, None, Some(&mut allow));
        assert_eq!(allow, 0);
        assert_eq!(DenyDownloads::new().can_download(None, None, None), 0);
        for url in [
            "https://example.com",
            "web+diveordinary:test",
            "chrome://settings.evil/",
            "file:///tmp/probe",
        ] {
            assert!(!allowed_navigation(url));
        }
        assert!(allowed_navigation(super::super::SETTINGS));
    }
    #[test]
    fn partial_creation_requires_receipts_only_for_objects_that_existed() {
        assert!(Evidence::default().disposed());
        let mut browser_only = Evidence {
            browser: Stage::Live,
            ..Default::default()
        };
        assert!(!browser_only.disposed());
        browser_only.browser = Stage::Closed;
        assert!(browser_only.disposed());
        assert!(!browser_only.closed());
        let window_only = Evidence {
            window: Stage::Closed,
            ..Default::default()
        };
        assert!(window_only.disposed());
        assert!(!window_only.closed());
    }
    #[test]
    fn cleanup_requires_both_native_receipts_in_either_order() {
        let mut evidence = live();
        evidence.browser = Stage::Closed;
        assert!(!evidence.closed());
        assert!(!evidence.disposed());
        evidence.window = Stage::Closed;
        assert!(evidence.closed());
        let mut reverse = Evidence {
            window: Stage::Closed,
            ..live()
        };
        assert!(!reverse.closed());
        reverse.browser = Stage::Closed;
        assert!(reverse.closed());
    }
}
