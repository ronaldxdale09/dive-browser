//! Engine layer: the main window, the chrome webview and one child webview
//! per open tab. Everything here talks to Tauri; nothing knows about React.

use std::collections::HashMap;
use std::path::PathBuf;

use dive_cdp::CdpSession;
use dive_core::{Container, CoreEvent, Tab, TabId, VisitChange};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::webview::WebviewBuilder;
use tauri::{App, AppHandle, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl, Window};
use tauri_specta::Event;

/// The chrome's ground colour (`--color-ground` in styles.css). Every window
/// and chrome webview is painted with it before the page has drawn, so a
/// window never shows through to what is behind it or flashes white while it
/// is created, resized or moved.
const GROUND: tauri::utils::config::Color = tauri::utils::config::Color(0x11, 0x11, 0x11, 0xFF);

use crate::state::{AppState, lock};
use crate::{CHROME_LABEL, MAIN_WINDOW, Runtime};

mod downloads;
mod popout;
mod window_geometry;
mod zoom;

#[cfg(feature = "cef")]
pub use downloads::watch_download_progress;
pub use downloads::{DownloadNotice, DownloadProgress, downloads_dir, unique_path};
pub use window_geometry::{
    WINDOW_BOUNDS, WindowBounds, remember_window_bounds, remember_window_bounds_throttled,
    visible_position, windowed_bounds,
};
pub use zoom::TabZoom;

use downloads::handle_download;
use popout::Popout;
use window_geometry::screen_areas;
#[cfg(feature = "cef")]
use zoom::{SITE_ZOOM_ATTEMPTS, SiteZoomState, schedule_site_zoom};

/// Ordinary bindings stay within main; detach explicitly selects its cross-window route.
#[cfg(any(all(feature = "cef", target_os = "macos"), test))]
fn new_tab_chrome_label(window: &str) -> Option<&'static str> {
    (window == MAIN_WINDOW).then_some(CHROME_LABEL)
}

/// Configure native routing outside keyboard callbacks. Only weak native
/// handles cross these callbacks; key delivery never locks `AppState` or scans
/// the app's webview registry.
#[cfg(all(feature = "cef", target_os = "macos"))]
fn refresh_new_tab_shortcut(view: &Webview<Runtime>, window: &Window<Runtime>) {
    let Some(chrome_label) = new_tab_chrome_label(window.label()) else {
        if let Err(error) = view.with_webview(|native| native.set_new_tab_shortcut_target(None)) {
            tracing::warn!(%error, "clearing native New Tab target failed");
        }
        return;
    };
    let Some(chrome) = window
        .webviews()
        .into_iter()
        .find(|view| view.label() == chrome_label)
    else {
        tracing::warn!("main chrome unavailable for native New Tab target");
        return;
    };
    let page = view.clone();
    if let Err(error) = chrome.with_webview(move |native_chrome| {
        let target = native_chrome.new_tab_shortcut_target();
        if let Err(error) = page.with_webview(move |native_page| {
            if !native_page.set_address_shortcut_target(target.clone()) {
                tracing::warn!("main page Address route no longer matches native window");
            }
            native_page.set_new_tab_shortcut_target(Some(target));
        }) {
            tracing::warn!(%error, "binding native New Tab target failed");
        }
    }) {
        tracing::warn!(%error, "reading native New Tab target failed");
    }
}

/// The detached page and its chrome share an explicit source-window anchor.
/// Configuration can be queued; native binding refuses a page that moved away
/// before this callback, and all reparent epochs are checked again on key input.
#[cfg(all(feature = "cef", target_os = "macos"))]
fn bind_detached_new_tab_shortcuts(
    page: &Webview<Runtime>,
    popout_chrome: &Webview<Runtime>,
    main: &Window<Runtime>,
) {
    let Some(chrome) = main
        .webviews()
        .into_iter()
        .find(|view| view.label() == CHROME_LABEL)
    else {
        tracing::warn!("main chrome unavailable for detached New Tab target");
        return;
    };
    let page = page.clone();
    let popout = popout_chrome.clone();
    if let Err(error) = chrome.with_webview(move |native_chrome| {
        let target = native_chrome.new_tab_shortcut_target();
        if let Err(error) = popout.with_webview(move |native_popout| {
            let anchor = native_popout.new_tab_shortcut_target();
            if !native_popout.set_address_shortcut_target(anchor.clone()) {
                tracing::warn!("popout Address route no longer matches native window");
            }
            if !native_popout.set_detached_new_tab_shortcut_target(anchor.clone(), target.clone()) {
                tracing::warn!("popout New Tab route no longer matches native windows");
            }
            if let Err(error) = page.with_webview(move |native_page| {
                if !native_page.set_address_shortcut_target(anchor.clone()) {
                    tracing::warn!("detached page Address route no longer matches native window");
                }
                if !native_page.set_detached_new_tab_shortcut_target(anchor, target) {
                    tracing::warn!("detached page New Tab route no longer matches native windows");
                }
            }) {
                tracing::warn!(%error, "binding detached page New Tab target failed");
            }
        }) {
            tracing::warn!(%error, "binding popout chrome New Tab target failed");
        }
    }) {
        tracing::warn!(%error, "reading detached New Tab target failed");
    }
}

/// Rectangle of the content area in logical pixels, relative to the window.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
pub struct Bounds {
    /// Left edge.
    pub x: f64,
    /// Top edge.
    pub y: f64,
    /// Width.
    pub width: f64,
    /// Height.
    pub height: f64,
}

/// Painted shape of a floating chrome surface, in CSS logical pixels.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
pub struct OverlayRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub radius: f64,
}

impl Bounds {
    fn position(self) -> LogicalPosition<f64> {
        LogicalPosition::new(self.x, self.y)
    }

    fn size(self) -> LogicalSize<f64> {
        LogicalSize::new(self.width.max(1.0), self.height.max(1.0))
    }
}

/// Owns the child webviews for open tabs.
/// Proof that the caller is on the main thread.
///
/// Creating or showing a native view has to happen there: from any other
/// thread CEF takes the process down, and a caller that holds the host lock
/// while it waits for the main thread deadlocks against the chrome's own
/// commands. [`TabHost::open`] and [`TabHost::activate`] therefore demand
/// this token, which can only be minted on the main thread and cannot be
/// sent off it.
#[derive(Debug)]
pub struct MainThread(std::marker::PhantomData<*const ()>);

impl MainThread {
    /// Claim the token, if this is the main thread. Only `run_on_main_thread`
    /// closures and the setup code in `run()` qualify: under CEF every Tauri
    /// IPC command, sync or async, arrives on a worker thread (see
    /// CONTRIBUTING.md, "Threading"), and a tokio task never does.
    pub fn here() -> Option<Self> {
        is_main_thread().then_some(Self(std::marker::PhantomData))
    }
}

static MAIN_THREAD: std::sync::OnceLock<std::thread::ThreadId> = std::sync::OnceLock::new();

/// Remember the calling thread as the main thread. Called once at startup;
/// until then (unit tests) every thread counts as main.
pub fn mark_main_thread() {
    let _ = MAIN_THREAD.set(std::thread::current().id());
}

fn is_main_thread() -> bool {
    MAIN_THREAD
        .get()
        .is_none_or(|id| *id == std::thread::current().id())
}

/// The tab a view label names, if it is one of ours.
pub fn tab_from_label(label: &str) -> Option<TabId> {
    let value = label.strip_prefix("tab-")?;
    // Accept legacy labels as well as UUID + numeric renderer generation.
    if let Ok(id) = value.parse() {
        return Some(id);
    }
    let (id, generation) = value.rsplit_once('-')?;
    generation.parse::<u64>().ok()?;
    id.parse().ok()
}

pub struct TabHost {
    window: Window<Runtime>,
    views: HashMap<TabId, Webview<Runtime>>,
    cdp: HashMap<TabId, CdpSession>,
    bounds: Bounds,
    active: Option<TabId>,
    profiles_root: PathBuf,
    /// A DOM overlay (dialog, menu, popover) is on screen. Child webviews
    /// always paint above the main webview, so the active view is hidden for
    /// as long as one is up, otherwise the overlay is buried behind the page.
    covered: bool,
    /// Whether the chrome was already given focus for the current cover.
    /// `apply_visibility` runs on every overlay region update, and focus
    /// belongs to the moment the page becomes covered, not to each frame.
    focused_for_cover: std::cell::Cell<bool>,
    live_overlays: HashMap<String, (Vec<OverlayRegion>, bool)>,
    /// The main chrome's overlays are all passive (a tooltip, the save-login
    /// card): they sit over the page without taking the keyboard from it.
    passive_cover: bool,
    /// Corner radius of page views in the main window, in logical pixels,
    /// following the chrome's corner preference. Zero is square.
    corner_radius: f64,
    /// Split view: tabs shown side by side, each at its own rectangle. Empty
    /// means the active tab alone fills the content area.
    panes: Vec<PaneBounds>,
    /// Tabs torn off into their own window. Their views are children of that
    /// window, not the main one, so the main layout leaves them alone.
    popouts: HashMap<TabId, Popout>,
    /// Popouts that are installed-app windows, by the app they show.
    app_windows: HashMap<TabId, String>,
    /// Tabs whose page is one of Dive's own (`dive://…`), drawn by the chrome
    /// in the content area: they have no native view at all.
    internal: std::collections::HashSet<TabId>,
    /// Tabs whose page was asked to close and can still refuse.
    closing: CloseRequests,
}

/// Tabs whose page was asked to close the way a person closes a tab, by the
/// label of the view that was asked. The tab stays until that very view says
/// it is going: a view rebuilt meanwhile, or closed by force for another
/// reason, answers for a different page and must not take the tab with it.
#[derive(Debug, Default)]
struct CloseRequests(HashMap<TabId, String>);

impl CloseRequests {
    fn ask(&mut self, tab: TabId, label: &str) {
        self.0.insert(tab, label.to_owned());
    }

    /// Whether `label`'s close was the one asked for; forgets it when it was.
    fn take(&mut self, tab: TabId, label: &str) -> bool {
        if self.0.get(&tab).is_some_and(|asked| asked == label) {
            self.0.remove(&tab);
            return true;
        }
        false
    }

    fn cancel(&mut self, tab: TabId) {
        self.0.remove(&tab);
    }
}

/// Scheme of Dive's built-in pages.
pub const INTERNAL_SCHEME: &str = "dive";

/// One pane of a split view: which tab, and where it sits.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
pub struct PaneBounds {
    /// The tab shown in the pane.
    pub tab: TabId,
    /// Its rectangle, relative to the main window.
    pub bounds: Bounds,
}

#[derive(Default)]
struct PopoutAddressFocus {
    requested: bool,
    applied: bool,
}

impl PopoutAddressFocus {
    fn request(&mut self) {
        self.requested = true;
    }

    fn ready<E>(&mut self, focus: impl FnOnce() -> Result<(), E>) -> Result<bool, E> {
        if !self.requested {
            return Ok(false);
        }
        if !self.applied {
            focus()?;
            self.applied = true;
        }
        Ok(true)
    }
}

/// Numbers popout windows so a tab torn off, brought back and torn off
/// again never reuses a label the runtime may still be tearing down.
static POPOUT_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Height of a detached window's tab strip and navigation toolbar until its
/// chrome reports the exact content rectangle.
const POPOUT_CHROME_HEIGHT: f64 = 84.0;

fn popout_content_bounds(width: f64, height: f64) -> Bounds {
    Bounds {
        x: 0.0,
        y: POPOUT_CHROME_HEIGHT,
        width,
        height: (height - POPOUT_CHROME_HEIGHT).max(1.0),
    }
}

/// Give restored pages a usable viewport before React reports exact layout.
/// The chrome later owns panel/split geometry; starting at 1x1 makes sites
/// initialize against a tiny viewport and immediately repeat responsive layout.
fn main_content_bounds(width: f64, height: f64, expanded_rail: bool) -> Bounds {
    // Match App's 40px title row, 44px toolbar, and Rail's responsive policy.
    let rail = if expanded_rail && width >= 960.0 {
        208.0
    } else {
        52.0
    };
    Bounds {
        x: rail,
        y: 84.0,
        width: (width - rail).max(1.0),
        height: (height - 84.0).max(1.0),
    }
}

/// How an installed web app's window differs from a torn-off tab's: it is
/// titled after the app, opens at the frame it last had, and its chrome is
/// the app chrome rather than the popout's tab strip.
#[derive(Debug, Clone)]
pub struct AppWindowSpec {
    /// The installed app's manifest id, carried to the chrome in the URL.
    pub id: String,
    /// Window title.
    pub name: String,
    /// The last windowed frame, when the app has been opened before.
    pub bounds: Option<WindowBounds>,
}

/// Window label for the `seq`th popout, holding `id`.
fn popout_label(seq: u64, id: TabId) -> String {
    format!("pop-{seq}-{id}")
}

/// The https address this navigation should be sent to instead, if the
/// setting is on and the address is not the person's own machine.
///
/// The settings are read from the mirror rather than the preference store:
/// this runs on the engine's thread with a navigation waiting on it.
fn upgrade_to_https(
    app: &tauri::AppHandle<Runtime>,
    tab_id: TabId,
    url: &url::Url,
) -> Option<url::Url> {
    let _ = app;
    let secure = crate::https_only::upgrade_now(url.as_str())?;
    let secure = url::Url::parse(&secure).ok()?;
    if let Some(host) = url.host_str() {
        crate::https_only::note(tab_id, host);
    }
    Some(secure)
}

/// The tab a popout window label belongs to, if it is one.
pub fn popout_tab(label: &str) -> Option<TabId> {
    let (_, id) = label.strip_prefix("pop-")?.split_once('-')?;
    id.parse().ok()
}

/// Hear when `view`'s page lets go of a close it was asked for. CEF reports
/// it from inside its own close callback on the main thread, where
/// `run_on_main_thread` would call straight through and re-enter the
/// runtime, so the tab is let go from a task that hops back.
#[cfg(feature = "cef")]
fn attach_close_listener(app: &AppHandle<Runtime>, tab_id: TabId, view: &Webview<Runtime>) {
    let app = app.clone();
    let label = view.label().to_owned();
    let _ = view.with_webview(move |native| {
        native.set_close_handler(move || {
            let app = app.clone();
            let label = label.clone();
            tauri::async_runtime::spawn(async move {
                let hop = app.clone();
                let _ = hop.run_on_main_thread(move || {
                    crate::commands::page_agreed_to_close(&app, tab_id, &label);
                });
            });
        });
    });
}

impl TabHost {
    fn new(window: Window<Runtime>, profiles_root: PathBuf, bounds: Bounds) -> Self {
        Self {
            window,
            views: HashMap::new(),
            cdp: HashMap::new(),
            bounds,
            active: None,
            profiles_root,
            covered: false,
            focused_for_cover: std::cell::Cell::new(false),
            live_overlays: HashMap::new(),
            passive_cover: false,
            corner_radius: 0.0,
            panes: Vec::new(),
            popouts: HashMap::new(),
            app_windows: HashMap::new(),
            internal: std::collections::HashSet::new(),
            closing: CloseRequests::default(),
        }
    }

    /// Create the engine view for `tab` inside `container`'s profile.
    #[allow(clippy::too_many_lines)] // One builder owns the lifecycle callbacks for one native view.
    pub fn open(
        &mut self,
        _main: &MainThread,
        app: &AppHandle<Runtime>,
        tab: &Tab,
        container: &Container,
    ) -> tauri::Result<()> {
        let url: url::Url = tab
            .url
            .parse()
            .map_err(|_| tauri::Error::InvalidUrl(url::ParseError::RelativeUrlWithoutBase))?;
        let tab_id = tab.id;
        if url.scheme() == INTERNAL_SCHEME {
            // Drawn by the chrome; nothing native to create. Registered so
            // activation treats it as present.
            self.internal.insert(tab_id);
            return Ok(());
        }

        #[cfg(feature = "cef")]
        let permission_workspace = tab
            .workspace_id
            .or(*lock(&app.state::<AppState>().active_workspace));
        #[cfg(feature = "cef")]
        let permission_container = container.id;
        let activity = app.state::<AppState>().activity.clone();
        let activity_nonce = activity.begin(tab_id);
        let blank = url::Url::parse(BLANK_URL).map_err(tauri::Error::InvalidUrl)?;
        let title_app = app.clone();
        let title_nonce = activity_nonce.clone();
        #[allow(unused_mut)]
        let mut builder = WebviewBuilder::new(label_for(tab_id), WebviewUrl::External(blank))
            .data_directory(if crate::private_session::is_private() {
                self.profiles_root.join("private-session")
            } else {
                self.profiles_root.join(&container.cache_dir)
            })
            // A container that does not keep cookies is a private session:
            // the engine holds its storage in memory and drops it with the
            // last view.
            .incognito(crate::private_session::is_private() || !container.persist_cookies)
            .on_document_title_changed(move |_, title| {
                if title == PLACEHOLDER_TITLE {
                    return;
                }
                // `try_lock`: this fires from the engine, and must never wait
                // on a command that holds the host.
                if let Ok(host) = title_app.state::<AppState>().host.try_lock()
                    && let Some(host) = host.as_ref()
                {
                    host.retitle_popout(tab_id, &title);
                }
                // Off the engine's stack: the store write and the event to
                // the chrome must not re-enter CEF from inside its callback.
                // On a blocking thread, since the write is SQLite.
                let app = title_app.clone();
                let nonce = title_nonce.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    update_session_tab(&app, tab_id, &nonce, |t| t.title = title);
                });
            });

        // A link that asks for a new window becomes a tracked tab: CEF's
        // default is an unmanaged native popup with no Dive tab, lifecycle or
        // MCP session. Cancel it and defer a normal tab open to the event loop
        // instead of re-entering CEF from its callback.
        //
        // A *sized* `window.open()` is the exception. That is the shape of a
        // sign-in or share window, and those only work as real popups: the new
        // page needs `window.opener` to post its result back to the page that
        // opened it and to close itself when it is done. Re-opened as a tab it
        // has no opener, so the sign-in never returns and the tab stays behind
        // -- the row of stranded "Sign In - Google Accounts" tabs. CEF creates
        // it instead, inheriting this view's request context, so the popup
        // shares the profile's cookies.
        let popup_app = app.clone();
        let popup_workspace = tab.workspace_id;
        builder = builder.on_new_window(move |url, features| {
            if is_popup_window(&url, features.size().is_some()) {
                return tauri::webview::NewWindowResponse::Allow;
            }
            // Another app's link -- `mailto:` in a new window is common -- is
            // put to the person exactly as it is when the page follows it in
            // place, rather than as a tab that could only fail to load it.
            if crate::external_link::is_external(&url) {
                let app = popup_app.clone();
                tauri::async_runtime::spawn(async move {
                    let origin = current_page_host(&app, tab_id);
                    let on_main = app.clone();
                    let _ = on_main.run_on_main_thread(move || {
                        crate::external_link::intercept(&app, tab_id, &url, &origin);
                    });
                });
                return tauri::webview::NewWindowResponse::Deny;
            }
            // The page chose this address, and a new tab is opened by Dive
            // on its behalf: a `file:` page, a Dive page or `javascript:` is
            // somewhere a page could not have navigated itself.
            if !is_web_link(&url) {
                tracing::debug!(
                    scheme = url.scheme(),
                    "refused a new window outside the web"
                );
                return tauri::webview::NewWindowResponse::Deny;
            }
            let app = popup_app.clone();
            tauri::async_runtime::spawn(async move {
                let schedule = app.clone();
                if let Err(error) = app.run_on_main_thread(move || {
                    let Some(main) = MainThread::here() else {
                        tracing::warn!(origin = %crate::diagnostics::loggable_url(url.as_str()), "popup open reached the wrong thread");
                        return;
                    };
                    let Some(workspace) = popup_workspace else {
                        tracing::warn!(origin = %crate::diagnostics::loggable_url(url.as_str()), "popup source has no workspace");
                        return;
                    };
                    let state = schedule.state::<AppState>();
                    if let Err(error) =
                        crate::commands::open_tab(&main, &schedule, &state, workspace, url.as_str())
                    {
                        tracing::warn!(origin = %crate::diagnostics::loggable_url(url.as_str()), %error, "opening popup as a tab failed");
                    }
                }) {
                    tracing::warn!(%error, "queueing popup tab failed");
                }
            });
            tauri::webview::NewWindowResponse::Deny
        });

        // A scheme the engine does not speak belongs to another app. Letting
        // the navigation through ends at Chromium's ERR_UNKNOWN_URL_SCHEME
        // page; the person is asked instead, off the engine's stack.
        let external_app = app.clone();
        builder = builder.on_navigation(move |url| {
            // Before anything else: a page asked for in the clear is asked
            // for again over https, unless it is the person's own machine.
            if let Some(secure) = upgrade_to_https(&external_app, tab_id, url) {
                let app = external_app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = app.clone().run_on_main_thread(move || {
                        let state = app.state::<AppState>();
                        let sent = lock(&state.host)
                            .as_ref()
                            .map(|host| host.navigate(tab_id, secure.clone()));
                        match sent {
                            Some(Err(error)) => {
                                tracing::warn!(%error, "https upgrade could not be sent");
                            }
                            None => tracing::warn!("https upgrade arrived before the engine"),
                            Some(Ok(())) => {}
                        }
                    });
                });
                return false;
            }
            if !crate::external_link::is_external(url) {
                return true;
            }
            let app = external_app.clone();
            let url = url.clone();
            tauri::async_runtime::spawn(async move {
                let origin = current_page_host(&app, tab_id);
                let on_main = app.clone();
                let _ = on_main.run_on_main_thread(move || {
                    crate::external_link::intercept(&app, tab_id, &url, &origin);
                });
            });
            false
        });

        let dl_app = app.clone();
        let dl_nonce = activity_nonce.clone();
        builder = builder.on_download(move |_, event| {
            handle_download(&dl_app, event, Some((tab_id, &dl_nonce)))
        });

        #[cfg(feature = "cef")]
        {
            let nav_app = app.clone();
            let nav_nonce = activity_nonce.clone();
            // This view's zoom bookkeeping: which site it was last put at,
            // and a count of its address changes, so a deferred zoom that
            // lands after a newer navigation's knows to stand aside.
            let zoom = SiteZoomState::default();
            builder = builder.on_address_change(move |_, url| {
                nav_app
                    .state::<AppState>()
                    .activity
                    .changed(tab_id, &nav_nonce);
                // Views start on about:blank; that hop must not replace the
                // tab's real URL or a restart would restore an empty tab.
                if url.as_str() == BLANK_URL {
                    return;
                }
                let url = url.to_string();
                // Deferred a loop turn: zoom talks to the engine, and the
                // store write emits to the chrome; neither belongs inside
                // the callback that reported the navigation. This callback
                // already runs on the main thread, where `run_on_main_thread`
                // calls straight through, so the hop is made from a task,
                // as the navigation handlers above do. Tasks may land out
                // of order; only the newest address's zoom is applied.
                let epoch = zoom
                    .epoch
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                    + 1;
                // A move within the site keeps the zoom the view already has
                // -- the engine keeps it per host -- so a single-page app
                // changing its address on every click costs nothing here.
                let key = crate::site_zoom::key_of(&url);
                if lock(&zoom.applied).as_deref() != Some(key.as_str()) {
                    schedule_site_zoom(
                        nav_app.clone(),
                        tab_id,
                        key,
                        zoom.clone(),
                        epoch,
                        SITE_ZOOM_ATTEMPTS,
                    );
                }
                let app = nav_app.clone();
                let nonce = nav_nonce.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    update_session_tab(&app, tab_id, &nonce, |t| {
                        t.url = reported_url(&t.url, url);
                    });
                });
            });
        }

        // A replacement for a detached page is admitted directly into its
        // final owner; pending native views cannot be reparented synchronously.
        let owner = self
            .popouts
            .get(&tab_id)
            .map_or(&self.window, |popout| &popout.window);
        let view = owner.add_child(builder, self.bounds.position(), self.bounds.size())?;
        if let Err(error) = view.hide() {
            let _ = view.close();
            return Err(error);
        }
        #[cfg(all(feature = "cef", target_os = "macos"))]
        refresh_new_tab_shortcut(&view, &self.window);
        // The view starts blank so the DevTools feeds are listening before the
        // first navigation; otherwise the document request and early console
        // output are missed.
        #[cfg(feature = "cef")]
        {
            let session = match attach_cdp(&view, activity.clone(), tab_id, activity_nonce.clone())
            {
                Ok(session) => session,
                Err(error) => {
                    let _ = view.close();
                    return Err(error);
                }
            };
            app.state::<AppState>()
                .crashes
                .bind_view(tab_id, view.label());
            // `DIVE_DISABLE_FEEDS=1` leaves the DevTools session idle, to
            // tell an engine fault apart from one our own traffic provokes.
            let feeds = std::env::var_os("DIVE_DISABLE_FEEDS").is_none();
            // Every feed subscribes before this returns and enables nothing
            // itself; the domains are enabled once, below, for all of them.
            let (limits_tx, limits_rx) = tokio::sync::oneshot::channel();
            let (interception_ready, loading_ready) = if feeds {
                crate::console::attach(app.clone(), tab_id, session.clone());
                crate::network::attach(
                    app.clone(),
                    tab_id,
                    session.clone(),
                    activity_nonce.clone(),
                    limits_rx,
                );
                crate::favicon::attach(app.clone(), tab_id, session.clone());
                let loading = crate::loading::attach(app.clone(), tab_id, session.clone());
                let r =
                    crate::rules::attach(app.clone(), tab_id, tab.workspace_id, session.clone());
                crate::inspect::watch(app.clone(), tab_id, &session);
                crate::crash::watch(
                    app.clone(),
                    tab_id,
                    view.label().to_owned(),
                    session.clone(),
                );
                (r, loading)
            } else {
                let (rt, rr) = tokio::sync::oneshot::channel();
                let (lt, lr) = tokio::sync::oneshot::channel();
                let _ = (rt.send(()), lt.send(()));
                (rr, lr)
            };
            let session_for_prefs = session.clone();
            self.cdp.insert(tab_id, session);
            let nav = view.clone();
            let prefs_app = app.clone();
            tauri::async_runtime::spawn(async move {
                // One prelude per session: each domain enabled once, all of
                // them together. This used to be some two dozen round trips
                // made one after another, each through the main thread,
                // before a new tab could start loading.
                let limits =
                    crate::cdp_feed::enable_domains(tab_id, &session_for_prefs, feeds).await;
                let _ = limits_tx.send(limits);
                // Privacy preferences have to be in force before the document
                // request goes out, or the first load escapes them.
                let (prefs, chrome_scheme) = {
                    let state = prefs_app.state::<AppState>();
                    (state.prefs.get(&state), state.prefs.chrome_scheme())
                };
                // Everything the first document needs registered, sent
                // together. Each part issues its first call when first polled
                // and `join!` polls them in this order, so the page scripts
                // still register -- and so run at document start -- in the
                // order they always did.
                let s = &session_for_prefs;
                tokio::join!(
                    async {
                        let _ = interception_ready.await;
                    },
                    async {
                        let _ = loading_ready.await;
                    },
                    async {
                        if feeds {
                            crate::filltab::attach(prefs_app.clone(), tab_id, s.clone()).await;
                        }
                    },
                    async {
                        crate::privacy::attach_page(prefs_app.clone(), tab_id, s.clone()).await;
                        tracing::debug!(%tab_id, "privacy page setup complete before navigation");
                    },
                    async {
                        crate::permissions::attach_page(
                            prefs_app.clone(),
                            tab_id,
                            s.clone(),
                            nav.clone(),
                            permission_workspace,
                            permission_container,
                        )
                        .await;
                        tracing::debug!(%tab_id, "permission page setup complete before navigation");
                    },
                    crate::activity::attach(&activity, tab_id, &activity_nonce, s),
                    crate::credential_fill::attach(prefs_app.clone(), tab_id, s.clone()),
                    crate::form_fill::attach(prefs_app.clone(), tab_id, s.clone()),
                    crate::tab_audio::attach(prefs_app.clone(), tab_id, s.clone()),
                    crate::prefs::apply(s, &prefs, chrome_scheme.as_deref()),
                );
                tracing::debug!(%tab_id, "page setup complete before navigation");
                // A tab that was muted before it was discarded wakes up muted:
                // the view is new, and native mute belongs to the view.
                if crate::tab_audio::is_muted(tab_id) {
                    let app = prefs_app.clone();
                    let _ = prefs_app.run_on_main_thread(move || {
                        let Some(main) = MainThread::here() else {
                            return;
                        };
                        let state = app.state::<AppState>();
                        if let Some(host) = crate::state::lock(&state.host).as_ref() {
                            crate::tab_audio::apply(&main, host, tab_id, true);
                        }
                    });
                }
                if session_for_prefs.is_closed()
                    || !activity.session_current(tab_id, &activity_nonce)
                {
                    return;
                }
                if let Err(e) = nav.navigate(url) {
                    tracing::warn!(%tab_id, "initial navigation failed: {e}");
                }
            });
        }
        #[cfg(not(feature = "cef"))]
        view.navigate(url)?;
        {
            let state = app.state::<AppState>();
            let prefs = state.prefs.get(&state);
            if (prefs.default_zoom - 1.0).abs() > f64::EPSILON {
                let _ = view.set_zoom(prefs.default_zoom);
            }
            if prefs.devtools_on_open {
                view.open_devtools();
            }
        }
        Self::round_view(&view, self.corner_radius);
        #[cfg(feature = "cef")]
        crate::page_menu::attach(app, tab_id, &view, self.popouts.contains_key(&tab_id));
        #[cfg(feature = "cef")]
        crate::js_dialog::attach(app, tab_id, &view);
        #[cfg(feature = "cef")]
        attach_close_listener(app, tab_id, &view);
        #[cfg(feature = "cef")]
        crate::find::attach(tab_id, &view);
        #[cfg(feature = "cef")]
        crate::crash::attach(app, tab_id, &view);
        #[cfg(feature = "cef")]
        crate::cert_error::attach(app, tab_id, &view);
        self.views.insert(tab_id, view);
        // A pane whose page was asleep kept its place in the split. Its new
        // view starts over the whole content area and hidden, so it is moved
        // into its pane and shown there; otherwise the pane stayed blank until
        // the split's panes next changed, which clicking it never does.
        if self.panes.iter().any(|p| p.tab == tab_id) && !self.popouts.contains_key(&tab_id) {
            let b = self.rect_for(tab_id);
            if let Some(view) = self.views.get(&tab_id) {
                view.set_bounds(tauri::Rect {
                    position: b.position().into(),
                    size: b.size().into(),
                })?;
            }
            self.apply_visibility()?;
        }
        Ok(())
    }

    /// Round (or square) the corners of every page view in the main window.
    /// Popouts fill their own window and keep square corners.
    pub fn set_corner_radius(&mut self, radius: f64) {
        self.corner_radius = radius;
        for (tab, view) in &self.views {
            if !self.popouts.contains_key(tab) {
                Self::round_view(view, radius);
            }
        }
    }

    fn round_view(view: &Webview<Runtime>, radius: f64) {
        #[cfg(all(feature = "cef", target_os = "macos"))]
        {
            let _ = view.with_webview(move |native| {
                native.set_corner_radius(radius);
            });
        }
        #[cfg(not(all(feature = "cef", target_os = "macos")))]
        let _ = (view, radius);
    }

    /// `DevTools` protocol session for `id`, if the engine exposes one.
    pub fn cdp(&self, id: TabId) -> Option<CdpSession> {
        self.cdp.get(&id).cloned()
    }

    /// A stopped protocol session needs a new browser on explicit user retry.
    pub fn needs_protocol_rebuild(&self, id: TabId) -> bool {
        cfg!(feature = "cef")
            && !self.internal.contains(&id)
            && self.cdp.get(&id).is_none_or(CdpSession::is_closed)
    }

    /// Recreate only the page, retaining the tab, split placement and any
    /// detached window. Called on user navigation/retry, never automatically.
    pub fn rebuild_protocol_view(
        &mut self,
        main: &MainThread,
        app: &AppHandle<Runtime>,
        tab: &Tab,
        container: &Container,
    ) -> tauri::Result<()> {
        if let Some(view) = self.views.get(&tab.id) {
            view.close()?;
        }
        self.views.remove(&tab.id);
        self.closing.cancel(tab.id);
        self.open(main, app, tab, container)?;
        if self.popouts.contains_key(&tab.id)
            && let Some(view) = self.views.get(&tab.id)
        {
            #[cfg(all(feature = "cef", target_os = "macos"))]
            if let Some(chrome) = app.get_webview(&self.popouts[&tab.id].chrome) {
                bind_detached_new_tab_shortcuts(view, &chrome, &self.window);
            }
            view.show()?;
        }
        self.layout()?;
        self.apply_visibility()
    }

    /// Every live `DevTools` session, for changes that touch all open tabs.
    pub fn sessions(&self) -> Vec<(TabId, CdpSession)> {
        self.cdp.iter().map(|(id, s)| (*id, s.clone())).collect()
    }

    /// Forget sessions whose renderer has already closed. Their native view
    /// lifecycle may finish independently, but future global preference and
    /// rule updates must not keep addressing a dead CDP channel.
    pub fn prune_closed_sessions(&mut self) -> Vec<TabId> {
        let dead = self
            .cdp
            .iter()
            .filter_map(|(id, session)| session.is_closed().then_some(*id))
            .collect::<Vec<_>>();
        for id in &dead {
            self.cdp.remove(id);
        }
        dead
    }

    /// Whether a chrome overlay (dialog, menu, popover) is hiding the pages
    /// in the main window right now.
    pub fn covered(&self) -> bool {
        self.covered
    }

    /// `DevTools` sessions whose views are about to be hidden by a chrome
    /// overlay. Popout views live in other windows and are deliberately left
    /// alone.
    pub fn covered_sessions(&self) -> Vec<(TabId, CdpSession)> {
        self.on_screen()
            .into_iter()
            .filter_map(|id| self.cdp(id).map(|session| (id, session)))
            .collect()
    }

    /// Overlay scope follows the requesting chrome, never the active main tab.
    pub fn covered_sessions_for_chrome(&self, chrome: &str) -> Vec<(TabId, CdpSession)> {
        if chrome == CHROME_LABEL {
            return self.covered_sessions();
        }
        self.popouts
            .iter()
            .filter(|(_, popout)| popout.chrome == chrome)
            .filter_map(|(id, _)| self.cdp(*id).map(|session| (*id, session)))
            .collect()
    }

    pub fn set_chrome_covered(&mut self, chrome: &str, covered: bool) -> tauri::Result<()> {
        if chrome == CHROME_LABEL {
            return self.set_covered(covered);
        }
        let Some((id, popout)) = self
            .popouts
            .iter_mut()
            .find(|(_, popout)| popout.chrome == chrome)
        else {
            return Ok(());
        };
        popout.covered = covered;
        if let Some(view) = self.views.get(id) {
            if covered {
                view.hide()?;
            } else {
                view.show()?;
            }
        }
        Ok(())
    }

    /// Forget every overlay and cover `chrome` had up. Its document is new --
    /// reloaded after its renderer died, or booting -- so nothing it drew is
    /// on screen any more, and a page hidden under a dialog that no longer
    /// exists would otherwise stay hidden for good.
    pub fn reset_chrome_cover(&mut self, chrome: &str) -> tauri::Result<()> {
        if self.live_overlays.contains_key(chrome) {
            self.set_live_overlay(chrome, Vec::new(), false, false, false)?;
        }
        let covered = if chrome == CHROME_LABEL {
            self.covered
        } else {
            self.popouts
                .values()
                .any(|popout| popout.chrome == chrome && popout.covered)
        };
        if covered {
            self.set_chrome_covered(chrome, false)?;
        }
        Ok(())
    }

    /// Keep web content rendered while native chrome is masked above it.
    pub fn set_live_overlay(
        &mut self,
        chrome: &str,
        regions: Vec<OverlayRegion>,
        active: bool,
        modal: bool,
        take_focus: bool,
    ) -> tauri::Result<()> {
        let was_active = self.live_overlays.contains_key(chrome);
        if chrome == CHROME_LABEL {
            self.passive_cover = active && !take_focus;
        }
        if active {
            self.live_overlays
                .insert(chrome.to_owned(), (regions, modal));
        } else {
            self.live_overlays.remove(chrome);
        }
        if chrome == CHROME_LABEL {
            self.covered = active;
        }
        // `apply_visibility` rebuilds the mask for every live overlay itself,
        // so doing it here as well built the region twice and, on Windows,
        // repainted the whole chrome twice per frame of an animating menu.
        if chrome == CHROME_LABEL && was_active != active {
            // Windows must re-enable page input before apply_visibility
            // restores native focus. EnableWindow(false) rejects SetFocus.
            #[cfg(all(feature = "cef", target_os = "windows"))]
            if !active {
                self.update_overlay_mask(chrome, false)?;
            }
            self.apply_visibility()?;
        } else {
            // Animation only changes the mask. Do not re-show every tab and
            // restore Chromium accessibility trees on every animation frame.
            self.update_overlay_mask(chrome, active)?;
            // A menu or dialog opening while a passive card was already up
            // still needs the keyboard.
            if chrome == CHROME_LABEL {
                self.apply_cover_focus();
            }
            #[cfg(all(feature = "cef", target_os = "windows"))]
            if was_active && !active && chrome != CHROME_LABEL {
                for (id, popout) in &self.popouts {
                    if popout.chrome == chrome
                        && let Some(view) = self.views.get(id)
                    {
                        let _ = view.set_focus();
                    }
                }
            }
        }
        Ok(())
    }

    fn apply_cover_focus(&self) {
        match cover_focus_change(
            self.focused_for_cover.get(),
            self.covered,
            self.passive_cover,
        ) {
            Some(true) => self.focus_chrome(),
            Some(false) => {
                if let Some(view) = self.active.and_then(|id| self.views.get(&id)) {
                    let _ = view.set_focus();
                }
            }
            None => {}
        }
        self.focused_for_cover
            .set(self.covered && !self.passive_cover);
    }

    fn update_overlay_mask(&self, chrome: &str, active: bool) -> tauri::Result<()> {
        #[cfg(all(feature = "cef", any(target_os = "macos", target_os = "windows")))]
        {
            let page_ids = if chrome == CHROME_LABEL {
                self.on_screen()
                    .into_iter()
                    .filter(|id| !self.popouts.contains_key(id))
                    .collect::<Vec<_>>()
            } else {
                self.popouts
                    .iter()
                    .filter(|(_, popout)| popout.chrome == chrome)
                    .map(|(id, _)| *id)
                    .collect()
            };
            let pages = page_ids
                .iter()
                .filter(|id| self.views.contains_key(id))
                .map(|id| {
                    let b = self.rect_for(*id);
                    [b.x, b.y, b.width, b.height]
                })
                .collect::<Vec<_>>();
            let overlays = self
                .live_overlays
                .get(chrome)
                .into_iter()
                .flat_map(|(regions, _)| regions)
                .map(|b| {
                    [
                        b.x,
                        b.y,
                        b.width,
                        b.height,
                        b.radius.min(b.width / 2.0).min(b.height / 2.0),
                    ]
                })
                .collect::<Vec<_>>();
            // A modal overlay owns native input; a non-modal one only paints
            // over the page and must leave its clicks alone.
            let modal = active
                && self
                    .live_overlays
                    .get(chrome)
                    .is_some_and(|(_, modal)| *modal);
            if let Some(view) = self.window.app_handle().get_webview(chrome) {
                view.with_webview(move |native| {
                    #[cfg(target_os = "windows")]
                    if !native.set_chrome_modal_overlay(&pages, &overlays, active, modal) {
                        tracing::error!(
                            "native modal overlay entered recoverable page-cover fallback"
                        );
                    }
                    #[cfg(target_os = "macos")]
                    native.set_chrome_overlay_mask(&pages, &overlays, active, modal);
                })?;
            }
        }
        #[cfg(not(all(feature = "cef", any(target_os = "macos", target_os = "windows"))))]
        let _ = (chrome, active);
        Ok(())
    }

    /// Run `f` against the view for `id`.
    pub fn with_view<T>(
        &self,
        id: TabId,
        f: impl FnOnce(&Webview<Runtime>) -> tauri::Result<T>,
    ) -> tauri::Result<T> {
        match self.views.get(&id) {
            Some(view) => f(view),
            None => Err(tauri::Error::WebviewNotFound),
        }
    }

    /// Show `id` and hide every other tab view.
    pub fn activate(&mut self, _main: &MainThread, id: TabId) -> tauri::Result<()> {
        self.active = Some(id);
        self.apply_visibility()
    }

    /// Hide the page while a DOM overlay is up, and restore it afterwards.
    pub fn set_covered(&mut self, covered: bool) -> tauri::Result<()> {
        if self.covered == covered {
            return Ok(());
        }
        self.covered = covered;
        self.apply_visibility()
    }

    /// Show whatever the layout says is on screen unless an overlay covers
    /// it; hide every other view. Popouts live in their own window and are
    /// never touched here.
    fn apply_visibility(&self) -> tauri::Result<()> {
        let showing = self.on_screen();
        for (tab, view) in &self.views {
            if self.popouts.contains_key(tab) {
                continue;
            }
            if showing.contains(tab)
                && (!self.covered || self.live_overlays.contains_key(CHROME_LABEL))
            {
                view.show()?;
                if Some(*tab) == self.active && !self.covered {
                    let _ = view.set_focus();
                }
            } else {
                view.hide()?;
            }
        }
        // Only as the page becomes covered. Refocusing on every region update
        // took the keyboard away from whatever the overlay had given it, once
        // per frame while a menu animated. A passive cover leaves the keyboard
        // with the page: a tooltip under the pointer, or the save-login card
        // arriving while someone types a one-time code, must not swallow the
        // next Enter.
        self.apply_cover_focus();
        for chrome in self.live_overlays.keys() {
            self.update_overlay_mask(chrome, true)?;
        }
        // A chrome that just left the live set keeps its mask otherwise: the
        // loop above only rebuilds masks for chromes still in it. A stale mask
        // punches transparent holes over the old page area, and once the page
        // view is hidden under a modal, those holes show the black window
        // behind the chrome instead of the frozen page -- the "click +,
        // everything goes dark" freeze. Clearing it lets the chrome paint the
        // whole content area, frozen page and all. Popouts clear their own in
        // `set_live_overlay`.
        if !self.live_overlays.contains_key(CHROME_LABEL) {
            self.update_overlay_mask(CHROME_LABEL, false)?;
        }
        Ok(())
    }

    /// Tabs the main window's layout shows: the panes of a split, or the
    /// active tab alone.
    fn on_screen(&self) -> Vec<TabId> {
        if self.panes.is_empty() {
            self.active.into_iter().collect()
        } else {
            self.panes.iter().map(|p| p.tab).collect()
        }
    }

    /// How many tabs have a live page view, each a renderer the machine is
    /// paying for.
    pub fn live_views(&self) -> usize {
        self.views.len()
    }

    /// Every tab a user can currently see, in any window. The idle sweep
    /// must not put one of these to sleep.
    pub fn showing(&self) -> Vec<TabId> {
        let mut ids = self.on_screen();
        ids.extend(self.popouts.keys().copied());
        ids
    }

    /// Lay the content area out as these panes (empty for a single page),
    /// showing each pane's tab at its rectangle.
    pub fn set_panes(&mut self, panes: Vec<PaneBounds>) -> tauri::Result<()> {
        let before: Vec<TabId> = self.panes.iter().map(|p| p.tab).collect();
        // A pane without a view (asleep, or not yet restored) keeps its
        // rectangle: dropping it left the pane blank, and the view created
        // for it later went over the whole content area instead. `open`
        // places that view once it exists.
        self.panes = panes
            .into_iter()
            .filter(|p| !self.popouts.contains_key(&p.tab))
            .collect();
        self.layout()?;
        // Showing also focuses the active page, so only do it when the set of
        // panes changed: a resize must not pull the caret out of the omnibox.
        if before != self.panes.iter().map(|p| p.tab).collect::<Vec<_>>() {
            self.apply_visibility()?;
        }
        Ok(())
    }

    /// Where a view belongs: its popout window, its pane, or the content area.
    fn rect_for(&self, id: TabId) -> Bounds {
        if let Some(p) = self.popouts.get(&id) {
            return p.bounds;
        }
        self.panes
            .iter()
            .find(|p| p.tab == id)
            .map_or(self.bounds, |p| p.bounds)
    }

    /// Move and resize every view to where the layout says it belongs.
    fn layout(&self) -> tauri::Result<()> {
        for chrome in self.live_overlays.keys() {
            self.update_overlay_mask(chrome, true)?;
        }
        for (tab, view) in &self.views {
            let b = self.rect_for(*tab);
            view.set_bounds(tauri::Rect {
                position: b.position().into(),
                size: b.size().into(),
            })?;
        }
        Ok(())
    }

    /// Give the page itself the keyboard. Chromium will not open an
    /// eyedropper for a frame that is not focused, and a picker asked for
    /// from the dock arrives while the chrome webview holds focus, so the
    /// caller has to hand it back first.
    pub fn focus_page(&self, id: TabId) -> tauri::Result<()> {
        if let Some(popout) = self.popouts.get(&id) {
            popout.window.set_focus()?;
        } else {
            self.window.set_focus()?;
        }
        if let Some(view) = self.views.get(&id) {
            let _ = view.set_focus();
        }
        Ok(())
    }

    /// Focus the existing main launcher surface for menu/button fallbacks.
    /// Callers propagate errors; detached page state is left in place.
    pub fn focus_main_chrome(&self) -> tauri::Result<()> {
        let chrome = self
            .window
            .webviews()
            .into_iter()
            .find(|view| view.label() == CHROME_LABEL)
            .ok_or(tauri::Error::WebviewNotFound)?;
        self.reveal_main()?;
        self.window.set_focus()?;
        chrome.set_focus()
    }

    /// Show the main window again if it was closed while other windows
    /// stayed open, and let its pages be heard again.
    pub fn reveal_main(&self) -> tauri::Result<()> {
        if crate::main_window::reveal(&self.window)? {
            self.quiet_main_tabs(false);
        }
        Ok(())
    }

    /// Silence the pages the main window holds while it is closed, or give
    /// each back the sound it had: a tab muted on purpose stays muted.
    pub fn quiet_main_tabs(&self, quiet: bool) {
        for (tab, view) in &self.views {
            if !self.popouts.contains_key(tab) {
                crate::tab_audio::apply_to_view(view, quiet || crate::tab_audio::is_muted(*tab));
            }
        }
    }

    /// Label of the chrome webview that should receive a menu command: the
    /// focused popout's, else the main window's.
    pub fn chrome_for_menu(&self) -> String {
        self.focused_popout()
            .and_then(|id| self.popouts.get(&id))
            .map_or_else(|| CHROME_LABEL.to_owned(), |p| p.chrome.clone())
    }

    /// Move keyboard focus to the chrome of whichever window is focused.
    pub fn focus_chrome_for_menu(&self) {
        match self.focused_popout() {
            Some(id) => {
                if let Some(p) = self.popouts.get(&id)
                    && let Some(chrome) = p
                        .window
                        .webviews()
                        .into_iter()
                        .find(|w| w.label() == p.chrome)
                {
                    let _ = chrome.set_focus();
                }
            }
            None => self.focus_chrome(),
        }
    }

    /// Move keyboard focus to the React chrome. The page is a separate native
    /// webview that keeps first responder while it is up, so anything the user
    /// is meant to type into the chrome (palette, find bar, address bar) has to
    /// ask for focus first or the keystrokes go to the page instead.
    pub fn focus_chrome(&self) {
        if let Some(chrome) = self
            .window
            .webviews()
            .into_iter()
            .find(|w| w.label() == CHROME_LABEL)
        {
            let _ = chrome.set_focus();
        }
    }

    /// Hide every tab view in the main window (used when switching
    /// workspaces). Popouts stay up: they belong to their own window.
    pub fn deactivate_all(&mut self) -> tauri::Result<()> {
        for (tab, view) in &self.views {
            if !self.popouts.contains_key(tab) {
                view.hide()?;
            }
        }
        self.active = None;
        self.panes.clear();
        Ok(())
    }

    /// Ask `id`'s page to close the way closing a tab in a browser does:
    /// its `beforeunload` handler runs, and a page holding unsaved work asks
    /// the person (as a dialog card) whether to leave. Returns whether the
    /// page was asked; the tab is then kept until the page agrees, which
    /// `take_close_request` hears. A tab with no live page to ask -- asleep,
    /// or one of Dive's own -- returns false and is closed at once.
    #[cfg(feature = "cef")]
    pub fn request_close(&mut self, id: TabId) -> bool {
        let Some(view) = self.views.get(&id) else {
            return false;
        };
        let asked = view
            .with_webview(|native| native.close_gracefully())
            .is_ok();
        if asked {
            self.closing.ask(id, view.label());
        }
        asked
    }

    /// Without CEF there is no page to ask; every close is immediate.
    #[cfg(not(feature = "cef"))]
    pub fn request_close(&mut self, _id: TabId) -> bool {
        false
    }

    /// Whether the view `label` closing is the page agreeing to a close
    /// `request_close` asked for, rather than one forced for another reason.
    pub fn take_close_request(&mut self, id: TabId, label: &str) -> bool {
        self.closing.take(id, label)
    }

    /// The person chose to stay on the page; the tab is theirs again.
    pub fn cancel_close_request(&mut self, id: TabId) {
        self.closing.cancel(id);
    }

    /// Destroy the view for `id`, if any. Forced: the page is not asked.
    pub fn close(&mut self, id: TabId) -> tauri::Result<()> {
        self.closing.cancel(id);
        if let Some(view) = self.views.get(&id) {
            view.close()?;
        }
        self.forget_closed(id);
        let state = self.window.app_handle().state::<AppState>();
        state.activity.drop_tab(id);
        state.agent_presence.forget(id);
        state.js_dialogs.forget_tab(id);
        crate::tab_audio::forget(id);
        crate::find::forget(id);
        Ok(())
    }

    /// Forget a view after a successful native close transition.
    pub fn forget_closed(&mut self, id: TabId) {
        if let Some(session) = self.cdp.remove(&id) {
            session.close();
        }
        self.views.remove(&id);
        if let Some(popout) = self.forget_popout(id) {
            self.live_overlays.remove(&popout.chrome);
            let _ = popout.window.destroy();
        }
        self.internal.remove(&id);
        self.panes.retain(|p| p.tab != id);
        if self.active == Some(id) {
            self.active = None;
        }
    }

    /// Navigate `id`'s view.
    pub fn navigate(&self, id: TabId, url: url::Url) -> tauri::Result<()> {
        match self.views.get(&id) {
            Some(view) => view.navigate(url),
            None => Err(tauri::Error::WebviewNotFound),
        }
    }

    /// The content rectangle a single page fills. Panes and popouts keep
    /// their own rectangles.
    pub fn set_bounds(&mut self, bounds: Bounds) -> tauri::Result<()> {
        self.bounds = bounds;
        self.layout()
    }

    /// Currently shown tab.
    pub fn active(&self) -> Option<TabId> {
        self.active
    }

    /// Whether a view exists for `id`.
    pub fn has(&self, id: TabId) -> bool {
        self.views.contains_key(&id) || self.internal.contains(&id)
    }
}

/// Focus transitions between interactive chrome and passive page overlays.
/// `true` focuses chrome; `false` returns focus to the page.
fn cover_focus_change(previous: bool, covered: bool, passive: bool) -> Option<bool> {
    let wants = covered && !passive;
    if wants && !previous {
        Some(true)
    } else if previous && covered && passive {
        Some(false)
    } else {
        None
    }
}

/// Bytes of protocol messages that may wait for the session's worker.
#[cfg(feature = "cef")]
const INGRESS_BUDGET: usize = 64 * 1024 * 1024;
/// A single protocol reply larger than this is refused on its own (its call
/// fails) rather than counted against the session's ingress budget. Half the
/// budget, so an admitted message always leaves room for the rest.
#[cfg(feature = "cef")]
const MAX_PROTOCOL_REPLY: usize = INGRESS_BUDGET / 2;

/// Bridge a CEF webview's `DevTools` channel into a [`CdpSession`].
#[cfg(feature = "cef")]
fn attach_cdp(
    view: &Webview<Runtime>,
    activity: std::sync::Arc<crate::activity::Registry>,
    tab: TabId,
    nonce: String,
) -> tauri::Result<CdpSession> {
    struct CefTransport(Webview<Runtime>);
    impl dive_cdp::Transport for CefTransport {
        fn send(&self, message: &str) -> Result<(), dive_cdp::CdpError> {
            self.0
                .send_dev_tools_message(message.as_bytes())
                .map_err(|e| dive_cdp::CdpError::Transport(e.to_string()))
        }
    }

    let session = CdpSession::new(CefTransport(view.clone()));
    // CEF delivers protocol messages on its UI thread, which is the window's
    // main thread -- the one that paints and takes input. A busy page sends
    // hundreds a second and a screencast frame runs to hundreds of KB, so
    // scanning and parsing them there is what dropped frames during a page
    // load. The callback only hands the bytes over; one worker per session
    // does the JSON work, in arrival order, and exits when the view goes.
    let (tx, mut rx) = dive_cdp::queue::bounded(4096, INGRESS_BUDGET);
    let (overflow, mut overloaded) = tokio::sync::watch::channel(false);
    let failed_view = view.clone();
    let sink = session.clone();
    let failure_nonce = nonce.clone();
    tauri::async_runtime::spawn(async move {
        // If this worker ever stops while the view lives -- it should only
        // end when the view's handlers are dropped -- close the session so
        // calls fail at once instead of every paused request sitting
        // unanswered and every call waiting out its deadline.
        let _closer = CloseSessionOnDrop {
            session: sink.clone(),
            tab,
        };
        loop {
            let message = tokio::select! {
                biased;
                _ = overloaded.changed() => {
                    if *overloaded.borrow() {
                        tracing::error!(%tab, "CDP ingress budget exceeded; stopping tab protocol session");
                        sink.close();
                        // Cancel native loading without depending on the
                        // overloaded protocol channel or turning Fetch off.
                        let _ = failed_view.with_webview(|native| {
                            use cef::ImplBrowser;
                            native.browser().stop_load();
                        });
                        let _ = (crate::loading::TabLoad {
                            tab_id: tab,
                            phase: crate::loading::LoadPhase::Failed,
                            url: None,
                            error: Some("ERR_DIVE_PROTOCOL_OVERLOAD".into()),
                            method: None,
                        }).emit(failed_view.app_handle());
                    }
                    break;
                },
                message = rx.recv() => match message { Some(message) => message, None => break },
            };
            match std::str::from_utf8(&message.bytes) {
                Ok(text) => {
                    tracing::trace!(
                        len = text.len(),
                        head = &text[..text.floor_char_boundary(160)],
                        "cdp <-"
                    );
                    activity.ingest(tab, &nonce, text);
                    if let Err(e) = sink.handle_incoming(text) {
                        tracing::debug!("ignoring malformed cdp message: {e}");
                    }
                }
                Err(e) => tracing::warn!("cdp message is not utf-8: {e}"),
            }
        }
    });
    let callback_session = session.clone();
    let failure_app = view.app_handle().clone();
    let failure_activity = failure_app.state::<AppState>().activity.clone();
    view.on_dev_tools_protocol(move |protocol| {
        if let tauri::CefDevToolsProtocol::CreationFailed(reason) = &protocol {
            callback_session.close();
            if failure_activity.session_current(tab, &failure_nonce) {
                let _ = (crate::loading::TabLoad {
                    tab_id: tab,
                    phase: crate::loading::LoadPhase::Failed,
                    url: None,
                    error: Some(reason.clone()),
                    method: None,
                })
                .emit(&failure_app);
            }
            return;
        }
        // `Message` carries the raw JSON for both results and events; the
        // runtime no longer dispatches the pre-parsed variants.
        // A too-large reply is refused here, on the main thread, before it is
        // queued: it costs a 20-byte prefix check, no parsing.
        if let tauri::CefDevToolsProtocol::Message(bytes) = protocol
            && !callback_session.is_closed()
        {
            if bytes.len() > MAX_PROTOCOL_REPLY
                && callback_session.fail_oversized_reply(&bytes, MAX_PROTOCOL_REPLY)
            {
                return;
            }
            if tx.try_send(bytes).is_err() {
                callback_session.close();
                overflow.send_replace(true);
            }
        }
    })?;
    Ok(session)
}

/// Native admission can succeed before CEF reports an error. Surface chrome
/// failure even when no renderer exists to display an application error page.
#[cfg(feature = "cef")]
fn watch_chrome_creation(view: &Webview<Runtime>, tab: Option<TabId>) -> tauri::Result<()> {
    crate::crash::attach_chrome(view);
    let app = view.app_handle().clone();
    let label = view.label().to_owned();
    let window = view.window();
    view.on_dev_tools_protocol(move |protocol| {
        let tauri::CefDevToolsProtocol::CreationFailed(reason) = protocol else { return; };
        let task_app = app.clone();
        let label = label.clone();
        let window = window.clone();
        let _ = app.run_on_main_thread(move || {
            if task_app.get_webview(&label).is_none() { return; }
            tracing::error!(%reason, "native chrome creation failed");
            if let Some(tab) = tab {
                let state = task_app.state::<AppState>();
                let mut host = lock(&state.host);
                let Some(host) = host.as_mut() else { return; };
                if host.popouts.get(&tab).is_none_or(|popout| popout.chrome != label) { return; }
                if let Err(error) = host.attach(tab) {
                    tracing::error!(%error, "preserving detached page after chrome rollback failed");
                    let _ = window.set_title(&format!("DIVE window failed: {reason}"));
                    let _ = window.set_decorations(true);
                    let _ = window.show();
                    return;
                }
                host.active = Some(tab);
                let _ = host.apply_visibility();
                let _ = (crate::commands::TabWindowChanged { tab, detached: false }).emit(&task_app);
                tauri::async_runtime::spawn(async move {
                    rfd::AsyncMessageDialog::new().set_title("DIVE could not open this window")
                        .set_description(format!("Your tab was returned to the main window. {reason}"))
                        .set_level(rfd::MessageLevel::Error).set_buttons(rfd::MessageButtons::Ok).show().await;
                });
            } else {
                // The runtime retains an empty failed-creation window until
                // this asynchronous native error message has been dismissed.
                tauri::async_runtime::spawn(async move {
                    rfd::AsyncMessageDialog::new().set_title("DIVE could not start")
                        .set_description(format!("The browser window could not start. {reason}"))
                        .set_level(rfd::MessageLevel::Error).set_buttons(rfd::MessageButtons::Ok).show().await;
                    let _ = window.destroy();
                });
            }
        });
    })
}

/// Closes a session when the task that feeds it ends, unless it is already
/// closed: a session nobody parses for is a tab that never answers.
struct CloseSessionOnDrop {
    session: CdpSession,
    tab: TabId,
}

impl Drop for CloseSessionOnDrop {
    fn drop(&mut self) {
        if !self.session.is_closed() {
            // Ordinary at shutdown and on a tab close: the worker ends
            // before the session it was reading. Thirty of these in a log is
            // what a normal week looks like, so it is not a warning; the
            // session is closed here either way.
            tracing::debug!(tab = %self.tab, "cdp worker stopped before its session; closing the session");
            self.session.close();
        }
    }
}

/// Title of the runtime's internal initial-load document; never persist it.
const PLACEHOLDER_TITLE: &str = "Tauri CEF Initial Load";

const BLANK_URL: &str = "about:blank";

fn label_for(id: TabId) -> String {
    static NEXT_VIEW: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let generation = NEXT_VIEW.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("tab-{id}-{generation}")
}

/// A late callback from a closing renderer must not overwrite its replacement.
///
/// Blocking: it writes the store. Callers on the async runtime hand it to
/// `spawn_blocking`, since several SQLite statements per title or address
/// change of every tab held up whatever else was queued on that worker.
fn update_session_tab(app: &AppHandle<Runtime>, id: TabId, nonce: &str, f: impl FnOnce(&mut Tab)) {
    let state = app.state::<AppState>();
    // The activity registry answers from its own small lock. This used to
    // take the host lock around the check as well, which guarded nothing the
    // registry does not -- the view can be replaced between the check and
    // the write either way, a window of microseconds that the replacement's
    // own callbacks close -- and made every title and address change of
    // every tab wait on the lock the main thread needs for tab operations.
    if state.activity.session_current(id, nonce) {
        update_tab(app, id, f);
    }
}

/// Apply `f` to the stored tab, persist it, and broadcast the change.
pub fn update_tab(app: &AppHandle<Runtime>, id: TabId, f: impl FnOnce(&mut Tab)) {
    let state = app.state::<AppState>();
    let store = lock(&state.store);
    let Ok(before) = store.tab_as_stored(id) else {
        return;
    };
    let Ok(mut tab) = store.tab(id) else { return };
    let was = tab.url.clone();
    f(&mut tab);
    // A page that animates its own title -- a chat tab counting unread, a
    // clock -- calls this every second. Writing the row, recording a visit and
    // republishing the tab for a change that did not happen cost a SQLite
    // write and a re-render of the whole chrome each time. `before` is the
    // row as stored: `tab` was lent its site's cached icon on read, and
    // comparing against that copy made a newly resolved icon look like no
    // change, so it was never saved or sent and the tab kept a globe.
    if tab == before {
        return;
    }
    // The read above lends the tab its origin's remembered icon, which belongs
    // to the site it is leaving; a URL change has to re-key it or the old mark
    // gets written back against the new address.
    if tab.url != was {
        store.rekey_favicon(&mut tab);
    }
    let navigated = tab.url != was;
    let visit = (records_a_visit(&tab.url, navigated, tab.title != before.title)
        && !crate::private_session::is_private())
    .then(|| {
        if navigated {
            VisitChange::Navigated {
                url: &tab.url,
                title: visit_title(navigated, &tab.title),
                at: dive_core::Timestamp::now(),
            }
        } else {
            VisitChange::Titled {
                url: &tab.url,
                title: &tab.title,
            }
        }
    });
    if let Err(e) = store.save_tab(&tab, visit) {
        tracing::warn!(%id, "failed to persist tab update: {e}");
        return;
    }
    drop(store);
    state.bus.publish(CoreEvent::TabUpserted(tab));
}

/// The address to record for a page after the engine reports `reported`.
/// A source view reports the page it shows, not its own `view-source:`
/// address; keeping the prefix means the tab restores as the source view.
fn reported_url(current: &str, reported: String) -> String {
    match current.strip_prefix("view-source:") {
        Some(shown) if shown == reported => current.to_owned(),
        _ => reported,
    }
}

/// The title to file a visit under. When the address just changed, the
/// tab's title still belongs to the page it left (or is "about:blank" for a
/// fresh tab), so the visit starts untitled and the real title fills it in
/// when it arrives; a redirect's source address is never wrongly titled.
/// Whether this change to a tab belongs in history.
///
/// Going somewhere does. So does a title arriving for where you already are --
/// that is what fills in the entry, and only the first real one does
/// (`VisitChange::Titled`). Anything else does not: a page that animates its
/// own title otherwise wrote a fresh row every minute for as long as the tab
/// was open, and a favicon or a load-state change wrote one for nothing at
/// all.
fn records_a_visit(url: &str, navigated: bool, title_changed: bool) -> bool {
    url.starts_with("http") && (navigated || title_changed)
}

fn visit_title(url_changed: bool, title: &str) -> &str {
    // "about:blank" is the blank document's own name, never the page's;
    // it arrives as a title change while the real page is still loading.
    if url_changed || title == BLANK_URL {
        ""
    } else {
        title
    }
}

/// Build the main window with the chrome webview filling it.
/// Show a window built hidden, once (a second call is a no-op for a visible
/// window). Focus follows so the torn-off tab keeps the keyboard.
fn reveal(window: &Window<Runtime>) {
    // CEF load callbacks can run on the native message pump outside Winit's
    // dispatch guard. run_on_main_thread executes inline on that thread, so a
    // synchronous is_visible getter there would queue its reply and deadlock.
    // Leave the CEF callback first, then enter through a queued Winit task.
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        let reveal = window.clone();
        let _ = window.run_on_main_thread(move || {
            if !reveal.is_visible().unwrap_or(true) {
                let _ = reveal.show();
                let _ = reveal.set_focus();
            }
        });
    });
}

/// Backstop for [`reveal`]: if the chrome never reports a finished load, the
/// window still appears, a moment later.
fn reveal_soon(window: Window<Runtime>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        reveal(&window);
    });
}

/// Ask the compositor for Windows 11's rounded corners.
///
/// A decorated window gets them for nothing, but the chrome draws its own
/// title bar, so the frame is off and the window comes back square -- which
/// looks like an older Windows rather than a deliberate choice. This is the
/// same corner radius every other Windows 11 app has.
///
/// Nothing to do anywhere else: macOS rounds its own windows, and this is a
/// no-op there.
#[cfg(target_os = "windows")]
#[allow(unsafe_code)] // DWM is reachable only through the Win32 C API.
fn round_corners(window: &tauri::Window<Runtime>) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND, DwmSetWindowAttribute,
    };
    let Ok(handle) = window.window_handle() else {
        return;
    };
    let RawWindowHandle::Win32(win32) = handle.as_raw() else {
        return;
    };
    let hwnd = HWND(win32.hwnd.get() as _);
    let preference = DWMWCP_ROUND;
    // A compositor that does not know the attribute (Windows 10) simply
    // refuses it, which is the square corners it was already drawing.
    let _ = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            std::ptr::from_ref(&preference).cast(),
            u32::try_from(size_of_val(&preference)).unwrap_or(4),
        )
    };
}

#[cfg(not(target_os = "windows"))]
fn round_corners(_window: &tauri::Window<Runtime>) {}

pub fn create_main_window(app: &App<Runtime>) -> tauri::Result<()> {
    let remembered = {
        let state = app.state::<AppState>();
        let store = crate::state::lock(&state.store);
        store
            .setting(WINDOW_BOUNDS)
            .ok()
            .flatten()
            .and_then(|s| WindowBounds::parse(&s))
    };
    let (width, height) = remembered.map_or((1280.0, 820.0), |b| (b.width, b.height));
    let mut builder = tauri::window::WindowBuilder::new(app, MAIN_WINDOW)
        .title(if crate::private_session::is_private() {
            "Dive — Private Window"
        } else if cfg!(debug_assertions) {
            "Dive Dev"
        } else {
            "Dive"
        })
        .background_color(GROUND)
        .inner_size(width, height)
        .min_inner_size(720.0, 480.0);
    // The chrome draws its own title bar, with the tabs sitting beside
    // the traffic lights. That is a macOS window style; Tauri does not
    // offer it elsewhere; Windows gets the same
    // effect from `decorations(false)` plus the chrome's own controls.
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    // Windows draws a title bar of its own above the chrome's, so the
    // window ends up with two. The chrome is the title bar here as much
    // as on macOS, so the frame goes and `WindowControls` supplies the
    // minimise, maximise and close buttons in the corner Windows keeps
    // them.
    #[cfg(target_os = "windows")]
    {
        builder = builder.decorations(false);
    }
    // Keep the window resizable and never larger than the work area it opens
    // into. `prevent_overflow` clamps the initial size to `monitor - taskbar`,
    // so a remembered size from a bigger display, or the 1280x820 default on a
    // small screen, still fits. `resizable` is Tauri's default, but stated
    // here because the frameless Windows window relies on the chrome's own
    // resize handles (see `ResizeEdges`), and this is what they drive.
    builder = builder.resizable(true).prevent_overflow();
    let screens = screen_areas(&app.handle().available_monitors().unwrap_or_default());
    if let Some((x, y)) = remembered.and_then(|b| visible_position(&b, &screens)) {
        builder = builder.position(x, y);
    } else {
        // First launch has no remembered bounds, and a remembered frame on a
        // display that is gone is out of reach: open in the middle of the
        // screen rather than wherever the OS drops an unplaced window.
        builder = builder.center();
    }
    // `DIVE_WINDOW_HIDDEN=1`: harness runs keep the window off screen so a
    // person at the machine cannot close a trial by accident.
    if std::env::var_os("DIVE_WINDOW_HIDDEN").is_some() {
        builder = builder.visible(false);
    }
    tracing::info!("main window: building native window");
    let window = builder.build()?;
    tracing::info!("main window: native window built");
    round_corners(&window);

    // Keep production's Dock icon clean. macOS renders this label directly on
    // the running development app's icon, so dev and release builds cannot be
    // mistaken for one another in the Dock or app switcher.
    #[cfg(all(debug_assertions, target_os = "macos"))]
    window.set_badge_label(Some("DEV".into()))?;

    let chrome_dev_url = if cfg!(debug_assertions) {
        app.config().build.dev_url.clone()
    } else {
        None
    };
    let chrome_popup_app = app.handle().clone();
    let chrome_download_app = app.handle().clone();
    tracing::info!("main window: attaching chrome webview");
    let chrome = window.add_child(
        private_chrome(WebviewBuilder::new(
            CHROME_LABEL,
            WebviewUrl::App("index.html".into()),
        ))
        .on_navigation(move |url| {
            crate::ipc_security::allowed_chrome_navigation(url, chrome_dev_url.as_ref())
        })
        .on_new_window(move |url, _| open_chrome_link(&chrome_popup_app, None, url))
        .on_download(move |_, event| handle_download(&chrome_download_app, event, None))
        .background_color(GROUND)
        .auto_resize(),
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(width, height),
    )?;
    #[cfg(feature = "cef")]
    {
        crate::permissions::attach_chrome(&chrome)?;
        watch_chrome_creation(&chrome, None)?;
    }
    #[cfg(all(feature = "cef", target_os = "macos"))]
    chrome.with_webview(|native| {
        if !native.set_address_shortcut_target(native.new_tab_shortcut_target()) {
            tracing::warn!("main chrome Address route no longer matches native window");
        }
    })?;
    crate::titlebar::keep_drags_in_chrome_soon(&window);

    let state = app.state::<AppState>();
    let size = window
        .inner_size()?
        .to_logical::<f64>(window.scale_factor()?);
    let bounds = main_content_bounds(
        size.width,
        size.height,
        state.prefs.get(&state).rail_expanded,
    );
    *lock(&state.host) = Some(TabHost::new(window, crate::state::profiles_root(), bounds));

    forward_events(app.handle().clone(), state.bus.subscribe());
    Ok(())
}

/// The host of the page a tab is on, for naming the site that asked to open
/// another app. Empty when the tab has no page, or its URL has no host.
fn current_page_host(app: &AppHandle<Runtime>, tab_id: TabId) -> String {
    let state = app.state::<AppState>();
    let url = crate::state::lock(&state.store)
        .tab(tab_id)
        .map(|tab| tab.url)
        .unwrap_or_default();
    url::Url::parse(&url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_default()
}

/// Whether a new-window request is a popup the page has to keep talking to
/// (sign-in, payment, share), rather than a link that belongs in a tab.
///
/// `window.open` with a width and a height is the signal every one of those
/// flows uses; a plain `target="_blank"` link carries no size.
///
/// `about:blank` counts. Google's sign-in opens its window empty and navigates
/// it from the opener a moment later, so judging that call by its URL alone
/// sent the one flow this is for down the tab path -- an empty window that
/// never became the sign-in page. Anything else (a file, a Dive URL, a custom
/// scheme) is opened the way Dive opens links.
fn is_popup_window(url: &url::Url, sized: bool) -> bool {
    sized && is_web_link(url)
}

/// Whether a page may have Dive open `url` in a new window or tab for it:
/// the web, and the blank page sign-in flows start from. Anything else -- a
/// file, a Dive page, `javascript:`, another app's scheme -- is not a link a
/// page gets to open by asking.
pub(crate) fn is_web_link(url: &url::Url) -> bool {
    matches!(url.scheme(), "http" | "https") || url.as_str() == BLANK_URL
}

/// Chrome links open tracked page tabs, never unmanaged popups inheriting
/// the chrome's native client, labels, and application capabilities.
fn open_chrome_link(
    app: &AppHandle<Runtime>,
    source: Option<TabId>,
    url: url::Url,
) -> tauri::webview::NewWindowResponse<Runtime> {
    if matches!(url.scheme(), "http" | "https") {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let handle = app.clone();
            if let Err(error) = app.run_on_main_thread(move || {
                let Some(main) = MainThread::here() else {
                    return;
                };
                let state = handle.state::<AppState>();
                // Main thread, reached from an engine callback: never wait on
                // the store here. If it is busy the link opens in the active
                // workspace, which is where the source tab almost always is.
                let workspace = source
                    .and_then(|tab| state.store.try_lock().ok()?.tab(tab).ok()?.workspace_id)
                    .or(*lock(&state.active_workspace));
                if let Some(workspace) = workspace
                    && let Err(error) =
                        crate::commands::open_tab(&main, &handle, &state, workspace, url.as_str())
                {
                    tracing::warn!(%error, "opening chrome link as a tab failed");
                }
            }) {
                tracing::warn!(%error, "queueing chrome link failed");
            }
        });
    }
    tauri::webview::NewWindowResponse::Deny
}

/// Relay core events to the chrome webview.
fn forward_events(app: AppHandle<Runtime>, mut rx: tokio::sync::broadcast::Receiver<CoreEvent>) {
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    if let Err(e) = crate::commands::emit_state_changed(&app, event) {
                        tracing::warn!("failed to emit state event: {e}");
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    // The chrome's tab list is now behind and nothing coming
                    // will fill the gap. A workspace activation it did not
                    // ask for is the signal it already answers by fetching a
                    // fresh snapshot, so re-announce the current one.
                    tracing::warn!(n, "chrome missed core events; asking it to resync");
                    let current = *lock(&app.state::<AppState>().active_workspace);
                    if let Some(workspace) = current
                        && let Err(e) = crate::commands::emit_state_changed(
                            &app,
                            CoreEvent::WorkspaceActivated(workspace),
                        )
                    {
                        tracing::warn!("resync signal failed: {e}");
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// Trusted chrome joins the same off-the-record context to keep the private
/// session alive even when every page tab is closed. Scheme/IPC routing still
/// uses the exact browser identity; pages never become trusted chrome.
/// Every chrome webview runs off-the-record. Extensions arrive through
/// `--load-extension`, which every profile honours, and a content script
/// with `<all_urls>` would otherwise run inside Dive's own interface;
/// off-the-record profiles do not enable extensions. The chrome keeps its
/// own state through the `ui_state_*` commands instead of web storage.
fn private_chrome(builder: WebviewBuilder<Runtime>) -> WebviewBuilder<Runtime> {
    // Set wherever a native overlay mask exists, which is what lets a menu
    // float over a page that keeps playing. Without it the chrome falls back
    // to freezing the page and showing a capture.
    #[cfg(all(feature = "cef", any(target_os = "macos", target_os = "windows")))]
    let builder = builder.initialization_script(
        "Object.defineProperty(window, '__DIVE_LIVE_OVERLAYS__', {value:true});",
    );
    if crate::private_session::is_private() {
        builder.incognito(true)
            .data_directory(crate::state::profiles_root().join("private-session"))
            .initialization_script("Object.defineProperty(window, '__DIVE_PRIVATE__', {value:true, writable:false, configurable:false});")
    } else {
        builder
            .incognito(true)
            .data_directory(crate::state::profiles_root().join("chrome-ui"))
    }
}

#[cfg(test)]
mod close_request_tests {
    use super::CloseRequests;
    use dive_core::TabId;

    #[test]
    fn only_the_view_asked_can_close_the_tab() {
        let tab = TabId::new();
        let mut requests = CloseRequests::default();
        requests.ask(tab, "tab-a");
        // A view rebuilt after the request is a different page.
        assert!(!requests.take(tab, "tab-b"));
        assert!(requests.take(tab, "tab-a"));
        // Heard once: CEF may report the same close again.
        assert!(!requests.take(tab, "tab-a"));
    }

    #[test]
    fn staying_on_the_page_forgets_the_request() {
        let tab = TabId::new();
        let mut requests = CloseRequests::default();
        requests.ask(tab, "tab-a");
        requests.cancel(tab);
        // A later forced close (sleep, discard) must not delete the tab.
        assert!(!requests.take(tab, "tab-a"));
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn closing_a_dialog_returns_input_to_the_page_beneath_a_passive_card() {
        assert_eq!(super::cover_focus_change(true, true, true), Some(false));
        assert_eq!(super::cover_focus_change(false, true, false), Some(true));
        assert_eq!(super::cover_focus_change(false, true, true), None);
        assert_eq!(super::cover_focus_change(true, true, false), None);
        assert_eq!(super::cover_focus_change(true, false, false), None);
    }

    #[test]
    fn history_records_where_you_went_and_what_it_turned_out_to_be_called() {
        use super::records_a_visit;
        // Going somewhere, and the title that arrives for it afterwards.
        assert!(records_a_visit("https://a.test/", true, false));
        assert!(records_a_visit("https://a.test/", false, true));
        // A page counting unread messages in its own title changes nothing
        // else; before this check each tick wrote another history row.
        assert!(!records_a_visit("https://a.test/", false, false));
        // Neither a favicon nor a load flag is a visit.
        assert!(!records_a_visit("https://a.test/", false, false));
        // Only real web addresses: internal pages are not browsing history.
        assert!(!records_a_visit("dive://home", true, true));
        assert!(!records_a_visit("about:blank", true, false));
        assert!(!records_a_visit("file:///tmp/x.html", true, true));
    }

    #[test]
    fn a_visit_recorded_on_an_address_change_starts_untitled() {
        assert_eq!(super::visit_title(true, "about:blank"), "");
        assert_eq!(super::visit_title(true, "The Verge"), "");
        assert_eq!(super::visit_title(false, "Wikipedia"), "Wikipedia");
        assert_eq!(super::visit_title(false, "about:blank"), "");
        assert_eq!(
            super::reported_url("view-source:https://a.test/", "https://a.test/".into()),
            "view-source:https://a.test/"
        );
        assert_eq!(
            super::reported_url("view-source:https://a.test/", "https://b.test/".into()),
            "https://b.test/"
        );
        assert_eq!(
            super::reported_url("https://a.test/", "https://c.test/".into()),
            "https://c.test/"
        );
    }

    #[test]
    fn blank_popout_focus_receipts_are_stable_but_native_focus_happens_once() {
        let mut intent = super::PopoutAddressFocus::default();
        assert!(
            !intent
                .ready::<()>(|| panic!("ordinary detach must retain page focus"))
                .unwrap()
        );
        intent.request();
        let mut calls = 0;
        assert!(
            intent
                .ready::<()>(|| {
                    calls += 1;
                    Ok(())
                })
                .unwrap()
        );
        // A StrictMode/remount receipt must remain usable without refocusing.
        assert!(intent.ready::<()>(|| panic!("already applied")).unwrap());
        intent.request();
        assert!(intent.ready::<()>(|| panic!("duplicate intent")).unwrap());
        assert_eq!(calls, 1);
    }

    #[test]
    fn blank_popout_focus_failure_preserves_intent_for_retry() {
        let mut intent = super::PopoutAddressFocus::default();
        intent.request();
        assert_eq!(
            intent.ready(|| Err("window unavailable")),
            Err("window unavailable")
        );
        assert!(intent.ready::<()>(|| Ok(())).unwrap());
    }

    #[test]
    fn ordinary_native_new_tab_target_remains_main_only() {
        assert_eq!(
            super::new_tab_chrome_label(crate::MAIN_WINDOW),
            Some(crate::CHROME_LABEL)
        );
        assert_eq!(super::new_tab_chrome_label("popout-1-example"), None);
        assert_eq!(super::new_tab_chrome_label(""), None);
        assert_eq!(
            super::new_tab_chrome_label(crate::MAIN_WINDOW),
            Some(crate::CHROME_LABEL)
        );
    }

    #[test]
    fn reopening_while_native_close_is_pending_uses_a_new_label() {
        let id = TabId::new();
        let old = label_for(id);
        let fresh = label_for(id);
        assert_ne!(
            old, fresh,
            "runtime still owns old label until native close receipt"
        );
        assert_eq!(tab_from_label(&old), Some(id));
        assert_eq!(tab_from_label(&fresh), Some(id));
        assert_eq!(tab_from_label(&format!("tab-{id}")), Some(id));
        assert_eq!(tab_from_label(&format!("tab-{id}-not-a-generation")), None);
        assert_eq!(tab_from_label(&format!("chrome-pop-1-{id}")), None);
    }

    #[test]
    fn popout_page_starts_below_full_dive_chrome() {
        assert_eq!(
            popout_content_bounds(900.0, 700.0),
            Bounds {
                x: 0.0,
                y: 84.0,
                width: 900.0,
                height: 616.0,
            }
        );
    }

    #[test]
    fn main_page_has_a_usable_initial_viewport_inside_the_chrome() {
        for (width, height, expanded, rail) in [
            (1280.0, 820.0, true, 208.0),
            (1280.0, 820.0, false, 52.0),
            (720.0, 480.0, true, 52.0),
        ] {
            let bounds = super::main_content_bounds(width, height, expanded);
            assert!((bounds.x - rail).abs() < f64::EPSILON);
            assert!((bounds.y - 84.0).abs() < f64::EPSILON);
            assert!((bounds.x + bounds.width - width).abs() < f64::EPSILON);
            assert!((bounds.y + bounds.height - height).abs() < f64::EPSILON);
            assert!(bounds.width >= 668.0 && bounds.height >= 396.0);
        }
    }

    #[test]
    fn view_labels_round_trip_to_tab_ids() {
        let id = TabId::new();
        assert_eq!(tab_from_label(&label_for(id)), Some(id));
        assert_eq!(tab_from_label("main"), None);
        assert_eq!(tab_from_label("tab-not-an-id"), None);
    }

    #[test]
    fn main_thread_token_is_granted_here_and_refused_elsewhere() {
        mark_main_thread();
        assert!(MainThread::here().is_some());
        let off = std::thread::spawn(|| MainThread::here().is_some())
            .join()
            .unwrap();
        assert!(!off, "a worker thread must not be able to mint the token");
    }

    use super::*;

    #[test]
    fn only_sized_web_window_opens_are_popups() {
        let sized = |raw: &str| is_popup_window(&url::Url::parse(raw).unwrap(), true);
        let plain = |raw: &str| is_popup_window(&url::Url::parse(raw).unwrap(), false);
        // A sign-in window: the page has to keep talking to it.
        assert!(sized("https://accounts.google.com/o/oauth2/auth"));
        assert!(sized("http://localhost:3000/login"));
        // A link asking for a new window is a tab, however it was opened.
        assert!(!plain("https://example.com/article"));
        // An empty window the opener navigates itself is the Google flow.
        assert!(sized(BLANK_URL));
        // Anything else is not a popup.
        assert!(!sized("file:///etc/hosts"));
        assert!(!sized("dive://settings"));
        assert!(!plain(BLANK_URL));
    }

    #[test]
    fn a_page_may_ask_for_a_new_tab_only_on_the_web() {
        let link = |raw: &str| is_web_link(&url::Url::parse(raw).unwrap());
        assert!(link("https://example.com/article"));
        assert!(link("http://localhost:3000/"));
        assert!(link(BLANK_URL));
        for refused in [
            "file:///etc/hosts",
            "dive://settings",
            "javascript:alert(1)",
            "data:text/html,<b>x</b>",
            "blob:https://example.com/0f0e",
            "about:srcdoc",
            "chrome://settings",
            "view-source:https://example.com/",
            "mailto:a@b.c",
        ] {
            assert!(!link(refused), "{refused}");
        }
    }
}
