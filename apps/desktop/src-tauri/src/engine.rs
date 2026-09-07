//! Engine layer: the main window, the chrome webview and one child webview
//! per open tab. Everything here talks to Tauri; nothing knows about React.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use dive_cdp::CdpSession;
use dive_core::{Container, CoreEvent, Tab, TabId};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::webview::{DownloadEvent, WebviewBuilder};
use tauri::{App, AppHandle, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl, Window};
use tauri_specta::Event;

/// The chrome's ground colour (`--color-ground` in styles.css). Every window
/// and chrome webview is painted with it before the page has drawn, so a
/// window never shows through to what is behind it or flashes white while it
/// is created, resized or moved.
const GROUND: tauri::utils::config::Color = tauri::utils::config::Color(0x11, 0x11, 0x11, 0xFF);

use crate::state::{AppState, lock};
use crate::{CHROME_LABEL, MAIN_WINDOW, Runtime};

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

/// A download started or finished; shown as a toast.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct DownloadNotice {
    /// The tab the download came from, when a page asked for it.
    pub tab: Option<TabId>,
    /// Source URL.
    pub url: String,
    /// Where the file is (or will be) written.
    pub path: String,
    /// `started` | `finished` | `failed`.
    pub status: String,
}

/// `~/Downloads`, or the temp dir when the home is unknown.
pub fn downloads_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    home.map_or_else(std::env::temp_dir, |h| h.join("Downloads"))
}

/// Pick a path in `dir` for `suggested`, appending ` (n)` if taken.
pub fn unique_path(dir: &std::path::Path, suggested: &str) -> PathBuf {
    let name = std::path::Path::new(suggested)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("download");
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_owned(), format!(".{e}")),
        _ => (name.to_owned(), String::new()),
    };
    let mut candidate = dir.join(name);
    let mut n = 1;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    candidate
}

/// Shared by page views and chrome-owned editors. Blob exports from capture,
/// recording and developer tools need the same destination and notices as pages.
fn handle_download(
    app: &AppHandle<Runtime>,
    event: DownloadEvent<'_>,
    source: Option<(TabId, &str)>,
) -> bool {
    let notice = match event {
        DownloadEvent::Requested { url, destination } => {
            let state = app.state::<AppState>();
            let dir = state.prefs.get(&state).download_dir();
            match download_destination(&dir, destination, &url) {
                Ok(path) => *destination = path,
                Err(error) => {
                    tracing::warn!(%error, "preparing download destination failed");
                    let _ = DownloadNotice {
                        tab: source.map(|(tab, _)| tab),
                        url: url.to_string(),
                        path: String::new(),
                        status: "failed".into(),
                    }
                    .emit(app);
                    return false;
                }
            }
            if let Some((tab, nonce)) = source {
                state.activity.download(tab, nonce, url.as_str(), true);
            }
            DownloadNotice {
                tab: source.map(|(tab, _)| tab),
                url: url.to_string(),
                path: destination.to_string_lossy().into_owned(),
                status: "started".into(),
            }
        }
        DownloadEvent::Finished { url, path, success } => {
            if let Some((tab, nonce)) = source {
                app.state::<AppState>()
                    .activity
                    .download(tab, nonce, url.as_str(), false);
            }
            DownloadNotice {
                tab: source.map(|(tab, _)| tab),
                url: url.to_string(),
                path: path
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                status: if success { "finished" } else { "failed" }.into(),
            }
        }
        _ => return true,
    };
    let _ = notice.emit(app);
    true
}

fn download_destination(
    dir: &std::path::Path,
    suggested: &std::path::Path,
    url: &url::Url,
) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let name = suggested
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_else(|| {
            url.path_segments()
                .and_then(|mut parts| parts.next_back())
                .filter(|name| !name.is_empty())
                .unwrap_or("download")
        });
    Ok(unique_path(dir, name))
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
    /// Claim the token, if this is the main thread. Tauri's sync commands and
    /// `run_on_main_thread` closures qualify; a tokio task never does.
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
    live_overlays: HashMap<String, Vec<Bounds>>,
    /// Split view: tabs shown side by side, each at its own rectangle. Empty
    /// means the active tab alone fills the content area.
    panes: Vec<PaneBounds>,
    /// Tabs torn off into their own window. Their views are children of that
    /// window, not the main one, so the main layout leaves them alone.
    popouts: HashMap<TabId, Popout>,
    /// Tabs whose page is one of Dive's own (`dive://…`), drawn by the chrome
    /// in the content area: they have no native view at all.
    internal: std::collections::HashSet<TabId>,
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

/// A tab living in its own window.
struct Popout {
    window: Window<Runtime>,
    bounds: Bounds,
    /// Label of the chrome webview inside the window.
    chrome: String,
    address_focus: PopoutAddressFocus,
    covered: bool,
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

/// Destroys a window on drop unless disarmed: the popout builder's rollback.
struct DestroyOnDrop(Option<Window<Runtime>>);

impl DestroyOnDrop {
    fn disarm(mut self) {
        self.0 = None;
    }
}

impl Drop for DestroyOnDrop {
    fn drop(&mut self) {
        if let Some(window) = self.0.take() {
            let _ = window.destroy();
        }
    }
}

fn scopeguard_destroy(window: Window<Runtime>) -> DestroyOnDrop {
    DestroyOnDrop(Some(window))
}

/// Window label for the `seq`th popout, holding `id`.
fn popout_label(seq: u64, id: TabId) -> String {
    format!("pop-{seq}-{id}")
}

/// The tab a popout window label belongs to, if it is one.
pub fn popout_tab(label: &str) -> Option<TabId> {
    let (_, id) = label.strip_prefix("pop-")?.split_once('-')?;
    id.parse().ok()
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
            live_overlays: HashMap::new(),
            panes: Vec::new(),
            popouts: HashMap::new(),
            internal: std::collections::HashSet::new(),
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
                let app = title_app.clone();
                let nonce = title_nonce.clone();
                tauri::async_runtime::spawn(async move {
                    update_session_tab(&app, tab_id, &nonce, |t| t.title = title);
                });
            });

        // CEF's default creates an unmanaged native popup that has no Dive tab,
        // lifecycle, or MCP session. Cancel it and defer a normal tracked tab
        // open to the event loop instead of re-entering CEF from its callback.
        let popup_app = app.clone();
        let popup_workspace = tab.workspace_id;
        builder = builder.on_new_window(move |url, _features| {
            let app = popup_app.clone();
            tauri::async_runtime::spawn(async move {
                let schedule = app.clone();
                if let Err(error) = app.run_on_main_thread(move || {
                    let Some(main) = MainThread::here() else {
                        tracing::warn!(%url, "popup open reached the wrong thread");
                        return;
                    };
                    let Some(workspace) = popup_workspace else {
                        tracing::warn!(%url, "popup source has no workspace");
                        return;
                    };
                    let state = schedule.state::<AppState>();
                    if let Err(error) =
                        crate::commands::open_tab(&main, &schedule, &state, workspace, url.as_str())
                    {
                        tracing::warn!(%url, %error, "opening popup as a tab failed");
                    }
                }) {
                    tracing::warn!(%error, "queueing popup tab failed");
                }
            });
            tauri::webview::NewWindowResponse::Deny
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
                // the callback that reported the navigation.
                let zoom_app = nav_app.clone();
                let zoom_url = url.clone();
                let _ = nav_app.run_on_main_thread(move || {
                    apply_site_zoom(&zoom_app, tab_id, &zoom_url);
                });
                let app = nav_app.clone();
                let nonce = nav_nonce.clone();
                tauri::async_runtime::spawn(async move {
                    update_session_tab(&app, tab_id, &nonce, |t| t.url = url);
                });
            });
        }

        let view = self
            .window
            .add_child(builder, self.bounds.position(), self.bounds.size())?;
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
            let (console_ready, network_ready, interception_ready, fill_ready, loading_ready) =
                if feeds {
                    let c = crate::console::attach(app.clone(), tab_id, session.clone());
                    let n = crate::network::attach(
                        app.clone(),
                        tab_id,
                        session.clone(),
                        view.label().to_owned(),
                    );
                    crate::favicon::attach(app.clone(), tab_id, session.clone());
                    let loading = crate::loading::attach(app.clone(), tab_id, session.clone());
                    let f = crate::filltab::attach(app.clone(), tab_id, session.clone());
                    let r = crate::rules::attach(
                        app.clone(),
                        tab_id,
                        tab.workspace_id,
                        session.clone(),
                    );
                    crate::inspect::watch(app.clone(), tab_id, &session);
                    crate::crash::watch(
                        app.clone(),
                        tab_id,
                        view.label().to_owned(),
                        session.clone(),
                    );
                    (c, n, r, f, loading)
                } else {
                    let (ct, cr) = tokio::sync::oneshot::channel();
                    let (nt, nr) = tokio::sync::oneshot::channel();
                    let (rt, rr) = tokio::sync::oneshot::channel();
                    let (ft, fr) = tokio::sync::oneshot::channel();
                    let (lt, lr) = tokio::sync::oneshot::channel();
                    let _ = (
                        ct.send(()),
                        nt.send(()),
                        rt.send(()),
                        ft.send(()),
                        lt.send(()),
                    );
                    (cr, nr, rr, fr, lr)
                };
            let session_for_prefs = session.clone();
            self.cdp.insert(tab_id, session);
            let nav = view.clone();
            let prefs_app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = console_ready.await;
                let _ = network_ready.await;
                let _ = interception_ready.await;
                let _ = fill_ready.await;
                let _ = loading_ready.await;
                // Privacy preferences have to be in force before the document
                // request goes out, or the first load escapes them.
                let prefs = {
                    let state = prefs_app.state::<AppState>();
                    state.prefs.get(&state)
                };
                crate::privacy::attach_page(prefs_app.clone(), tab_id, session_for_prefs.clone())
                    .await;
                tracing::debug!(%tab_id, "privacy page setup complete before navigation");
                crate::permissions::attach_page(
                    prefs_app.clone(),
                    tab_id,
                    session_for_prefs.clone(),
                    nav.clone(),
                    permission_workspace,
                    permission_container,
                )
                .await;
                tracing::debug!(%tab_id, "permission page setup complete before navigation");
                crate::activity::attach(&activity, tab_id, &activity_nonce, &session_for_prefs)
                    .await;
                crate::prefs::apply(&session_for_prefs, &prefs).await;
                tracing::debug!(%tab_id, "browser preferences complete before navigation");
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
        self.views.insert(tab_id, view);
        Ok(())
    }

    /// `DevTools` protocol session for `id`, if the engine exposes one.
    pub fn cdp(&self, id: TabId) -> Option<CdpSession> {
        self.cdp.get(&id).cloned()
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

    /// Keep web content rendered while native chrome is masked above it.
    pub fn set_live_overlay(
        &mut self,
        chrome: &str,
        regions: Vec<Bounds>,
        active: bool,
    ) -> tauri::Result<()> {
        if active {
            self.live_overlays.insert(chrome.to_owned(), regions);
        } else {
            self.live_overlays.remove(chrome);
        }
        if chrome == CHROME_LABEL {
            self.covered = active;
        }
        self.update_overlay_mask(chrome, active)?;
        if chrome == CHROME_LABEL {
            self.apply_visibility()?;
        }
        Ok(())
    }

    fn update_overlay_mask(&self, chrome: &str, active: bool) -> tauri::Result<()> {
        #[cfg(all(feature = "cef", target_os = "macos"))]
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
                .flatten()
                .map(|b| [b.x, b.y, b.width, b.height])
                .collect::<Vec<_>>();
            let holes = crate::overlay_geometry::uncovered(&pages, &overlays);
            if let Some(view) = self.window.app_handle().get_webview(chrome) {
                view.with_webview(move |native| {
                    native.set_chrome_overlay_mask(&holes, active);
                })?;
            }
        }
        #[cfg(not(all(feature = "cef", target_os = "macos")))]
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
        if self.covered {
            self.focus_chrome();
        }
        for chrome in self.live_overlays.keys() {
            self.update_overlay_mask(chrome, true)?;
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
        self.panes = panes
            .into_iter()
            .filter(|p| self.views.contains_key(&p.tab) && !self.popouts.contains_key(&p.tab))
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

    /// Tear `id` off into its own window at `at` (logical, relative to the
    /// main window's origin), keeping the page exactly as it is: the native
    /// view is reparented, not recreated.
    pub fn detach(
        &mut self,
        app: &AppHandle<Runtime>,
        id: TabId,
        title: &str,
        at: Option<(f64, f64)>,
    ) -> tauri::Result<()> {
        if self.popouts.contains_key(&id) {
            return Ok(());
        }
        let view = self
            .views
            .get(&id)
            .cloned()
            .ok_or(tauri::Error::WebviewNotFound)?;
        let width = self.bounds.width.clamp(480.0, 1100.0);
        let height = (self.bounds.height + POPOUT_CHROME_HEIGHT).clamp(360.0, 900.0);
        let seq = POPOUT_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let chrome = popout_chrome_label(seq, id);
        let mut builder = tauri::window::WindowBuilder::new(app, popout_label(seq, id))
            .title(if crate::private_session::is_private() {
                "Dive — Private Window"
            } else if title.is_empty() {
                "Dive"
            } else {
                title
            })
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .background_color(GROUND)
            // Shown once its chrome has painted (below), so the window never
            // appears as a bare band with the page hanging under it.
            .visible(false)
            .inner_size(width, height)
            .min_inner_size(360.0, 240.0);
        if let Some((x, y)) = at {
            let scale = self.window.scale_factor()?;
            let origin = self.window.outer_position()?.to_logical::<f64>(scale);
            // The pointer sits on the tab pill it dragged; put the window so
            // that pill lands under it rather than a corner.
            builder = builder.position(
                (origin.x + x - 120.0).max(0.0),
                (origin.y + y - 20.0).max(0.0),
            );
        }
        let window = builder.build()?;
        // Nothing may fail between here and the reparent without taking the
        // window down again: an empty invisible window would keep the app
        // from exiting once every other window is gone.
        let window_guard = scopeguard_destroy(window.clone());
        let chrome_dev_url = if cfg!(debug_assertions) {
            app.config().build.dev_url.clone()
        } else {
            None
        };
        let chrome_popup_app = app.clone();
        let chrome_download_app = app.clone();
        let chrome_view = window.add_child(
            private_chrome(WebviewBuilder::new(
                chrome.clone(),
                WebviewUrl::App(format!("index.html?popout={id}").into()),
            ))
            .on_navigation(move |url| {
                crate::ipc_security::allowed_chrome_navigation(url, chrome_dev_url.as_ref())
            })
            .on_new_window(move |url, _| open_chrome_link(&chrome_popup_app, Some(id), url))
            .on_download(move |_, event| handle_download(&chrome_download_app, event, None))
            .background_color(GROUND)
            .on_page_load(|webview, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Finished {
                    reveal(&webview.window());
                }
            })
            .auto_resize(),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(width, height),
        )?;
        #[cfg(feature = "cef")]
        crate::permissions::attach_chrome(&chrome_view)?;
        reveal_soon(window.clone());
        crate::titlebar::keep_drags_in_chrome_soon(&window);
        view.reparent(&window)?;
        window_guard.disarm();
        #[cfg(all(feature = "cef", target_os = "macos"))]
        bind_detached_new_tab_shortcuts(&view, &chrome_view, &self.window);
        let bounds = popout_content_bounds(width, height);
        self.popouts.insert(
            id,
            Popout {
                window,
                bounds,
                chrome,
                address_focus: PopoutAddressFocus::default(),
                covered: false,
            },
        );
        self.panes.retain(|p| p.tab != id);
        if self.active == Some(id) {
            self.active = None;
        }
        view.set_bounds(tauri::Rect {
            position: bounds.position().into(),
            size: bounds.size().into(),
        })?;
        view.show()?;
        let _ = view.set_focus();
        self.apply_visibility()
    }

    /// Bring `id` back from its own window into the main one. The caller
    /// decides whether it becomes the active tab.
    pub fn attach(&mut self, id: TabId) -> tauri::Result<()> {
        if !self.popouts.contains_key(&id) {
            return Ok(());
        }
        // Reparent before forgetting the popout, so a failed move leaves the
        // tab where it was instead of in a window nobody tracks.
        if let Some(view) = self.views.get(&id) {
            view.reparent(&self.window)?;
            #[cfg(all(feature = "cef", target_os = "macos"))]
            refresh_new_tab_shortcut(view, &self.window);
            view.hide()?;
        }
        let Some(popout) = self.popouts.remove(&id) else {
            return Ok(());
        };
        self.live_overlays.remove(&popout.chrome);
        crate::private_session::reveal_main(&self.window)?;
        let _ = popout.window.destroy();
        let _ = self.window.set_focus();
        self.layout()
    }

    /// The popout chrome reports where its page should sit.
    pub fn set_popout_bounds(&mut self, id: TabId, bounds: Bounds) -> tauri::Result<()> {
        if let Some(p) = self.popouts.get_mut(&id) {
            p.bounds = bounds;
        }
        if let Some(view) = self.views.get(&id) {
            view.set_bounds(tauri::Rect {
                position: bounds.position().into(),
                size: bounds.size().into(),
            })?;
        }
        if let Some(popout) = self.popouts.get(&id)
            && self.live_overlays.contains_key(&popout.chrome)
        {
            self.update_overlay_mask(&popout.chrome, true)?;
        }
        Ok(())
    }

    /// Whether `id` is shown in its own window.
    pub fn is_detached(&self, id: TabId) -> bool {
        self.popouts.contains_key(&id)
    }

    /// Tabs shown in their own windows.
    pub fn detached(&self) -> Vec<TabId> {
        self.popouts.keys().copied().collect()
    }

    /// Raise the window holding `id`.
    /// Only the trusted new-window command grants this intent after detaching
    /// its newly created about:blank tab. Ordinary detach never requests it.
    pub fn request_popout_address_focus(&mut self, id: TabId) -> tauri::Result<()> {
        let popout = self
            .popouts
            .get_mut(&id)
            .ok_or(tauri::Error::WebviewNotFound)?;
        popout.address_focus.request();
        Ok(())
    }

    /// A receipt for this exact chrome generation. Successful focus is applied
    /// once, while retries return the granted intent without stealing focus.
    pub fn popout_ready(&mut self, id: TabId, caller_chrome: &str) -> tauri::Result<bool> {
        let popout = self
            .popouts
            .get_mut(&id)
            .ok_or(tauri::Error::WebviewNotFound)?;
        if popout.chrome != caller_chrome {
            return Err(tauri::Error::WebviewNotFound);
        }
        popout.address_focus.ready(|| {
            let chrome = popout
                .window
                .webviews()
                .into_iter()
                .find(|view| view.label() == caller_chrome)
                .ok_or(tauri::Error::WebviewNotFound)?;
            popout.window.set_focus()?;
            chrome.set_focus()
        })
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
        crate::private_session::reveal_main(&self.window)?;
        self.window.set_focus()?;
        chrome.set_focus()
    }

    pub fn focus_popout(&self, id: TabId) -> tauri::Result<()> {
        if let Some(p) = self.popouts.get(&id) {
            p.window.set_focus()?;
            if let Some(view) = self.views.get(&id) {
                let _ = view.set_focus();
            }
        }
        Ok(())
    }

    /// The tab whose popout window has keyboard focus, if any: menu commands
    /// and shortcuts belong to it rather than to the main window.
    pub fn focused_popout(&self) -> Option<TabId> {
        self.popouts
            .iter()
            .find(|(_, p)| p.window.is_focused().unwrap_or(false))
            .map(|(id, _)| *id)
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

    /// Keep a popout's title in step with its page.
    pub fn retitle_popout(&self, id: TabId, title: &str) {
        if let Some(p) = self.popouts.get(&id) {
            let _ = p.window.set_title(if crate::private_session::is_private() {
                "Dive — Private Window"
            } else if title.is_empty() {
                "Dive"
            } else {
                title
            });
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

    /// Destroy the view for `id`, if any.
    pub fn close(&mut self, id: TabId) -> tauri::Result<()> {
        if let Some(view) = self.views.get(&id) {
            view.close()?;
        }
        self.forget_closed(id);
        self.window
            .app_handle()
            .state::<AppState>()
            .activity
            .drop_tab(id);
        Ok(())
    }

    /// Forget a view after a successful native close transition.
    pub fn forget_closed(&mut self, id: TabId) {
        if let Some(session) = self.cdp.remove(&id) {
            session.close();
        }
        self.views.remove(&id);
        if let Some(popout) = self.popouts.remove(&id) {
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
    let sink = session.clone();
    view.on_dev_tools_protocol(move |protocol| {
        // `Message` carries the raw JSON for both results and events; the
        // other variants are pre-parsed duplicates we do not need.
        match protocol {
            tauri::CefDevToolsProtocol::Message(bytes) => match std::str::from_utf8(&bytes) {
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
            },
            tauri::CefDevToolsProtocol::MethodResult {
                message_id,
                success,
                result,
            } => {
                tracing::trace!(message_id, success, len = result.len(), "cdp method result");
            }
            tauri::CefDevToolsProtocol::Event { method, .. } => {
                tracing::trace!(%method, "cdp event");
            }
        }
    })?;
    Ok(session)
}

/// Title of the runtime's internal initial-load document; never persist it.
const PLACEHOLDER_TITLE: &str = "Tauri CEF Initial Load";

const BLANK_URL: &str = "about:blank";

fn label_for(id: TabId) -> String {
    static NEXT_VIEW: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let generation = NEXT_VIEW.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("tab-{id}-{generation}")
}

/// Label of the chrome webview inside the `seq`th popout window, for `id`.
fn popout_chrome_label(seq: u64, id: TabId) -> String {
    format!("chrome-pop-{seq}-{id}")
}

/// Settings key prefix for a site's remembered zoom factor.
pub const SITE_ZOOM_PREFIX: &str = "zoom:";

/// Put the view at the zoom the person last chose for `url`'s origin, or
/// the default. Skipped when the host is busy: a zoom that lands one
/// navigation late is better than a stall inside an engine callback.
fn apply_site_zoom(app: &AppHandle<Runtime>, tab_id: TabId, url: &str) {
    let state = app.state::<AppState>();
    let Some(origin) = dive_core::origin_of(url) else {
        return;
    };
    let factor = {
        let Ok(store) = state.store.try_lock() else {
            return;
        };
        store
            .setting(&format!("{SITE_ZOOM_PREFIX}{origin}"))
            .ok()
            .flatten()
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or_else(|| state.prefs.get(&state).default_zoom)
    };
    if let Ok(host) = state.host.try_lock()
        && let Some(host) = host.as_ref()
        && let Err(e) = host.with_view(tab_id, |v| v.set_zoom(factor))
    {
        tracing::debug!(%tab_id, "site zoom not applied: {e}");
    }
}

/// A late callback from a closing renderer must not overwrite its replacement.
fn update_session_tab(app: &AppHandle<Runtime>, id: TabId, nonce: &str, f: impl FnOnce(&mut Tab)) {
    let state = app.state::<AppState>();
    let _host = lock(&state.host);
    if state.activity.session_current(id, nonce) {
        update_tab(app, id, f);
    }
}

/// Apply `f` to the stored tab, persist it, and broadcast the change.
pub fn update_tab(app: &AppHandle<Runtime>, id: TabId, f: impl FnOnce(&mut Tab)) {
    let state = app.state::<AppState>();
    let store = lock(&state.store);
    let Ok(mut tab) = store.tab(id) else { return };
    let was = tab.url.clone();
    f(&mut tab);
    // The read above lends the tab its origin's remembered icon, which belongs
    // to the site it is leaving; a URL change has to re-key it or the old mark
    // gets written back against the new address.
    if tab.url != was {
        store.rekey_favicon(&mut tab);
    }
    if let Err(e) = store.upsert_tab(&tab) {
        tracing::warn!(%id, "failed to persist tab update: {e}");
        return;
    }
    if tab.url.starts_with("http")
        && !crate::private_session::is_private()
        && let Err(e) = store.record_visit(&tab.url, &tab.title, dive_core::Timestamp::now())
    {
        tracing::debug!("history write failed: {e}");
    }
    state.bus.publish(CoreEvent::TabUpserted(tab));
}

/// Settings key holding the main window's last position and size.
pub const WINDOW_BOUNDS: &str = "window_bounds";

/// The main window's frame, remembered across launches.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowBounds {
    /// Outer position, logical pixels.
    pub x: f64,
    /// Outer position, logical pixels.
    pub y: f64,
    /// Inner size, logical pixels.
    pub width: f64,
    /// Inner size, logical pixels.
    pub height: f64,
}

impl WindowBounds {
    /// Read `x,y,width,height`; anything malformed or too small is ignored.
    pub fn parse(s: &str) -> Option<Self> {
        let mut it = s.split(',').map(|p| p.trim().parse::<f64>().ok());
        let (x, y, width, height) = (it.next()??, it.next()??, it.next()??, it.next()??);
        if !(x.is_finite() && y.is_finite() && width >= 720.0 && height >= 480.0) {
            return None;
        }
        Some(Self {
            x,
            y,
            width,
            height,
        })
    }

    /// The form [`WindowBounds::parse`] reads.
    pub fn serialize(&self) -> String {
        format!("{},{},{},{}", self.x, self.y, self.width, self.height)
    }
}

/// Store the main window's frame at most every half second, for the bursts
/// of resize and move events a drag produces.
pub fn remember_window_bounds_throttled(window: &Window<Runtime>) {
    static LAST: Mutex<Option<std::time::Instant>> = Mutex::new(None);
    let now = std::time::Instant::now();
    {
        let mut last = crate::state::lock(&LAST);
        if last.is_some_and(|t| now.duration_since(t) < std::time::Duration::from_millis(500)) {
            return;
        }
        *last = Some(now);
    }
    remember_window_bounds(window);
}

/// Store the main window's current frame so the next launch opens there.
/// A full-screen frame is not one to come back to; the last windowed frame
/// stays on record instead.
pub fn remember_window_bounds(window: &Window<Runtime>) {
    if window.is_fullscreen().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
        return;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let pos = pos.to_logical::<f64>(scale);
    let size = size.to_logical::<f64>(scale);
    let bounds = WindowBounds {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    };
    let state = window.app_handle().state::<AppState>();
    if let Err(e) = crate::state::lock(&state.store).set_setting(WINDOW_BOUNDS, &bounds.serialize())
    {
        tracing::debug!("could not remember window bounds: {e}");
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
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .background_color(GROUND)
        .inner_size(width, height)
        .min_inner_size(720.0, 480.0);
    if let Some(b) = remembered {
        builder = builder.position(b.x, b.y);
    }
    // `DIVE_WINDOW_HIDDEN=1`: harness runs keep the window off screen so a
    // person at the machine cannot close a trial by accident.
    if std::env::var_os("DIVE_WINDOW_HIDDEN").is_some() {
        builder = builder.visible(false);
    }
    let window = builder.build()?;

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
    crate::permissions::attach_chrome(&chrome)?;
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
                let workspace = if let Some(tab) = source {
                    let Ok(tab) = lock(&state.store).tab(tab) else {
                        return;
                    };
                    tab.workspace_id.or(*lock(&state.active_workspace))
                } else {
                    *lock(&state.active_workspace)
                };
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
                    tracing::warn!(n, "chrome missed core events");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// Trusted chrome joins the same off-the-record context to keep the private
/// session alive even when every page tab is closed. Scheme/IPC routing still
/// uses the exact browser identity; pages never become trusted chrome.
fn private_chrome(builder: WebviewBuilder<Runtime>) -> WebviewBuilder<Runtime> {
    #[cfg(all(feature = "cef", target_os = "macos"))]
    let builder = builder.initialization_script(
        "Object.defineProperty(window, '__DIVE_LIVE_OVERLAYS__', {value:true});",
    );
    if crate::private_session::is_private() {
        builder.incognito(true)
            .data_directory(crate::state::profiles_root().join("private-session"))
            .initialization_script("Object.defineProperty(window, '__DIVE_PRIVATE__', {value:true, writable:false, configurable:false});")
    } else {
        builder
    }
}

#[cfg(test)]
mod tests {
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
    fn window_bounds_round_trip_and_reject_tiny_frames() {
        let b = WindowBounds {
            x: 12.0,
            y: -3.5,
            width: 1280.0,
            height: 820.0,
        };
        assert_eq!(WindowBounds::parse(&b.serialize()), Some(b));
        assert_eq!(WindowBounds::parse("1,2,100,100"), None);
        assert_eq!(WindowBounds::parse("garbage"), None);
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
    fn editor_downloads_use_configured_directory_and_preserve_existing_files() {
        let root = std::env::temp_dir().join(format!("dive-export-{}", TabId::new()));
        let dir = root.join("custom-downloads");
        let url = url::Url::parse("blob:https://tauri.localhost/test-export").unwrap();
        let suggestion = std::path::Path::new("/ignored/example.png");
        let first = download_destination(&dir, suggestion, &url).unwrap();
        assert_eq!(first, dir.join("example.png"));
        std::fs::write(&first, b"existing capture").unwrap();
        assert_eq!(
            download_destination(&dir, suggestion, &url).unwrap(),
            dir.join("example (1).png")
        );
        assert_eq!(std::fs::read(&first).unwrap(), b"existing capture");
        // A failed configured destination must not silently fall back elsewhere.
        assert!(download_destination(&first.join("child"), suggestion, &url).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unique_path_appends_counter() {
        let dir = std::env::temp_dir().join(format!("dive-dl-{}", TabId::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = unique_path(&dir, "/tmp/report.tar.gz");
        assert_eq!(first.file_name().unwrap(), "report.tar.gz");
        std::fs::write(&first, b"x").unwrap();
        assert_eq!(
            unique_path(&dir, "report.tar.gz").file_name().unwrap(),
            "report.tar (1).gz"
        );
        assert_eq!(unique_path(&dir, "noext").file_name().unwrap(), "noext");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
