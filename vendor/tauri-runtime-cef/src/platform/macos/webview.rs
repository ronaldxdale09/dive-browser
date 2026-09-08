// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use cef::ImplBrowserHost;
use objc2::rc::Retained;
use objc2_app_kit::{NSColor, NSView};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use tauri_runtime::dpi::{LogicalPosition, LogicalSize, Rect};
use tauri_utils::config::Color;

use crate::{webview::AppWebview, window::AppWindow};

use super::utils;

impl AppWebview {
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

  pub(crate) fn apply_physical_bounds(&self, scale: f64, x: i32, y: i32, width: i32, height: i32) {
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
    if MainThreadMarker::new().is_none() { return false; }
    let Some(host) = self.browser().host() else { return false; };
    // SAFETY: the live BrowserHost owns this NSView; all operations are on the
    // AppKit main thread and the retained handle spans this synchronous call.
    let Some(view) = (unsafe { Retained::<NSView>::retain(host.window_handle().cast()) }) else { return false; };
    view.setWantsLayer(true);
    let Some(layer) = view.layer() else { return false; };
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
    if MainThreadMarker::new().is_none() { return false; }
    let Some(host) = self.browser().host() else { return false; };
    // SAFETY: the live BrowserHost owns this NSView; all operations are on the
    // AppKit main thread and the retained handle spans this synchronous call.
    let Some(view) = (unsafe { Retained::<NSView>::retain(host.window_handle().cast()) }) else { return false; };
    let Some(parent) = (unsafe { view.superview() }) else { return false; };
    view.setWantsLayer(true);
    let Some(layer) = view.layer() else { return false; };
    CATransaction::begin();
    CATransaction::setDisableActions(true);
    if active {
      let bounds = layer.bounds();
      let path = CGMutablePath::new();
      // SAFETY: null transform is the identity; each rectangle is validated by
      // the chrome command and expressed in this view's logical coordinate space.
      unsafe { CGMutablePath::add_rect(Some(&path), std::ptr::null(), bounds); }
      for [x, y, width, height] in holes {
        // The new CAShapeLayer has its own unflipped Core Graphics path space,
        // regardless of the host layer's isGeometryFlipped value. Convert from
        // chrome's top-left coordinates exactly once for this mask.
        let rect = NSRect::new(NSPoint::new(*x, bounds.size.height - y - height), NSSize::new(*width, *height));
        unsafe { CGMutablePath::add_rect(Some(&path), std::ptr::null(), rect); }
      }
      let mask = CAShapeLayer::layer();
      mask.setFrame(bounds);
      mask.setPath(Some(&path));
      mask.setFillRule(unsafe { kCAFillRuleEvenOdd });
      // SAFETY: the fresh mask has no superlayer, so this cannot form a cycle.
      unsafe { layer.setMask(Some(&mask)); }
      parent.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Above, None);
    } else {
      // SAFETY: removing a mask cannot introduce a layer ownership cycle.
      unsafe { layer.setMask(None); }
      parent.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Below, None);
    }
    CATransaction::commit();
    true
  }
}
