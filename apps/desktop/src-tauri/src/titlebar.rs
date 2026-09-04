//! Keep pointer gestures in the title-bar band inside the chrome.
//!
//! The main window and the popouts use macOS's overlay title bar: the chrome
//! webview extends under the traffic lights and the tab strip lives in the
//! band the system reserves for the title bar. `AppKit` lets a press in that
//! band drag the window whenever the view under the pointer answers yes to
//! `mouseDownCanMoveWindow`, and Chromium's views do. That press never
//! reaches the page as a gesture: the window follows the pointer, the
//! pointer stays put relative to the page, and the tab strip's own drag,
//! which reorders, splits and tears off tabs, never starts.
//!
//! The fix is to make those views answer no. The empty strip filler still
//! moves the window: it carries `data-tauri-drag-region`, and that path asks
//! the window to drag itself, which does not consult the view.
//!
//! Chromium builds its view tree after the browser is created, so the patch
//! runs when the chrome webview is added and again once its page has loaded.
//! It is per class and idempotent, so repeating it is cheap.

#[cfg(target_os = "macos")]
#[allow(unsafe_code)] // AppKit's view classes are reachable only through the Objective-C runtime.
mod mac {
    use std::collections::HashSet;
    use std::sync::Mutex;

    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use objc2::sel;
    use objc2_app_kit::{NSView, NSWindow};

    static PATCHED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

    /// Disable window drag-through for every view class under `window`
    /// that currently allows it.
    pub fn keep_drags_in_chrome(window: &tauri::Window<crate::Runtime>) {
        let Ok(ptr) = window.ns_window() else { return };
        // SAFETY: Tauri hands out the window's live `NSWindow`; this runs on
        // the main thread, where AppKit objects may be used.
        let ns_window: &NSWindow = unsafe { &*ptr.cast::<NSWindow>() };
        let Some(content) = ns_window.contentView() else {
            return;
        };
        walk(&content);
    }

    fn walk(view: &NSView) {
        if view.mouseDownCanMoveWindow() {
            patch(view.class());
        }
        for sub in &view.subviews() {
            walk(&sub);
        }
    }

    extern "C-unwind" fn stays_put(_this: &AnyObject, _cmd: Sel) -> Bool {
        Bool::NO
    }

    fn patch(class: &AnyClass) {
        let name = class.name().to_string_lossy().into_owned();
        let mut guard = PATCHED
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !guard.get_or_insert_with(HashSet::new).insert(name.clone()) {
            return;
        }
        // SAFETY: an `extern "C-unwind"` function with the `self, _cmd`
        // prologue is what an `Imp` is; replacing a `BOOL` getter that takes
        // no arguments with one of the same signature on a live class.
        let imp: Imp = unsafe {
            std::mem::transmute::<extern "C-unwind" fn(&AnyObject, Sel) -> Bool, Imp>(stays_put)
        };
        unsafe {
            objc2::ffi::class_replaceMethod(
                std::ptr::from_ref::<AnyClass>(class).cast_mut(),
                sel!(mouseDownCanMoveWindow),
                imp,
                c"B@:".as_ptr(),
            );
        }
        tracing::info!(class = %name, "title-bar drag-through disabled for view class");
    }
}

/// Run the drag patch immediately and schedule a second pass after the chrome
/// view tree has settled.
pub fn keep_drags_in_chrome_soon(window: &tauri::Window<crate::Runtime>) {
    #[cfg(target_os = "macos")]
    {
        mac::keep_drags_in_chrome(window);
        let window = window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            mac::keep_drags_in_chrome(&window);
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}
