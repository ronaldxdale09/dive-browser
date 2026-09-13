//! Windows regions clip painting and hit testing together. A modal therefore
//! keeps the page HWND visible but disables its input, and forwards clicks
//! delivered to the parent through those holes to the trusted chrome scrim.
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
};

use cef::{ImplBrowserHost, MouseButtonType, MouseEvent};
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM},
    Graphics::Gdi::MapWindowPoints,
    UI::{
        HiDpi::GetDpiForWindow,
        Input::KeyboardAndMouse::{EnableWindow, IsWindowEnabled, ReleaseCapture, SetCapture},
        Shell::{DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            GW_CHILD, GW_HWNDNEXT, GetParent, GetWindow, WM_CAPTURECHANGED, WM_CONTEXTMENU,
            WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEHWHEEL,
            WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_NCDESTROY, WM_RBUTTONDOWN, WM_RBUTTONUP,
        },
    },
};

const OWNER: usize = 125;
const PAGE: usize = 126;

struct ModalInput {
    parent: HWND,
    host: cef::BrowserHost,
    disabled: HashSet<usize>,
    active: bool,
    pressed: u8,
}

thread_local! {
    // All access and window subclass callbacks run on the native UI thread.
    // RefData contains HWND identities only; there are no unmanaged pointers.
    static MODALS: RefCell<HashMap<usize, ModalInput>> = RefCell::default();
}

fn key(hwnd: HWND) -> usize {
    hwnd.0 as usize
}
fn handle(id: usize) -> HWND {
    HWND(id as _)
}

/// Release ownership before a page is reparented. Only windows this modal
/// actually disabled are re-enabled; pre-existing disabled state is preserved.
pub(super) fn release_page(hwnd: HWND) {
    let mut owner = 0;
    unsafe {
        if !GetWindowSubclass(hwnd, Some(page_proc), PAGE, Some(&mut owner)).as_bool() {
            return;
        }
        let _ = RemoveWindowSubclass(hwnd, Some(page_proc), PAGE);
    }
    MODALS.with(|states| {
        if let Some(state) = states.borrow_mut().get_mut(&owner) {
            state.disabled.remove(&key(hwnd));
        }
    });
    unsafe {
        EnableWindow(hwnd, true);
    }
}

unsafe extern "system" fn page_proc(
    hwnd: HWND,
    msg: u32,
    w: WPARAM,
    l: LPARAM,
    _: usize,
    owner: usize,
) -> LRESULT {
    if msg == WM_NCDESTROY {
        MODALS.with(|states| {
            if let Some(state) = states.borrow_mut().get_mut(&owner) {
                state.disabled.remove(&key(hwnd));
            }
        });
        unsafe {
            let _ = RemoveWindowSubclass(hwnd, Some(page_proc), PAGE);
        }
    }
    unsafe { DefSubclassProc(hwnd, msg, w, l) }
}

fn restore_pages(owner: usize) {
    let pages = MODALS.with(|states| {
        states
            .borrow_mut()
            .get_mut(&owner)
            .map(|state| std::mem::take(&mut state.disabled))
            .unwrap_or_default()
    });
    for page in pages {
        release_page(handle(page));
    }
}

fn remove_owner(owner: usize) {
    restore_pages(owner);
    let state = MODALS.with(|states| states.borrow_mut().remove(&owner));
    if let Some(state) = state {
        unsafe {
            let _ = RemoveWindowSubclass(state.parent, Some(parent_proc), owner);
            let _ = RemoveWindowSubclass(handle(owner), Some(chrome_proc), OWNER);
            if state.pressed != 0 {
                let _ = ReleaseCapture();
            }
        }
    }
}

unsafe extern "system" fn chrome_proc(
    hwnd: HWND,
    msg: u32,
    w: WPARAM,
    l: LPARAM,
    _: usize,
    _: usize,
) -> LRESULT {
    if msg == WM_NCDESTROY {
        remove_owner(key(hwnd));
    }
    unsafe { DefSubclassProc(hwnd, msg, w, l) }
}

fn button(msg: u32) -> Option<(MouseButtonType, bool, u8)> {
    match msg {
        WM_LBUTTONDOWN => Some((MouseButtonType::LEFT, false, 1)),
        WM_LBUTTONUP => Some((MouseButtonType::LEFT, true, 1)),
        WM_MBUTTONDOWN => Some((MouseButtonType::MIDDLE, false, 2)),
        WM_MBUTTONUP => Some((MouseButtonType::MIDDLE, true, 2)),
        WM_RBUTTONDOWN => Some((MouseButtonType::RIGHT, false, 4)),
        WM_RBUTTONUP => Some((MouseButtonType::RIGHT, true, 4)),
        _ => None,
    }
}

unsafe extern "system" fn parent_proc(
    hwnd: HWND,
    msg: u32,
    w: WPARAM,
    l: LPARAM,
    owner: usize,
    _: usize,
) -> LRESULT {
    if msg == WM_NCDESTROY {
        remove_owner(owner);
        return unsafe { DefSubclassProc(hwnd, msg, w, l) };
    }
    if msg == WM_CAPTURECHANGED {
        let inactive = MODALS.with(|states| {
            let mut states = states.borrow_mut();
            let Some(state) = states.get_mut(&owner) else {
                return false;
            };
            state.pressed = 0;
            !state.active
        });
        if inactive {
            remove_owner(owner);
        }
    }
    let snapshot = MODALS.with(|states| {
        states
            .borrow()
            .get(&owner)
            .map(|state| (state.host.clone(), state.active, state.pressed))
    });
    let Some((host, active, pressed)) = snapshot else {
        return unsafe { DefSubclassProc(hwnd, msg, w, l) };
    };
    if let Some((button, up, bit)) = button(msg) {
        if !up && active {
            MODALS.with(|states| {
                if let Some(state) = states.borrow_mut().get_mut(&owner) {
                    state.pressed |= bit;
                }
            });
            unsafe {
                SetCapture(hwnd);
            }
        }
        // Native clicks outside the clipped chrome arrive in parent-client
        // physical pixels. CEF's Aura input API expects chrome-client DIP.
        let mut point = [POINT {
            x: (l.0 as u16 as i16).into(),
            y: ((l.0 >> 16) as u16 as i16).into(),
        }];
        unsafe {
            MapWindowPoints(Some(hwnd), Some(handle(owner)), &mut point);
        }
        let dpi = unsafe { GetDpiForWindow(handle(owner)) }.max(96);
        let event = MouseEvent {
            x: to_dip(point[0].x, dpi),
            y: to_dip(point[0].y, dpi),
            ..Default::default()
        };
        if active || (up && pressed & bit != 0) {
            if active {
                host.set_focus(1);
            }
            host.send_mouse_click_event(Some(&event), button, i32::from(up), 1);
        }
        if up && pressed & bit != 0 {
            let released = MODALS.with(|states| {
                let mut states = states.borrow_mut();
                let Some(state) = states.get_mut(&owner) else {
                    return true;
                };
                state.pressed &= !bit;
                state.pressed == 0
            });
            if released {
                unsafe {
                    let _ = ReleaseCapture();
                }
                if !active {
                    remove_owner(owner);
                }
            }
        }
        return LRESULT(0);
    }
    // Do not leak wheel/context-menu messages to the page or the parent.
    // The enabled chrome HWND receives its own normal input independently.
    if matches!(
        msg,
        WM_MOUSEMOVE | WM_MOUSEWHEEL | WM_MOUSEHWHEEL | WM_CONTEXTMENU
    ) {
        return LRESULT(0);
    }
    unsafe { DefSubclassProc(hwnd, msg, w, l) }
}

fn to_dip(pixel: i32, dpi: u32) -> i32 {
    (f64::from(pixel) * 96.0 / f64::from(dpi)).round() as i32
}

pub(super) fn set_modal(host: cef::BrowserHost, active: bool) -> bool {
    let chrome = HWND(host.window_handle().0 as _);
    let owner = key(chrome);
    if !active {
        restore_pages(owner);
        let pressed = MODALS.with(|states| {
            let mut states = states.borrow_mut();
            let Some(state) = states.get_mut(&owner) else {
                return false;
            };
            state.active = false;
            state.pressed != 0
        });
        // Keep capture only until the dismissing gesture ends. Its mouseup
        // must not hit the newly enabled page after an onMouseDown dismissal.
        if !pressed {
            remove_owner(owner);
        }
        return true;
    }
    let Ok(parent) = (unsafe { GetParent(chrome) }) else {
        return false;
    };
    let exists = MODALS.with(|states| states.borrow().contains_key(&owner));
    if !exists {
        unsafe {
            if !SetWindowSubclass(chrome, Some(chrome_proc), OWNER, 0).as_bool() {
                return false;
            }
            if !SetWindowSubclass(parent, Some(parent_proc), owner, 0).as_bool() {
                let _ = RemoveWindowSubclass(chrome, Some(chrome_proc), OWNER);
                return false;
            }
        }
        MODALS.with(|states| {
            states.borrow_mut().insert(
                owner,
                ModalInput {
                    parent,
                    host: host.clone(),
                    disabled: HashSet::new(),
                    active: true,
                    pressed: 0,
                },
            );
        });
    } else {
        MODALS.with(|states| {
            if let Some(state) = states.borrow_mut().get_mut(&owner) {
                state.active = true;
            }
        });
    }
    // Include newly created/reparented page siblings on every layout update.
    // The runtime's z-order subclass identifies its CEF children; unrelated
    // controls and the chrome itself are never disabled.
    let mut child = unsafe { GetWindow(parent, GW_CHILD) }.ok();
    while let Some(page) = child {
        child = unsafe { GetWindow(page, GW_HWNDNEXT) }.ok();
        if page != chrome && !block_page(page, owner) {
            remove_owner(owner);
            return false;
        }
    }
    if !exists {
        host.set_focus(1);
    }
    true
}

/// A subclass marker is also the ownership token: destruction removes it,
/// and a recycled HWND cannot accidentally inherit a prior modal's restore.
fn block_page(page: HWND, owner: usize) -> bool {
    if !super::webview::is_runtime_view(page) || !unsafe { IsWindowEnabled(page) }.as_bool() {
        return true;
    }
    if !unsafe { SetWindowSubclass(page, Some(page_proc), PAGE, owner) }.as_bool() {
        return false;
    }
    MODALS.with(|states| {
        if let Some(state) = states.borrow_mut().get_mut(&owner) {
            state.disabled.insert(key(page));
        }
    });
    unsafe {
        EnableWindow(page, false);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::{
        Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, HWND_TOP, WINDOW_EX_STYLE, WS_POPUP,
        },
        core::w,
    };

    struct TestWindow(HWND);
    impl TestWindow {
        fn new(runtime: bool) -> Self {
            let hwnd = unsafe {
                CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("STATIC"),
                    w!("modal-input-test"),
                    WS_POPUP,
                    0,
                    0,
                    100,
                    100,
                    None,
                    None,
                    None,
                    None,
                )
            }
            .unwrap();
            if runtime {
                super::super::webview::restack_pinned(hwnd, HWND_TOP);
            }
            Self(hwnd)
        }
    }
    impl Drop for TestWindow {
        fn drop(&mut self) {
            unsafe {
                let _ = DestroyWindow(self.0);
            }
        }
    }

    #[test]
    fn modal_restores_only_the_pages_it_disabled() {
        let enabled = TestWindow::new(true);
        let disabled = TestWindow::new(true);
        let unrelated = TestWindow::new(false);
        unsafe {
            EnableWindow(disabled.0, false);
        }
        for window in [&enabled, &disabled, &unrelated] {
            assert!(block_page(window.0, 42));
        }
        assert!(!unsafe { IsWindowEnabled(enabled.0) }.as_bool());
        assert!(!unsafe { IsWindowEnabled(disabled.0) }.as_bool());
        assert!(unsafe { IsWindowEnabled(unrelated.0) }.as_bool());
        for window in [&enabled, &disabled, &unrelated] {
            release_page(window.0);
        }
        assert!(unsafe { IsWindowEnabled(enabled.0) }.as_bool());
        assert!(!unsafe { IsWindowEnabled(disabled.0) }.as_bool());
    }

    #[test]
    fn page_can_leave_one_modal_and_join_another_without_stale_ownership() {
        let page = TestWindow::new(true);
        assert!(block_page(page.0, 42));
        assert!(block_page(page.0, 42)); // repeated geometry cannot overwrite prior enabled state
        release_page(page.0); // the reparent path calls this before SetParent
        assert!(unsafe { IsWindowEnabled(page.0) }.as_bool());
        assert!(block_page(page.0, 99));
        let mut owner = 0;
        assert!(
            unsafe { GetWindowSubclass(page.0, Some(page_proc), PAGE, Some(&mut owner)) }.as_bool()
        );
        assert_eq!(owner, 99);
        release_page(page.0);
        assert!(!unsafe { GetWindowSubclass(page.0, Some(page_proc), PAGE, None) }.as_bool());
    }

    #[test]
    fn page_destruction_removes_ownership_before_the_handle_can_be_reused() {
        let page = TestWindow::new(true);
        let hwnd = page.0;
        assert!(block_page(hwnd, 42));
        drop(page);
        assert!(!unsafe { GetWindowSubclass(hwnd, Some(page_proc), PAGE, None) }.as_bool());
        release_page(hwnd); // no stale native ownership token, no restore
    }
    #[test]
    fn clicks_use_chrome_dip_at_fractional_and_double_scale() {
        assert_eq!(to_dip(125, 120), 100);
        assert_eq!(to_dip(300, 144), 200);
        assert_eq!(to_dip(-20, 192), -10);
    }
}
