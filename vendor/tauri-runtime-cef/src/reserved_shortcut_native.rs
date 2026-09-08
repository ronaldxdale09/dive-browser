// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::sync::Weak;

use crate::reserved_shortcut::TargetBinding;

/// Owned by AppWebview, never by its CEF client. Client bindings are weak so
/// closing a chrome does not leave Browser -> client -> Browser reference cycles.
pub(crate) struct NewTabTarget {
    #[cfg(target_os = "macos")]
    browser: cef::Browser,
    #[cfg(target_os = "macos")]
    webview_id: u32,
    #[cfg(target_os = "macos")]
    reparent_epoch: std::sync::atomic::AtomicU64,
}

impl NewTabTarget {
    pub(crate) fn new(_browser: cef::Browser, _webview_id: u32) -> Self {
        Self {
            #[cfg(target_os = "macos")]
            browser: _browser,
            #[cfg(target_os = "macos")]
            webview_id: _webview_id,
            #[cfg(target_os = "macos")]
            reparent_epoch: std::sync::atomic::AtomicU64::new(0),
        }
    }
    pub(crate) fn invalidate_parent(&self) {
        #[cfg(target_os = "macos")]
        self.reparent_epoch
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
}

/// An opaque weak reference to an explicitly selected browser chrome.
#[derive(Clone)]
pub struct NativeNewTabTarget(pub(crate) Weak<NewTabTarget>);

#[derive(Default)]
pub(crate) struct NativeShortcutBinding {
    pub(crate) new_tab: TargetBinding<NewTabTarget>,
    pub(crate) address: TargetBinding<NewTabTarget>,
}

#[cfg(target_os = "macos")]
fn native_window(browser: &cef::Browser) -> Option<objc2::rc::Retained<objc2_app_kit::NSWindow>> {
    use cef::{ImplBrowser, ImplBrowserHost};
    use objc2_app_kit::NSView;
    objc2::MainThreadMarker::new()?;
    if browser.is_valid() == 0 {
        return None;
    }
    let host = browser.host()?;
    // SAFETY: CEF returns its live NSView on macOS; it is borrowed only on UI.
    let view = unsafe { host.window_handle().cast::<NSView>().as_ref() }?;
    view.window()
}

#[cfg(target_os = "macos")]
fn snapshot(owner: &NewTabTarget) -> Option<crate::reserved_shortcut::WindowSnapshot> {
    let window = native_window(&owner.browser)?;
    Some(crate::reserved_shortcut::WindowSnapshot {
        window: &*window as *const objc2_app_kit::NSWindow as usize,
        epoch: owner
            .reparent_epoch
            .load(std::sync::atomic::Ordering::Relaxed),
    })
}

/// Capture explicitly selected native owners on CEF UI before key delivery.
#[cfg(target_os = "macos")]
fn bind_window_route(
    binding: &TargetBinding<NewTabTarget>,
    source: Weak<NewTabTarget>,
    anchor: NativeNewTabTarget,
    target: NativeNewTabTarget,
    cross_window: bool,
) -> bool {
    use crate::reserved_shortcut::{WindowRoute, address_window_matches, cross_window_matches};
    // Failed/reordered configuration must not retain an earlier exception.
    binding.bind(None);
    let (Some(source_owner), Some(anchor_owner), Some(target_owner)) =
        (source.upgrade(), anchor.0.upgrade(), target.0.upgrade())
    else {
        return false;
    };
    let current = [
        snapshot(&source_owner),
        snapshot(&anchor_owner),
        snapshot(&target_owner),
    ];
    let [
        Some(source_window),
        Some(anchor_window),
        Some(target_window),
    ] = current
    else {
        return false;
    };
    let expected = [source_window, anchor_window, target_window];
    if !(if cross_window {
        cross_window_matches(expected, current)
    } else {
        address_window_matches(expected, current)
    }) {
        return false;
    }
    binding.bind_cross_window(
        target.0,
        WindowRoute {
            source,
            anchor: anchor.0,
            expected,
        },
    );
    true
}

#[cfg(target_os = "macos")]
pub(crate) fn bind_cross_window(
    binding: &NativeShortcutBinding,
    source: Weak<NewTabTarget>,
    anchor: NativeNewTabTarget,
    target: NativeNewTabTarget,
) -> bool {
    bind_window_route(&binding.new_tab, source, anchor, target, true)
}

#[cfg(target_os = "macos")]
pub(crate) fn bind_address(
    binding: &NativeShortcutBinding,
    source: Weak<NewTabTarget>,
    target: NativeNewTabTarget,
) -> bool {
    bind_window_route(&binding.address, source, target.clone(), target, false)
}

#[cfg(target_os = "macos")]
pub(crate) fn dispatch(
    binding: &NativeShortcutBinding,
    source: &cef::Browser,
    action: crate::reserved_shortcut::ShortcutAction,
) -> bool {
    use cef::{CefString, ImplBrowser, ImplBrowserHost, ImplFrame};
    use objc2::MainThreadMarker;

    use crate::native_input_trace::{self, Stage};
    use crate::reserved_shortcut::{
        ShortcutAction, distinct_live_browsers, same_native_window, submit_then_focus,
    };

    let Some(_mtm) = MainThreadMarker::new() else {
        return false;
    };
    let selected = match action {
        ShortcutAction::NewTab => &binding.new_tab,
        ShortcutAction::FocusAddress => &binding.address,
    };
    let Some((target, route)) = selected.resolve_route() else {
        return false;
    };
    // CEF can finish native closure before the runtime removes AppWebview.
    if source.is_valid() == 0 || target.browser.is_valid() == 0 {
        return false;
    }
    if action == ShortcutAction::NewTab
        && !distinct_live_browsers(
            source.is_valid() != 0,
            target.browser.is_valid() != 0,
            || (source.identifier(), target.browser.identifier()),
        )
    {
        return false;
    }
    let target_id = target.browser.identifier();
    let Some(target_host) = target.browser.host() else {
        return false;
    };
    let Some(frame) = target.browser.main_frame() else {
        return false;
    };
    if frame.is_valid() == 0 {
        return false;
    }

    let source_window = native_window(source);
    let target_window = native_window(&target.browser);
    if let Some(route) = &route {
        let (Some(owner), Some(anchor)) = (route.source.upgrade(), route.anchor.upgrade()) else {
            return false;
        };
        if !crate::reserved_shortcut::bound_source_matches(owner.browser.is_valid() != 0, || {
            (owner.browser.identifier(), source.identifier())
        }) || !(match action {
            ShortcutAction::NewTab => crate::reserved_shortcut::cross_window_matches,
            ShortcutAction::FocusAddress => crate::reserved_shortcut::address_window_matches,
        })(
            route.expected,
            [snapshot(&owner), snapshot(&anchor), snapshot(&target)],
        ) {
            return false;
        }
    } else if action == ShortcutAction::FocusAddress
        || !same_native_window(source_window.as_deref(), target_window.as_deref())
    {
        return false;
    }

    // Submit to the chrome's renderer directly, before subsequent native input.
    // Submission is asynchronous; the chrome listener commits the launcher with
    // flushSync. No arbitrary script, command payload or page data crosses here.
    let script = CefString::from(match action {
        ShortcutAction::NewTab => "window.dispatchEvent(new Event('dive-native-new-tab'))",
        ShortcutAction::FocusAddress => {
            "window.dispatchEvent(new Event('dive-native-focus-address'))"
        }
    });
    let script_url = CefString::from("");
    submit_then_focus(
        || {
            native_input_trace::record(
                Stage::DirectSubmit,
                Some(target_id),
                Some(target.webview_id),
            );
            frame.execute_java_script(Some(&script), Some(&script_url), 0);
        },
        || {
            if action == ShortcutAction::NewTab && route.is_some() {
                if let Some(window) = &target_window {
                    window.makeKeyAndOrderFront(None);
                }
            }
            target_host.set_focus(1);
            native_input_trace::record(
                Stage::DirectFocus,
                Some(target_id),
                Some(target.webview_id),
            );
        },
    )
}
