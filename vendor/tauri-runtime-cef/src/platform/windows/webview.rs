// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use cef::ImplBrowserHost;
use tauri_runtime::dpi::{PhysicalPosition, PhysicalSize, Rect};
use tauri_utils::config::Color;
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::Gdi::{
        CombineRgn, CreateRectRgn, CreateRoundRectRgn, DeleteObject, MapWindowPoints, RGN_DIFF,
        RGN_OR, SetWindowRgn,
    },
    UI::HiDpi::GetDpiForWindow,
    UI::Shell::{DefSubclassProc, SetWindowSubclass},
    UI::WindowsAndMessaging::{
        DestroyWindow, GetParent, GetWindowRect, HWND_BOTTOM, HWND_TOP, SW_HIDE, SW_SHOW,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SetParent, SetWindowPos, ShowWindow,
        WINDOWPOS, WM_WINDOWPOSCHANGING,
    },
};

use crate::{webview::AppWebview, window::AppWindow};

const PIN_Z_ORDER_SUBCLASS_ID: usize = 124;
/// `dwRefData` of the pin subclass: whether it is currently vetoing.
const Z_ORDER_UNPINNED: usize = 0;
const Z_ORDER_PINNED: usize = 1;

/// Refuses every z-order change to a webview while the pin is engaged.
unsafe extern "system" fn pin_z_order_subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    pinned: usize,
) -> LRESULT {
    unsafe {
        if pinned == Z_ORDER_PINNED && msg == WM_WINDOWPOSCHANGING && lparam.0 != 0 {
            let window_pos = &mut *(lparam.0 as *mut WINDOWPOS);
            window_pos.flags |= SWP_NOZORDER;
        }

        DefSubclassProc(hwnd, msg, wparam, lparam)
    }
}

/// Engages or disengages the z-order pin.
///
/// Re-installing the same proc under the same id does not chain a second
/// subclass, it just updates `dwRefData` — so this both installs the pin the
/// first time and toggles it afterwards.
fn set_z_order_pinned(hwnd: HWND, pinned: bool) {
    let _ = unsafe {
        SetWindowSubclass(
            hwnd,
            Some(pin_z_order_subclass_proc),
            PIN_Z_ORDER_SUBCLASS_ID,
            if pinned {
                Z_ORDER_PINNED
            } else {
                Z_ORDER_UNPINNED
            },
        )
    };
}

/// Move a webview in the sibling z-order and pin it where it lands.
///
/// The pin vetoes z-order changes indiscriminately, including the runtime's
/// own, so every deliberate move has to lift it first and put it back after.
/// Raising the chrome over a page for an overlay goes through here for that
/// reason: without the lift the `SetWindowPos` is silently dropped and the
/// menu renders behind the page it is supposed to float over.
pub(crate) fn restack_pinned(hwnd: HWND, after: HWND) {
    set_z_order_pinned(hwnd, false);
    let _ = unsafe {
        SetWindowPos(
            hwnd,
            Some(after),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
    };
    set_z_order_pinned(hwnd, true);
}

impl AppWebview {
    pub(crate) fn hwnd(&self) -> HWND {
        let hwnd = self.host.window_handle();
        HWND(hwnd.0 as _)
    }

    pub(crate) fn set_background_color(&self, _color: Option<Color>) {
        // TODO: might not be supported on Windows
    }

    pub(crate) fn bounds(&self) -> Option<Rect> {
        let hwnd = self.hwnd();

        let mut rect = RECT::default();
        unsafe {
            let parent = GetParent(hwnd).ok()?;
            if parent.0.is_null() {
                return None;
            }

            GetWindowRect(hwnd, &mut rect).ok()?;

            let mut points = [
                POINT {
                    x: rect.left,
                    y: rect.top,
                },
                POINT {
                    x: rect.right,
                    y: rect.bottom,
                },
            ];
            if MapWindowPoints(None, Some(parent), &mut points) == 0 {
                return None;
            }

            let x = points[0].x;
            let y = points[0].y;
            let width = (points[1].x - points[0].x).max(0) as u32;
            let height = (points[1].y - points[0].y).max(0) as u32;
            Some(Rect {
                position: PhysicalPosition::new(x, y).into(),
                size: PhysicalSize::new(width, height).into(),
            })
        }
    }

    pub(crate) fn reparent(&self, parent: &AppWindow) {
        let parent = parent.hwnd();
        let _ = unsafe { SetParent(self.hwnd(), Some(parent)) };
    }

    pub(crate) fn apply_visible(&self, visible: bool) {
        let _ = unsafe { ShowWindow(self.hwnd(), if visible { SW_SHOW } else { SW_HIDE }) };
    }

    /// Destroys CEF's own window for this browser, completing a close that
    /// `do_close` took over. CEF's browser window procedure reports
    /// `WindowDestroyed` back to CEF on `WM_NCDESTROY`.
    pub(crate) fn destroy_host_window(&self) {
        let _ = unsafe { DestroyWindow(self.hwnd()) };
    }

    /// Raises this webview above its siblings and pins it there, so nothing but
    /// this runtime can move it again. See [`pin_z_order_subclass_proc`].
    pub(crate) fn raise_to_top(&self) {
        restack_pinned(self.hwnd(), HWND_TOP);
    }

    pub(crate) fn apply_physical_bounds(
        &self,
        _scale: f64,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) {
        unsafe {
            let _ = SetWindowPos(
                self.hwnd(),
                None,
                x,
                y,
                width,
                height,
                SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }
}

impl crate::webview::Webview {
    /// Let the chrome paint over the page everywhere except `holes`.
    ///
    /// The Windows counterpart of the macOS layer mask. There the chrome is
    /// one view above the pages with a `CAShapeLayer` punched through it;
    /// here the chrome is a sibling HWND, and a window region does the same
    /// job -- the window is drawn and hit-tested only inside its region, so
    /// subtracting the holes leaves the page reachable through them. Clipping
    /// hit-testing as well as painting is the point: a click outside an
    /// overlay has to reach the page beneath it.
    ///
    /// `holes` are the page rectangles that must stay visible, in the
    /// chrome's own logical coordinates, as the macOS side takes them.
    pub fn set_chrome_overlay_mask(
        &self,
        holes: &[[f64; 4]],
        overlays: &[[f64; 5]],
        active: bool,
    ) -> bool {
        use cef::ImplBrowser;
        let Some(host) = self.browser().host() else {
            return false;
        };
        let hwnd = HWND(host.window_handle().0 as _);
        log::info!(
            "overlay mask: hwnd={:?} active={active} holes={holes:?}",
            hwnd.0
        );
        if !active {
            // No region is "all of it", and the chrome drops back beneath the
            // pages so they take the clicks again.
            unsafe {
                let _ = SetWindowRgn(hwnd, None, true);
            }
            restack_pinned(hwnd, HWND_BOTTOM);
            return true;
        }

        let mut rect = RECT::default();
        if unsafe { GetWindowRect(hwnd, &mut rect) }.is_err() {
            return false;
        }
        let (width, height) = (rect.right - rect.left, rect.bottom - rect.top);
        // The window is sized in physical pixels; the holes arrive logical.
        let dpi = unsafe { GetDpiForWindow(hwnd) };
        let scale = if dpi == 0 { 1.0 } else { f64::from(dpi) / 96.0 };
        // Position and extent are rounded separately, the way a page view's own
        // bounds are (`to_physical` on each), so a hole lands exactly on the
        // view it is cut for. Rounding the far edge from the sum instead left
        // a one-pixel seam of chrome over the page at fractional scales.
        #[allow(clippy::cast_possible_truncation)]
        let px = |v: f64| (v * scale).round() as i32;

        let region = unsafe { CreateRectRgn(0, 0, width, height) };
        if region.is_invalid() {
            return false;
        }
        for [x, y, w, h] in holes {
            let hole = unsafe { CreateRectRgn(px(*x), px(*y), px(*x) + px(*w), px(*y) + px(*h)) };
            if hole.is_invalid() {
                continue;
            }
            unsafe {
                CombineRgn(Some(region), Some(region), Some(hole), RGN_DIFF);
                let _ = DeleteObject(hole.into());
            }
        }
        // Union rounded surfaces after subtracting page bounds. Combining each
        // surface with OR keeps nested and overlapping menus fully visible.
        for [x, y, w, h, radius] in overlays {
            let surface = unsafe {
                if *radius > 0.0 {
                    CreateRoundRectRgn(
                        px(*x),
                        px(*y),
                        px(*x) + px(*w),
                        px(*y) + px(*h),
                        px(radius * 2.0),
                        px(radius * 2.0),
                    )
                } else {
                    CreateRectRgn(px(*x), px(*y), px(*x) + px(*w), px(*y) + px(*h))
                }
            };
            if surface.is_invalid() {
                continue;
            }
            unsafe {
                CombineRgn(Some(region), Some(region), Some(surface), RGN_OR);
                let _ = DeleteObject(surface.into());
            }
        }
        // The region belongs to the window once this succeeds, so it must not
        // be deleted here; on failure it would leak, so it is freed instead.
        let applied = unsafe { SetWindowRgn(hwnd, Some(region), true) } != 0;
        log::info!("overlay mask: window {width}x{height} scale={scale} applied={applied}");
        if !applied {
            unsafe {
                let _ = DeleteObject(region.into());
            }
            return false;
        }
        // Above the pages, so what it paints is what shows through.
        restack_pinned(hwnd, HWND_TOP);
        true
    }
}
