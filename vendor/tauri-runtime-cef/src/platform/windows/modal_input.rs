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
            GetParent, IsWindowVisible, SW_HIDE, SW_SHOW, ShowWindow, WM_CAPTURECHANGED,
            WM_CONTEXTMENU, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP,
            WM_MOUSEHWHEEL, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_NCDESTROY, WM_RBUTTONDOWN,
            WM_RBUTTONUP,
        },
    },
};

const OWNER: usize = 125;
const PAGE: usize = 126;
const MANAGED: usize = 127;

#[derive(Clone)]
enum ChromeInput {
    Cef(cef::BrowserHost),
    #[cfg(test)]
    Test(HWND),
}
impl ChromeInput {
    fn focus(&self) {
        match self {
            Self::Cef(host) => host.set_focus(1),
            #[cfg(test)]
            Self::Test(hwnd) => unsafe {
                let _ = windows::Win32::UI::Input::KeyboardAndMouse::SetFocus(Some(*hwnd));
            },
        }
    }
    fn click(&self, event: &MouseEvent, button: MouseButtonType, up: bool) {
        match self {
            Self::Cef(host) => host.send_mouse_click_event(Some(event), button, i32::from(up), 1),
            #[cfg(test)]
            Self::Test(_) => {}
        }
    }
}

#[derive(Default)]
struct ManagedView {
    hidden_by: Option<usize>,
    requested_visible: bool,
}

struct ModalInput {
    parent: HWND,
    host: ChromeInput,
    failed: bool,
    emergency_disabled: bool,
    disabled: HashSet<usize>,
    active: bool,
    pressed: u8,
}

thread_local! {
    // All access and window subclass callbacks run on the native UI thread.
    // RefData contains HWND identities only; there are no unmanaged pointers.
    static MODALS: RefCell<HashMap<usize, ModalInput>> = RefCell::default();
    // Identity is established by the runtime's adoption/show path, never
    // inferred from an optional z-order pin or a native window class name.
    static VIEWS: RefCell<HashMap<usize, ManagedView>> = RefCell::default();
    #[cfg(test)]
    static FAILURES: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };

}

fn key(hwnd: HWND) -> usize {
    hwnd.0 as usize
}
fn handle(id: usize) -> HWND {
    HWND(id as _)
}

pub(super) fn injected_failure(flag: u8) -> bool {
    #[cfg(test)]
    {
        return FAILURES.with(|failures| failures.get() & flag != 0);
    }
    #[cfg(not(test))]
    {
        let _ = flag;
        false
    }
}

pub(super) fn register_view(hwnd: HWND) -> bool {
    if VIEWS.with(|views| views.borrow().contains_key(&key(hwnd))) {
        return true;
    }
    if injected_failure(1)
        || !unsafe { SetWindowSubclass(hwnd, Some(managed_proc), MANAGED, 0) }.as_bool()
    {
        // A page without authoritative lifetime tracking is never revealed.
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
        log::error!("native view lifetime registration failed; view remains hidden");
        return false;
    }
    VIEWS.with(|views| {
        views.borrow_mut().insert(key(hwnd), ManagedView::default());
    });
    true
}

pub(super) fn destroying_view(hwnd: HWND) {
    // The explicit runtime close also covers an exceptional failure to install
    // the lifetime subclass before initial reveal.
    remove_owner(key(hwnd));
    VIEWS.with(|views| {
        views.borrow_mut().remove(&key(hwnd));
    });
}

unsafe extern "system" fn managed_proc(
    hwnd: HWND,
    msg: u32,
    w: WPARAM,
    l: LPARAM,
    _: usize,
    _: usize,
) -> LRESULT {
    if msg == WM_NCDESTROY {
        destroying_view(hwnd);
        unsafe {
            let _ = RemoveWindowSubclass(hwnd, Some(managed_proc), MANAGED);
        }
    }
    unsafe { DefSubclassProc(hwnd, msg, w, l) }
}

fn parent_owner(hwnd: HWND) -> Option<usize> {
    let parent = unsafe { GetParent(hwnd) }.ok()?;
    MODALS.with(|states| {
        states.borrow().iter().find_map(|(owner, state)| {
            (state.active && state.parent == parent && *owner != key(hwnd)).then_some(*owner)
        })
    })
}

fn managed_siblings(chrome: HWND) -> Vec<HWND> {
    let Ok(parent) = (unsafe { GetParent(chrome) }) else {
        return Vec::new();
    };
    VIEWS.with(|views| {
        views
            .borrow()
            .keys()
            .copied()
            .filter_map(|id| {
                let hwnd = handle(id);
                (hwnd != chrome && unsafe { GetParent(hwnd) }.ok() == Some(parent)).then_some(hwnd)
            })
            .collect()
    })
}

/// Shared by asynchronous adoption, ordinary reveal, and reparent. Admission
/// happens while the CEF child is still hidden and before any native raise.
pub(super) fn show_view(hwnd: HWND, visible: bool) -> bool {
    if !register_view(hwnd) {
        return false;
    }
    VIEWS.with(|views| {
        if let Some(view) = views.borrow_mut().get_mut(&key(hwnd)) {
            view.requested_visible = visible;
        }
    });
    if let Some(owner) = parent_owner(hwnd) {
        let failed = MODALS.with(|states| {
            states
                .borrow()
                .get(&owner)
                .is_some_and(|state| state.failed)
        });
        if failed
            || !block_page(hwnd, owner)
            || !super::webview::restack_pinned(hwnd, handle(owner))
        {
            fail_modal(handle(owner));
            return false;
        }
    }
    unsafe {
        let _ = ShowWindow(hwnd, if visible { SW_SHOW } else { SW_HIDE });
    }
    true
}

pub(super) fn leave_parent(hwnd: HWND) -> bool {
    let visible = VIEWS
        .with(|views| {
            let mut views = views.borrow_mut();
            views.get_mut(&key(hwnd)).map(|view| {
                view.hidden_by = None;
                view.requested_visible
            })
        })
        .unwrap_or_else(|| unsafe { IsWindowVisible(hwnd) }.as_bool());
    release_page(hwnd);
    visible
}

pub(super) fn raise_view(hwnd: HWND) {
    if !register_view(hwnd) {
        return;
    }
    if let Some(owner) = parent_owner(hwnd) {
        if !block_page(hwnd, owner) || !super::webview::restack_pinned(hwnd, handle(owner)) {
            fail_modal(handle(owner));
        }
    } else if !super::webview::restack_pinned(
        hwnd,
        windows::Win32::UI::WindowsAndMessaging::HWND_TOP,
    ) {
        // Do not expose an incompletely managed arriving surface.
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
        log::error!("could not establish native webview order");
    }
}

fn restore_hidden(owner: usize) {
    let windows = VIEWS.with(|views| {
        views
            .borrow_mut()
            .iter_mut()
            .filter_map(|(id, view)| {
                if view.hidden_by == Some(owner) {
                    view.hidden_by = None;
                    Some((handle(*id), view.requested_visible))
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
    });
    for (hwnd, visible) in windows {
        unsafe {
            let _ = ShowWindow(hwnd, if visible { SW_SHOW } else { SW_HIDE });
        }
    }
}

/// Exceptional, recoverable fallback. Keep acquired input disables and hide
/// all authoritative pages before resetting chrome's region. No stale holes
/// can expose a page even if the region reset itself fails. Closing the
/// overlay restores each page's latest requested visibility and enabled state.
pub(super) fn fail_modal(chrome: HWND) -> bool {
    let owner = key(chrome);
    MODALS.with(|states| {
        if let Some(state) = states.borrow_mut().get_mut(&owner) {
            state.failed = true;
        }
    });
    let mut hidden = true;
    for page in managed_siblings(chrome) {
        VIEWS.with(|views| {
            if let Some(view) = views.borrow_mut().get_mut(&key(page)) {
                view.hidden_by = Some(owner);
            }
        });
        unsafe {
            let _ = ShowWindow(page, SW_HIDE);
        }
        hidden &= !unsafe { IsWindowVisible(page) }.as_bool();
    }
    let barrier = super::webview::reset_chrome_region(chrome);
    let host = MODALS.with(|states| states.borrow().get(&owner).map(|state| state.host.clone()));
    if let Some(host) = host {
        host.focus();
    }
    log::error!(
        "live modal setup failed: pages_hidden={hidden}, chrome_barrier={barrier}; closing the overlay restores pages"
    );
    if !hidden {
        // If native hiding itself fails, block the parent as a last resort.
        // The normal close path explicitly restores this emergency barrier.
        if let Ok(parent) = unsafe { GetParent(chrome) } {
            let was_enabled = unsafe { IsWindowEnabled(parent) }.as_bool();
            unsafe {
                let _ = EnableWindow(parent, false);
            }
            MODALS.with(|states| {
                if let Some(state) = states.borrow_mut().get_mut(&owner) {
                    state.emergency_disabled |= was_enabled;
                }
            });
            if unsafe { IsWindowEnabled(parent) }.as_bool() {
                unsafe {
                    let _ = ShowWindow(parent, SW_HIDE);
                }
                log::error!("native input barrier failed; owning window hidden");
            }
            #[cfg(not(test))]
            unsafe {
                use windows::{
                    Win32::UI::WindowsAndMessaging::{
                        MB_ICONERROR, MB_OK, MessageBoxW, PostMessageW, WM_CLOSE,
                    },
                    core::w,
                };
                MessageBoxW(
                    None,
                    w!(
                        "Dive could not safely display this popup. The affected window will close; you can open it again."
                    ),
                    w!("Dive native window error"),
                    MB_OK | MB_ICONERROR,
                );
                let _ = PostMessageW(Some(parent), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
    }
    hidden && barrier
}

pub(super) fn finish_overlay(chrome: HWND, painted: bool, modal: bool) -> bool {
    if painted || !modal {
        return painted;
    }
    fail_modal(chrome);
    false
}

fn restore_emergency(owner: usize) {
    let parent = MODALS.with(|states| {
        let mut states = states.borrow_mut();
        let state = states.get_mut(&owner)?;
        std::mem::take(&mut state.emergency_disabled).then_some(state.parent)
    });
    if let Some(parent) = parent {
        unsafe {
            let _ = EnableWindow(parent, true);
        }
    }
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
        let _ = EnableWindow(hwnd, true);
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
    restore_emergency(owner);
    restore_pages(owner);
    restore_hidden(owner);
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
                host.focus();
            }
            host.click(&event, button, up);
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
    set_owner(chrome, ChromeInput::Cef(host), active)
}

fn set_owner(chrome: HWND, host: ChromeInput, active: bool) -> bool {
    let owner = key(chrome);
    if !active {
        restore_emergency(owner);
        restore_pages(owner);
        restore_hidden(owner);
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
        MODALS.with(|states| {
            states.borrow_mut().insert(
                owner,
                ModalInput {
                    parent,
                    host: host.clone(),
                    disabled: HashSet::new(),
                    active: true,
                    pressed: 0,
                    failed: false,
                    emergency_disabled: false,
                },
            );
        });
        if !register_view(chrome)
            || !unsafe { SetWindowSubclass(chrome, Some(chrome_proc), OWNER, 0) }.as_bool()
            || injected_failure(2)
            || !unsafe { SetWindowSubclass(parent, Some(parent_proc), owner, 0) }.as_bool()
        {
            fail_modal(chrome);
            return false;
        }
    } else {
        let failed = MODALS.with(|states| {
            let mut states = states.borrow_mut();
            let state = states.get_mut(&owner).expect("existing modal");
            state.active = true;
            state.failed
        });
        if failed {
            return false;
        }
    }
    for page in managed_siblings(chrome) {
        if !block_page(page, owner) {
            // Preserve every acquired disable until the fallback hides pages.
            fail_modal(chrome);
            return false;
        }
    }
    if !exists {
        host.focus();
    }
    true
}

/// A subclass marker is also the ownership token: destruction removes it,
/// and a recycled HWND cannot accidentally inherit a prior modal's restore.
fn block_page(page: HWND, owner: usize) -> bool {
    if !VIEWS.with(|views| views.borrow().contains_key(&key(page)))
        || !unsafe { IsWindowEnabled(page) }.as_bool()
    {
        return true;
    }
    if injected_failure(4)
        || !unsafe { SetWindowSubclass(page, Some(page_proc), PAGE, owner) }.as_bool()
    {
        return false;
    }
    MODALS.with(|states| {
        if let Some(state) = states.borrow_mut().get_mut(&owner) {
            state.disabled.insert(key(page));
        }
    });
    unsafe {
        let _ = EnableWindow(page, false);
    }
    !unsafe { IsWindowEnabled(page) }.as_bool()
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::{
        Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, GW_CHILD, GetWindow, HWND_TOP, WINDOW_EX_STYLE,
            WM_SHOWWINDOW, WS_CHILD, WS_POPUP,
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
                assert!(register_view(hwnd));
                assert!(super::super::webview::restack_pinned(hwnd, HWND_TOP));
            }
            Self(hwnd)
        }
    }
    impl TestWindow {
        fn child(parent: HWND, registered: bool) -> Self {
            let hwnd = unsafe {
                CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("STATIC"),
                    w!("delayed-view"),
                    WS_CHILD,
                    0,
                    0,
                    100,
                    100,
                    Some(parent),
                    None,
                    None,
                    None,
                )
            }
            .unwrap();
            if registered {
                assert!(register_view(hwnd));
            }
            Self(hwnd)
        }
    }

    thread_local! { static ENABLED_AT_SHOW: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) }; }
    unsafe extern "system" fn observe_show(
        hwnd: HWND,
        msg: u32,
        w: WPARAM,
        l: LPARAM,
        _: usize,
        _: usize,
    ) -> LRESULT {
        if msg == WM_SHOWWINDOW && w.0 != 0 {
            ENABLED_AT_SHOW
                .with(|observed| observed.set(Some(unsafe { IsWindowEnabled(hwnd) }.as_bool())));
        }
        unsafe { DefSubclassProc(hwnd, msg, w, l) }
    }

    #[test]
    fn settled_modal_acquires_delayed_completion_before_reveal_and_keeps_chrome_above_it() {
        let parent = TestWindow::new(false);
        let chrome = TestWindow::child(parent.0, true);
        unsafe {
            let _ = ShowWindow(parent.0, SW_SHOW);
        }
        assert!(show_view(chrome.0, true));
        assert!(set_owner(chrome.0, ChromeInput::Test(chrome.0), true));
        // No further geometry IPC: a pending CEF child now completes.
        let arriving = TestWindow::child(parent.0, false);
        unsafe {
            assert!(SetWindowSubclass(arriving.0, Some(observe_show), 500, 0).as_bool());
        }
        ENABLED_AT_SHOW.with(|observed| observed.set(None));
        assert!(show_view(arriving.0, true)); // same entry point as asynchronous adoption
        ENABLED_AT_SHOW.with(|observed| assert_eq!(observed.get(), Some(false)));
        raise_view(chrome.0);
        raise_view(arriving.0); // same admission-order loop as browser_created
        assert_eq!(unsafe { GetWindow(parent.0, GW_CHILD) }.unwrap(), chrome.0);
        assert!(unsafe { IsWindowVisible(arriving.0) }.as_bool());
        assert!(!unsafe { IsWindowEnabled(arriving.0) }.as_bool());
        assert!(set_owner(chrome.0, ChromeInput::Test(chrome.0), false));
        assert!(unsafe { IsWindowEnabled(arriving.0) }.as_bool());
    }

    #[test]
    fn authoritative_identity_does_not_depend_on_a_z_order_marker() {
        let parent = TestWindow::new(false);
        let chrome = TestWindow::child(parent.0, true);
        let page = TestWindow::child(parent.0, true); // registered, never pinned
        assert!(set_owner(chrome.0, ChromeInput::Test(chrome.0), true));
        assert!(!unsafe { IsWindowEnabled(page.0) }.as_bool());
        assert!(set_owner(chrome.0, ChromeInput::Test(chrome.0), false));
        assert!(unsafe { IsWindowEnabled(page.0) }.as_bool());
    }

    #[test]
    fn input_hook_and_region_failure_keep_pages_covered_until_close() {
        let parent = TestWindow::new(false);
        let chrome = TestWindow::child(parent.0, true);
        let page = TestWindow::child(parent.0, true);
        unsafe {
            let _ = ShowWindow(parent.0, SW_SHOW);
        }
        assert!(show_view(chrome.0, true));
        assert!(show_view(page.0, true));
        assert!(set_owner(chrome.0, ChromeInput::Test(chrome.0), true));
        let arriving = TestWindow::child(parent.0, false);
        FAILURES.with(|failures| failures.set(4 | 8)); // page hook + fallback region reset
        assert!(!show_view(arriving.0, true));
        assert!(!finish_overlay(chrome.0, false, true));
        assert!(!unsafe { IsWindowEnabled(page.0) }.as_bool()); // already acquired disable retained
        assert!(!unsafe { IsWindowVisible(page.0) }.as_bool());
        assert!(!unsafe { IsWindowVisible(arriving.0) }.as_bool());
        assert!(unsafe { IsWindowEnabled(chrome.0) }.as_bool());
        assert!(!show_view(page.0, true)); // queued reveal cannot bypass failed-owner coverage
        FAILURES.with(|failures| failures.set(0));
        assert!(set_owner(chrome.0, ChromeInput::Test(chrome.0), false));
        assert!(unsafe { IsWindowEnabled(page.0) }.as_bool());
        assert!(unsafe { IsWindowVisible(page.0) }.as_bool());
        assert!(unsafe { IsWindowVisible(arriving.0) }.as_bool());
    }

    #[test]
    fn failed_identity_registration_prevents_native_reveal() {
        let parent = TestWindow::new(false);
        let page = TestWindow::child(parent.0, false);
        unsafe {
            let _ = ShowWindow(parent.0, SW_SHOW);
        }
        FAILURES.with(|failures| failures.set(1));
        assert!(!show_view(page.0, true));
        assert!(!unsafe { IsWindowVisible(page.0) }.as_bool());
        FAILURES.with(|failures| failures.set(0));
        assert!(show_view(page.0, true));
        assert!(unsafe { IsWindowVisible(page.0) }.as_bool());
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
            let _ = EnableWindow(disabled.0, false);
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
