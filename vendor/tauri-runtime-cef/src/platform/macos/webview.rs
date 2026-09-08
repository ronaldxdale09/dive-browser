// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use cef::ImplBrowserHost;
use objc2::MainThreadMarker;
use objc2::rc::Retained;
use objc2_app_kit::{NSApplication, NSColor, NSView};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use tauri_runtime::dpi::{LogicalPosition, LogicalSize, Rect};
use tauri_utils::config::Color;

use crate::{webview::AppWebview, window::AppWindow};

use super::utils;

/// Where a DevTools window opens, in top-left screen coordinates. It is a
/// real working size (not CEF's 640×608 default), sits a little down and
/// right of the page it inspects, and stays on the screen.
pub(crate) fn devtools_bounds(page: (f64, f64, f64, f64), screen: (f64, f64)) -> (i32, i32, i32, i32) {
    let (px, py, pw, ph) = page;
    let (sw, sh) = screen;
    let width = (pw * 0.7).max(960.0).min(sw);
    let height = (ph * 0.85).max(700.0).min(sh);
    let x = (px + 48.0).min((sw - width).max(0.0)).max(0.0);
    let y = (py + 48.0).min((sh - height).max(0.0)).max(0.0);
    (x.round() as i32, y.round() as i32, width.round() as i32, height.round() as i32)
}

/// Chrome sizes the DevTools window it opens (CEF's `WindowInfo` bounds
/// are ignored in Chrome style), so the fresh window is moved after the
/// fact. Only a window still at Chrome's small default is touched; one the
/// person has sized is theirs. Returns whether a window was placed.
pub(crate) fn place_devtools_window(bounds: (i32, i32, i32, i32), mtm: MainThreadMarker) -> bool {
    let (x, y, width, height) = bounds;
    let app = NSApplication::sharedApplication(mtm);
    for window in app.windows().iter() {
        if !window.title().to_string().starts_with("DevTools") {
            continue;
        }
        let frame = window.frame();
        if frame.size.width > 700.0 {
            continue;
        }
        let screen_height = window.screen().map_or(0.0, |screen| screen.frame().size.height);
        let rect = NSRect::new(
            NSPoint::new(f64::from(x), screen_height - f64::from(y + height)),
            NSSize::new(f64::from(width), f64::from(height)),
        );
        window.setFrame_display(rect, true);
        return true;
    }
    false
}

impl AppWebview {
    /// Where DevTools for this page should open, in top-left screen
    /// coordinates; `None` when the page is not in a window on a screen.
    pub(crate) fn devtools_bounds_now(&self) -> Option<(i32, i32, i32, i32)> {
        let nsview = self.nsview();
        let window = nsview.window()?;
        let screen = window.screen()?;
        let frame = window.frame();
        let visible = screen.frame();
        // AppKit measures from the bottom-left; the placement wants the top-left.
        let top = visible.size.height - (frame.origin.y + frame.size.height);
        Some(devtools_bounds(
            (frame.origin.x, top, frame.size.width, frame.size.height),
            (visible.size.width, visible.size.height),
        ))
    }

    pub(crate) fn nsview(&self) -> Retained<NSView> {
        let handle = self.host.window_handle();
        let view = handle.cast::<NSView>();
        unsafe { Retained::<NSView>::retain(view).expect("failed to retain NSView") }
    }

    pub(crate) fn set_background_color(&self, color: Option<Color>) {
        let nsview = self.nsview();

        nsview.setWantsLayer(true);

        let Some(layer) = nsview.layer() else {
            return;
        };

        let nscolor = color
            .map(utils::ns_color_from_tauri_color)
            .unwrap_or_else(NSColor::windowBackgroundColor);

        let cg_color = nscolor.CGColor();
        layer.setBackgroundColor(Some(&*cg_color));
    }

    pub(crate) fn bounds(&self) -> Option<Rect> {
        let nsview = self.nsview();

        let parent = unsafe { nsview.superview()? };
        let parent_frame = parent.frame();
        let frame = nsview.frame();

        let y = if parent.isFlipped() {
            frame.origin.y
        } else {
            parent_frame.size.height - frame.origin.y - frame.size.height
        };

        let position = LogicalPosition::new(frame.origin.x, y);
        let size = LogicalSize::new(frame.size.width, frame.size.height);

        Some(Rect {
            position: position.into(),
            size: size.into(),
        })
    }

    pub(crate) fn reparent(&self, parent: &AppWindow) {
        let view = self.nsview();
        let parent = parent.nsview();

        parent.addSubview(&view);
    }

    pub(crate) fn apply_visible(&self, visible: bool) {
        let nsview = self.nsview();

        nsview.setHidden(!visible);
    }

    /// Destroys CEF's own view for this browser, completing a close that
    /// `do_close` took over.
    ///
    /// The superview holds the only strong reference to that view, so dropping it
    /// deallocates the view — and its `dealloc` is what reports `WindowDestroyed`
    /// back to CEF. A layer-backed view (rounded corners, an overlay mask) is
    /// also held by Core Animation until its backing is gone: with the layer
    /// still attached the view outlived its window and the browser never
    /// closed, so the backing comes off first.
    pub(crate) fn destroy_host_window(&self) {
        let nsview = self.nsview();
        // The window retains its first responder. A view that still holds it
        // (or whose render widget subview does) survives removal from the
        // hierarchy, so hand focus back to the window before letting go.
        if let Some(window) = nsview.window()
            && let Some(responder) = window.firstResponder()
            && let Ok(focused) = responder.downcast::<NSView>()
            && (*focused == *nsview || focused.isDescendantOf(&nsview))
        {
            let _ = window.makeFirstResponder(None);
        }
        if let Some(layer) = nsview.layer() {
            // SAFETY: dropping a mask cannot form a layer cycle.
            unsafe { layer.setMask(None) };
        }
        nsview.setWantsLayer(false);
        nsview.removeFromSuperview();
    }

    pub(crate) fn apply_physical_bounds(
        &self,
        scale: f64,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) {
        let nsview = self.nsview();
        let Some(parent) = (unsafe { nsview.superview() }) else {
            return;
        };

        // CEF provides child bounds as physical pixels, but NSView frames are logical pixels.
        let x = x as f64 / scale;
        let y = y as f64 / scale;
        let width = width as f64 / scale;
        let height = height as f64 / scale;

        let parent_frame = parent.frame();
        let y = if parent.isFlipped() {
            y
        } else {
            parent_frame.size.height - (y + height)
        };

        let frame = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
        nsview.setFrame(frame);
    }
}

/// A live overlay clips chrome, not the page. The page never receives WasHidden,
/// and chrome owns clicks outside its visible mask so the DOM scrim can dismiss
/// a menu or keep a modal's focus trap. Closing restores the normal view order.
impl crate::webview::Webview {
    /// Round the view's corners by clipping its layer. Zero restores square
    /// corners. Main thread only; false when the view has no layer yet.
    pub fn set_corner_radius(&self, radius: f64) -> bool {
        use cef::ImplBrowser;
        use objc2::MainThreadMarker;
        use objc2_quartz_core::CATransaction;
        if MainThreadMarker::new().is_none() {
            return false;
        }
        let Some(host) = self.browser().host() else {
            return false;
        };
        // SAFETY: the live BrowserHost owns this NSView; all operations are on the
        // AppKit main thread and the retained handle spans this synchronous call.
        let Some(view) = (unsafe { Retained::<NSView>::retain(host.window_handle().cast()) })
        else {
            return false;
        };
        view.setWantsLayer(true);
        let Some(layer) = view.layer() else {
            return false;
        };
        CATransaction::begin();
        CATransaction::setDisableActions(true);
        layer.setCornerRadius(radius.max(0.0));
        layer.setMasksToBounds(radius > 0.0);
        CATransaction::commit();
        true
    }

    pub fn set_chrome_overlay_mask(&self, holes: &[[f64; 4]], active: bool) -> bool {
        use cef::ImplBrowser;
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSWindowOrderingMode;
        use objc2_core_graphics::CGMutablePath;
        use objc2_quartz_core::{CAShapeLayer, CATransaction, kCAFillRuleEvenOdd};
        if MainThreadMarker::new().is_none() {
            return false;
        }
        let Some(host) = self.browser().host() else {
            return false;
        };
        // SAFETY: the live BrowserHost owns this NSView; all operations are on the
        // AppKit main thread and the retained handle spans this synchronous call.
        let Some(view) = (unsafe { Retained::<NSView>::retain(host.window_handle().cast()) })
        else {
            return false;
        };
        let Some(parent) = (unsafe { view.superview() }) else {
            return false;
        };
        view.setWantsLayer(true);
        let Some(layer) = view.layer() else {
            return false;
        };
        CATransaction::begin();
        CATransaction::setDisableActions(true);
        if active {
            let bounds = layer.bounds();
            let path = CGMutablePath::new();
            // SAFETY: null transform is the identity; each rectangle is validated by
            // the chrome command and expressed in this view's logical coordinate space.
            unsafe {
                CGMutablePath::add_rect(Some(&path), std::ptr::null(), bounds);
            }
            for [x, y, width, height] in holes {
                // The new CAShapeLayer has its own unflipped Core Graphics path space,
                // regardless of the host layer's isGeometryFlipped value. Convert from
                // chrome's top-left coordinates exactly once for this mask.
                let rect = NSRect::new(
                    NSPoint::new(*x, bounds.size.height - y - height),
                    NSSize::new(*width, *height),
                );
                unsafe {
                    CGMutablePath::add_rect(Some(&path), std::ptr::null(), rect);
                }
            }
            let mask = CAShapeLayer::layer();
            mask.setFrame(bounds);
            mask.setPath(Some(&path));
            mask.setFillRule(unsafe { kCAFillRuleEvenOdd });
            // SAFETY: the fresh mask has no superlayer, so this cannot form a cycle.
            unsafe {
                layer.setMask(Some(&mask));
            }
            parent.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Above, None);
        } else {
            // SAFETY: removing a mask cannot introduce a layer ownership cycle.
            unsafe {
                layer.setMask(None);
            }
            parent.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Below, None);
        }
        CATransaction::commit();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::devtools_bounds;

    #[test]
    fn devtools_opens_at_a_working_size_beside_the_page_and_on_screen() {
        // A roomy window: 70% of its size, offset down and right.
        assert_eq!(devtools_bounds((100.0, 50.0, 1600.0, 1000.0), (2560.0, 1440.0)), (148, 98, 1120, 850));
        // A small window still gets a usable DevTools.
        assert_eq!(devtools_bounds((0.0, 0.0, 800.0, 600.0), (2560.0, 1440.0)), (48, 48, 960, 700));
        // Near the screen edge it is pulled back so it stays visible.
        assert_eq!(devtools_bounds((1900.0, 900.0, 1400.0, 900.0), (2560.0, 1440.0)), (1580, 675, 980, 765));
        // A screen smaller than the minimum: no larger than the screen.
        assert_eq!(devtools_bounds((0.0, 0.0, 900.0, 600.0), (900.0, 600.0)), (0, 0, 900, 600));
    }
}
