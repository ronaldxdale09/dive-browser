//! Engine layer: the main window, the chrome webview and one child webview
//! per open tab. Everything here talks to Tauri; nothing knows about React.

use std::collections::HashMap;
use std::path::PathBuf;

use dive_cdp::CdpSession;
use dive_core::{Container, CoreEvent, Tab, TabId};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::webview::{DownloadEvent, WebviewBuilder};
use tauri::{App, AppHandle, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl, Window};
use tauri_specta::Event;

use crate::state::{AppState, lock};
use crate::{CHROME_LABEL, MAIN_WINDOW, Runtime};

/// A download started or finished; shown as a toast.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct DownloadNotice {
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
pub struct TabHost {
    window: Window<Runtime>,
    views: HashMap<TabId, Webview<Runtime>>,
    cdp: HashMap<TabId, CdpSession>,
    bounds: Bounds,
    active: Option<TabId>,
    profiles_root: PathBuf,
}

impl TabHost {
    fn new(window: Window<Runtime>, profiles_root: PathBuf) -> Self {
        Self {
            window,
            views: HashMap::new(),
            cdp: HashMap::new(),
            bounds: Bounds {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            active: None,
            profiles_root,
        }
    }

    /// Create the engine view for `tab` inside `container`'s profile.
    pub fn open(
        &mut self,
        app: &AppHandle<Runtime>,
        tab: &Tab,
        container: &Container,
    ) -> tauri::Result<()> {
        let url: url::Url = tab
            .url
            .parse()
            .map_err(|_| tauri::Error::InvalidUrl(url::ParseError::RelativeUrlWithoutBase))?;
        let tab_id = tab.id;

        let title_app = app.clone();
        #[allow(unused_mut)]
        let mut builder = WebviewBuilder::new(label_for(tab_id), WebviewUrl::External(blank_url()))
            .data_directory(self.profiles_root.join(&container.cache_dir))
            .on_document_title_changed(move |_, title| {
                if title == PLACEHOLDER_TITLE {
                    return;
                }
                update_tab(&title_app, tab_id, |t| t.title = title);
            });

        let dl_app = app.clone();
        builder = builder.on_download(move |_, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let dir = downloads_dir();
                    let _ = std::fs::create_dir_all(&dir);
                    let suggested = destination
                        .file_name()
                        .and_then(|n| n.to_str())
                        .map_or_else(
                            || {
                                url.path_segments()
                                    .and_then(|mut s| s.next_back())
                                    .filter(|s| !s.is_empty())
                                    .unwrap_or("download")
                                    .to_owned()
                            },
                            str::to_owned,
                        );
                    *destination = unique_path(&dir, &suggested);
                    let _ = DownloadNotice {
                        url: url.to_string(),
                        path: destination.to_string_lossy().into_owned(),
                        status: "started".into(),
                    }
                    .emit(&dl_app);
                }
                DownloadEvent::Finished { url, path, success } => {
                    let _ = DownloadNotice {
                        url: url.to_string(),
                        path: path
                            .map(|p| p.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                        status: if success {
                            "finished".into()
                        } else {
                            "failed".into()
                        },
                    }
                    .emit(&dl_app);
                }
                _ => {}
            }
            true
        });

        #[cfg(feature = "cef")]
        {
            let nav_app = app.clone();
            builder = builder.on_address_change(move |_, url| {
                // Views start on about:blank; that hop must not replace the
                // tab's real URL or a restart would restore an empty tab.
                if *url == blank_url() {
                    return;
                }
                let url = url.to_string();
                update_tab(&nav_app, tab_id, |t| t.url = url);
            });
        }

        let view = self
            .window
            .add_child(builder, self.bounds.position(), self.bounds.size())?;
        view.hide()?;
        // The view starts blank so the DevTools feeds are listening before the
        // first navigation; otherwise the document request and early console
        // output are missed.
        #[cfg(feature = "cef")]
        {
            let session = attach_cdp(&view)?;
            let console_ready = crate::console::attach(app.clone(), tab_id, session.clone());
            let network_ready = crate::network::attach(app.clone(), tab_id, session.clone());
            crate::favicon::attach(app.clone(), tab_id, session.clone());
            self.cdp.insert(tab_id, session);
            let nav = view.clone();
            tauri::async_runtime::spawn(async move {
                let _ = console_ready.await;
                let _ = network_ready.await;
                if let Err(e) = nav.navigate(url) {
                    tracing::warn!(%tab_id, "initial navigation failed: {e}");
                }
            });
        }
        #[cfg(not(feature = "cef"))]
        view.navigate(url)?;
        self.views.insert(tab_id, view);
        Ok(())
    }

    /// `DevTools` protocol session for `id`, if the engine exposes one.
    pub fn cdp(&self, id: TabId) -> Option<CdpSession> {
        self.cdp.get(&id).cloned()
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
    pub fn activate(&mut self, id: TabId) -> tauri::Result<()> {
        for (tab, view) in &self.views {
            if *tab == id {
                view.show()?;
                let _ = view.set_focus();
            } else {
                view.hide()?;
            }
        }
        self.active = Some(id);
        Ok(())
    }

    /// Hide every tab view (used when switching workspaces).
    pub fn deactivate_all(&mut self) -> tauri::Result<()> {
        for view in self.views.values() {
            view.hide()?;
        }
        self.active = None;
        Ok(())
    }

    /// Destroy the view for `id`, if any.
    pub fn close(&mut self, id: TabId) -> tauri::Result<()> {
        if let Some(session) = self.cdp.remove(&id) {
            session.close();
        }
        if let Some(view) = self.views.remove(&id) {
            view.close()?;
        }
        if self.active == Some(id) {
            self.active = None;
        }
        Ok(())
    }

    /// Navigate `id`'s view.
    pub fn navigate(&self, id: TabId, url: url::Url) -> tauri::Result<()> {
        match self.views.get(&id) {
            Some(view) => view.navigate(url),
            None => Err(tauri::Error::WebviewNotFound),
        }
    }

    /// Move and resize every tab view to the content rectangle.
    pub fn set_bounds(&mut self, bounds: Bounds) -> tauri::Result<()> {
        self.bounds = bounds;
        for view in self.views.values() {
            view.set_bounds(tauri::Rect {
                position: bounds.position().into(),
                size: bounds.size().into(),
            })?;
        }
        Ok(())
    }

    /// Currently shown tab.
    pub fn active(&self) -> Option<TabId> {
        self.active
    }

    /// Whether a view exists for `id`.
    pub fn has(&self, id: TabId) -> bool {
        self.views.contains_key(&id)
    }
}

/// Bridge a CEF webview's `DevTools` channel into a [`CdpSession`].
#[cfg(feature = "cef")]
fn attach_cdp(view: &Webview<Runtime>) -> tauri::Result<CdpSession> {
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
                        head = &text[..text.len().min(160)],
                        "cdp <-"
                    );
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

fn blank_url() -> url::Url {
    url::Url::parse("about:blank").expect("static url")
}

fn label_for(id: TabId) -> String {
    format!("tab-{id}")
}

/// Apply `f` to the stored tab, persist it, and broadcast the change.
pub fn update_tab(app: &AppHandle<Runtime>, id: TabId, f: impl FnOnce(&mut Tab)) {
    let state = app.state::<AppState>();
    let store = lock(&state.store);
    let Ok(mut tab) = store.tab(id) else { return };
    f(&mut tab);
    if let Err(e) = store.upsert_tab(&tab) {
        tracing::warn!(%id, "failed to persist tab update: {e}");
        return;
    }
    if tab.url.starts_with("http")
        && let Err(e) = store.record_visit(&tab.url, &tab.title, dive_core::Timestamp::now())
    {
        tracing::debug!("history write failed: {e}");
    }
    state.bus.publish(CoreEvent::TabUpserted(tab));
}

/// Build the main window with the chrome webview filling it.
pub fn create_main_window(app: &App<Runtime>) -> tauri::Result<()> {
    let width = 1280.0;
    let height = 820.0;
    let window = tauri::window::WindowBuilder::new(app, MAIN_WINDOW)
        .title("Dive")
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .inner_size(width, height)
        .min_inner_size(720.0, 480.0)
        .build()?;

    let _chrome = window.add_child(
        WebviewBuilder::new(CHROME_LABEL, WebviewUrl::App("index.html".into())).auto_resize(),
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(width, height),
    )?;

    let state = app.state::<AppState>();
    *lock(&state.host) = Some(TabHost::new(window, crate::state::profiles_root()));

    forward_events(app.handle().clone(), state.bus.subscribe());
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

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
