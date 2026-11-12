//! Tabs torn off into their own windows: the popout record, tearing off, bringing back, and the window queries menus and focus use.

use dive_core::TabId;
use tauri::{AppHandle, LogicalPosition, LogicalSize, WebviewUrl, Window};

use super::downloads::handle_download;
use super::window_geometry::{POPOUT_MIN_HEIGHT, POPOUT_MIN_WIDTH, screen_areas};
use super::{
    AppWindowSpec, Bounds, GROUND, POPOUT_CHROME_HEIGHT, POPOUT_SEQ, PopoutAddressFocus, Runtime,
    TabHost, WebviewBuilder, open_chrome_link, popout_content_bounds, popout_label, private_chrome,
    reveal, reveal_soon, visible_position, watch_chrome_creation,
};
#[cfg(all(feature = "cef", target_os = "macos"))]
use super::{bind_detached_new_tab_shortcuts, refresh_new_tab_shortcut};

/// A tab living in its own window.
pub(super) struct Popout {
    pub(super) window: Window<Runtime>,
    pub(super) bounds: Bounds,
    /// Label of the chrome webview inside the window.
    pub(super) chrome: String,
    pub(super) address_focus: PopoutAddressFocus,
    pub(super) covered: bool,
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

/// Label of the chrome webview inside the `seq`th popout window, for `id`.
fn popout_chrome_label(seq: u64, id: TabId) -> String {
    format!("chrome-pop-{seq}-{id}")
}

impl TabHost {
    /// Tear `id` off into its own window at `at` (logical, relative to the
    /// main window's origin), keeping the page exactly as it is: the native
    /// view is reparented, not recreated.
    #[allow(clippy::too_many_lines)] // One place builds the window, its chrome and the reparent, in the order that keeps a failure from stranding a view.
    pub fn detach(
        &mut self,
        app: &AppHandle<Runtime>,
        id: TabId,
        title: &str,
        at: Option<(f64, f64)>,
        web_app: Option<&AppWindowSpec>,
    ) -> tauri::Result<()> {
        if self.popouts.contains_key(&id) {
            return Ok(());
        }
        let view = self
            .views
            .get(&id)
            .cloned()
            .ok_or(tauri::Error::WebviewNotFound)?;
        // An app window comes back at the frame it last had; a torn-off tab
        // is sized from the page it came from.
        let remembered = web_app.and_then(|spec| spec.bounds.as_ref());
        let width = remembered.map_or_else(
            || self.bounds.width.clamp(480.0, 1100.0),
            |b| b.width.clamp(360.0, 2400.0),
        );
        let height = remembered.map_or_else(
            || (self.bounds.height + POPOUT_CHROME_HEIGHT).clamp(360.0, 900.0),
            |b| b.height.clamp(240.0, 1600.0),
        );
        let seq = POPOUT_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let chrome = popout_chrome_label(seq, id);
        let mut builder = tauri::window::WindowBuilder::new(app, popout_label(seq, id))
            .title(if let Some(spec) = web_app {
                spec.name.as_str()
            } else if crate::private_session::is_private() {
                "Dive — Private Window"
            } else if title.is_empty() {
                "Dive"
            } else {
                title
            })
            .background_color(GROUND)
            // Shown once its chrome has painted (below), so the window never
            // appears as a bare band with the page hanging under it.
            .visible(false)
            .inner_size(width, height)
            .min_inner_size(POPOUT_MIN_WIDTH, POPOUT_MIN_HEIGHT);
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
        builder = builder.resizable(true).prevent_overflow();
        let screens = screen_areas(&self.window.available_monitors().unwrap_or_default());
        if let Some((x, y)) = remembered.and_then(|b| visible_position(b, &screens)) {
            builder = builder.position(x, y);
        } else if let Some((x, y)) = at {
            let scale = self.window.scale_factor()?;
            let origin = self.window.outer_position()?.to_logical::<f64>(scale);
            // The pointer sits on the tab pill it dragged; put the window so
            // that pill lands under it rather than a corner.
            builder = builder.position(
                (origin.x + x - 120.0).max(0.0),
                (origin.y + y - 20.0).max(0.0),
            );
        } else {
            builder = builder.center();
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
                WebviewUrl::App(
                    match web_app {
                        Some(spec) => format!(
                            "index.html?popout={id}&app={}",
                            url::form_urlencoded::byte_serialize(spec.id.as_bytes())
                                .collect::<String>()
                        ),
                        None => format!("index.html?popout={id}"),
                    }
                    .into(),
                ),
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
        {
            crate::permissions::attach_chrome(&chrome_view)?;
            watch_chrome_creation(&chrome_view, Some(id))?;
        }
        reveal_soon(window.clone());
        crate::titlebar::keep_drags_in_chrome_soon(&window);
        view.reparent(&window)?;
        window_guard.disarm();
        #[cfg(feature = "cef")]
        crate::page_menu::set_detached(&view, true);
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
        // Chrome may finish native creation after the page was reparented.
        // Queue its initial inactive mask on this exact chrome generation so
        // it goes below the page before navigation; later overlays keep FIFO order.
        if let Err(error) = self.update_overlay_mask(&self.popouts[&id].chrome, false) {
            if let Err(rollback) = self.attach(id) {
                tracing::error!(%rollback, "preserving page after initial popout mask failed");
            } else if let Err(restore) = self.apply_visibility() {
                tracing::error!(%restore, "restoring page visibility after popout rollback failed");
            }
            return Err(error);
        }
        if let Some(spec) = web_app {
            self.app_windows.insert(id, spec.id.clone());
        } else {
            self.app_windows.remove(&id);
        }
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
            #[cfg(feature = "cef")]
            crate::page_menu::set_detached(view, false);
            #[cfg(all(feature = "cef", target_os = "macos"))]
            refresh_new_tab_shortcut(view, &self.window);
            view.hide()?;
        }
        let Some(popout) = self.forget_popout(id) else {
            return Ok(());
        };
        self.live_overlays.remove(&popout.chrome);
        self.reveal_main()?;
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
    /// Drop a popout's bookkeeping, including any app it was showing.
    pub(super) fn forget_popout(&mut self, id: TabId) -> Option<Popout> {
        self.app_windows.remove(&id);
        self.popouts.remove(&id)
    }

    /// The installed app a popout shows, when it is an app window.
    pub fn app_for_tab(&self, id: TabId) -> Option<&str> {
        self.app_windows.get(&id).map(String::as_str)
    }

    /// The tab currently showing installed app `app_id`, if it has a window.
    pub fn tab_for_app(&self, app_id: &str) -> Option<TabId> {
        self.app_windows
            .iter()
            .find(|(_, app)| app.as_str() == app_id)
            .map(|(tab, _)| *tab)
    }

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

    /// Raise a popout window and put the keyboard in its page. Shown and
    /// unminimized first: an installed app relaunched from the Dock while
    /// its window sits in the Dock should come back, not merely be focused.
    pub fn focus_popout(&self, id: TabId) -> tauri::Result<()> {
        if let Some(p) = self.popouts.get(&id) {
            p.window.show()?;
            p.window.unminimize()?;
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
}
