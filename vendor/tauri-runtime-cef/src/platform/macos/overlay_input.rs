// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Let clicks reach the page through a chrome overlay's mask.
//!
//! While an overlay is up, the chrome view is ordered above the page views and
//! a `CAShapeLayer` mask punches the page rectangles out of it, so the page is
//! what you see there. A layer mask only clips *painting*: `AppKit` still hit
//! tests the chrome view across its whole frame, so every press over the page
//! landed on chrome and the page went dead -- no clicks, no typing -- until the
//! overlay closed. A card anchored over the page (the saved-login prompt) made
//! that plain: the page froze for as long as the card was on screen.
//!
//! Windows has never had this problem: there the mask is a window region, and
//! a region clips hit testing as well as painting. This is the missing half of
//! the macOS mask -- `hitTest:` returns nil inside a page hole, so the press
//! falls through to the page view beneath, exactly as it does on Windows.
//!
//! A modal overlay keeps the old behaviour: chrome owns every press, which is
//! what makes a dialog modal.
//!
//! The patch is per view class and idempotent, and it consults a registry of
//! the views that currently pass presses through, so page views sharing the
//! class are unaffected.

#![allow(unsafe_code)] // AppKit hit testing is reachable only through the Objective-C runtime.

use std::collections::HashMap;
use std::sync::Mutex;

use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::sel;
use objc2_app_kit::NSView;
use objc2_foundation::NSPoint;

/// What a chrome view lets through: presses inside a page rectangle, minus the
/// overlay surfaces painted back over it.
struct Passthrough {
    holes: Vec<[f64; 4]>,
    overlays: Vec<[f64; 5]>,
}

/// Chrome views that currently pass presses through, by view pointer. A view is
/// registered only while its overlay is up, so a pointer cannot outlive its view
/// here: the entry is removed when the overlay closes, and the chrome view
/// itself lives as long as its window.
static VIEWS: Mutex<Option<HashMap<usize, Passthrough>>> = Mutex::new(None);
/// The `hitTest:` we replaced, by patched class pointer. Stored as a `usize`
/// because an `Imp` is a raw function pointer.
static ORIGINALS: Mutex<Option<HashMap<usize, usize>>> = Mutex::new(None);

type HitTest = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, NSPoint) -> *mut AnyObject;

fn with_views<T>(f: impl FnOnce(&mut HashMap<usize, Passthrough>) -> T) -> T {
    let mut guard = VIEWS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    f(guard.get_or_insert_with(HashMap::new))
}

fn with_originals<T>(f: impl FnOnce(&mut HashMap<usize, usize>) -> T) -> T {
    let mut guard = ORIGINALS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    f(guard.get_or_insert_with(HashMap::new))
}

fn contains(x: f64, y: f64, rect: [f64; 4]) -> bool {
    let [rx, ry, width, height] = rect;
    x >= rx && y >= ry && x < rx + width && y < ry + height
}

/// Presses over `holes`, outside every overlay surface, belong to the page.
/// `holes` and `overlays` are the chrome's own logical, top-left coordinates,
/// the same ones the mask is built from.
pub(crate) fn set_passthrough(view: &NSView, holes: &[[f64; 4]], overlays: &[[f64; 5]]) {
    patch(view.class());
    let key = std::ptr::from_ref(view) as usize;
    with_views(|views| {
        views.insert(
            key,
            Passthrough {
                holes: holes.to_vec(),
                overlays: overlays.to_vec(),
            },
        );
    });
}

/// Chrome owns every press over this view again.
pub(crate) fn clear_passthrough(view: &NSView) {
    let key = std::ptr::from_ref(view) as usize;
    with_views(|views| views.remove(&key));
}

/// The replacement `hitTest:`: nil inside a page hole, the original everywhere
/// else. `point` is in the *superview's* coordinates, as `AppKit` defines it.
extern "C-unwind" fn hit_test(this: *mut AnyObject, cmd: Sel, point: NSPoint) -> *mut AnyObject {
    let key = this as usize;
    let inside = with_views(|views| {
        views.get(&key).map(|state| {
            // SAFETY: the registry only ever holds `NSView`s, and `hitTest:` is
            // called on the main thread with the receiver alive.
            let view: &NSView = unsafe { &*this.cast::<NSView>() };
            // SAFETY: reading the superview during hit testing is a main-thread
            // AppKit call on a live view.
            let superview = unsafe { view.superview() };
            let local = view.convertPoint_fromView(point, superview.as_deref());
            let bounds = view.bounds();
            let x = local.x - bounds.origin.x;
            // The rectangles are top-left, like the chrome's own layout.
            let y = if view.isFlipped() {
                local.y - bounds.origin.y
            } else {
                bounds.origin.y + bounds.size.height - local.y
            };
            state.holes.iter().any(|hole| contains(x, y, *hole))
                && !state.overlays.iter().any(|[ox, oy, width, height, _]| {
                    contains(x, y, [*ox, *oy, *width, *height])
                })
        })
    });
    if inside == Some(true) {
        return std::ptr::null_mut();
    }
    original_for(this).map_or(std::ptr::null_mut(), |original| {
        // SAFETY: the stored implementation is the `hitTest:` we replaced, so
        // it has this signature and this receiver.
        unsafe { original(this, cmd, point) }
    })
}

/// The `hitTest:` that was in place before the receiver's class was patched.
fn original_for(this: *mut AnyObject) -> Option<HitTest> {
    // SAFETY: `hitTest:` is only ever dispatched to a live object.
    let object = unsafe { this.as_ref() }?;
    let mut class = Some(object.class());
    while let Some(current) = class {
        let key = std::ptr::from_ref::<AnyClass>(current) as usize;
        if let Some(imp) = with_originals(|originals| originals.get(&key).copied()) {
            // SAFETY: the value was stored as the `Imp` of `hitTest:`, whose
            // signature is `HitTest`.
            return Some(unsafe { std::mem::transmute::<usize, HitTest>(imp) });
        }
        class = current.superclass();
    }
    None
}

fn patch(class: &AnyClass) {
    let key = std::ptr::from_ref::<AnyClass>(class) as usize;
    let fresh = with_originals(|originals| {
        if originals.contains_key(&key) {
            return false;
        }
        // `instance_method` walks the superclasses, so this is the
        // implementation that would have run -- ours goes on `class` alone.
        let Some(method) = class.instance_method(sel!(hitTest:)) else {
            return false;
        };
        originals.insert(key, method.implementation() as usize);
        true
    });
    if !fresh {
        return;
    }
    // SAFETY: an `extern "C-unwind"` function with the `self, _cmd` prologue is
    // what an `Imp` is; this one has `hitTest:`'s own signature.
    let imp: Imp = unsafe { std::mem::transmute::<HitTest, Imp>(hit_test) };
    // SAFETY: replacing a method on a live class with one of the same signature.
    unsafe {
        objc2::ffi::class_replaceMethod(
            std::ptr::from_ref::<AnyClass>(class).cast_mut(),
            sel!(hitTest:),
            imp,
            c"@@:{CGPoint=dd}".as_ptr(),
        );
    }
    log::info!(
        "overlay hit testing patched for view class {}",
        class.name().to_string_lossy()
    );
}
