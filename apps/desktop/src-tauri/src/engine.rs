//! Engine layer: the main window, the chrome webview and one child webview
//! per open tab. Everything here talks to Tauri; nothing knows about React.

use std::collections::HashMap;
use std::path::PathBuf;

use dive_cdp::CdpSession;
use dive_core::{Container, CoreEvent, Tab, TabId};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::webview::WebviewBuilder;
use tauri::{App, AppHandle, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl, Window};

use crate::state::{AppState, lock};
use crate::{CHROME_LABEL, MAIN_WINDOW, Runtime};

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
        let mut builder = WebviewBuilder::new(label_for(tab_id), WebviewUrl::External(url))
            .data_directory(self.profiles_root.join(&container.cache_dir))
            .on_document_title_changed(move |_, title| {
                update_tab(&title_app, tab_id, |t| t.title = title);
            });

        #[cfg(feature = "cef")]
        {
            let nav_app = app.clone();
            builder = builder.on_address_change(move |_, url| {
                let url = url.to_string();
                update_tab(&nav_app, tab_id, |t| t.url = url);
            });
        }

        let view = self
            .window
            .add_child(builder, self.bounds.position(), self.bounds.size())?;
        view.hide()?;
        #[cfg(feature = "cef")]
        self.cdp.insert(tab_id, attach_cdp(&view)?);
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
        if let tauri::CefDevToolsProtocol::Message(bytes) = protocol
            && let Ok(text) = std::str::from_utf8(&bytes)
            && let Err(e) = sink.handle_incoming(text)
        {
            tracing::debug!("ignoring malformed cdp message: {e}");
        }
    })?;
    Ok(session)
}

fn label_for(id: TabId) -> String {
    format!("tab-{id}")
}

/// Apply `f` to the stored tab, persist it, and broadcast the change.
fn update_tab(app: &AppHandle<Runtime>, id: TabId, f: impl FnOnce(&mut Tab)) {
    let state = app.state::<AppState>();
    let store = lock(&state.store);
    let Ok(mut tab) = store.tab(id) else { return };
    f(&mut tab);
    if let Err(e) = store.upsert_tab(&tab) {
        tracing::warn!(%id, "failed to persist tab update: {e}");
        return;
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

    let chrome = window.add_child(
        WebviewBuilder::new(CHROME_LABEL, WebviewUrl::App("index.html".into())).auto_resize(),
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(width, height),
    )?;
    #[cfg(debug_assertions)]
    chrome.open_devtools();

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
