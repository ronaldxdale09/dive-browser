//! The screen eyedropper.
//!
//! Chromium's own `EyeDropper` is not an option here: Blink exposes the API,
//! but the browser half of it lives in Chrome's UI layer, which CEF does not
//! ship. The call therefore resolves instantly with "the user canceled the
//! selection" — a picker that silently does nothing, indistinguishable from a
//! real dismissal. macOS has the same picker natively as `NSColorSampler`, so
//! Dive asks the system for it and leaves the page out of it entirely. That
//! also picks from anywhere on screen, not only from Dive's own window.

use crate::error::{AppError, AppResult};

/// Ask the user to sample a pixel. `Ok(None)` means they dismissed it.
///
/// Must be called from the main thread: the sampler is UI.
#[cfg(target_os = "macos")]
#[allow(unsafe_code)] // NSColorSampler is reachable only through the Objective-C runtime.
pub fn sample(app: &tauri::AppHandle<crate::Runtime>) -> AppResult<Option<String>> {
    use objc2_app_kit::{NSColor, NSColorSampler, NSColorSpace};

    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
    app.run_on_main_thread(move || {
        let sampler = NSColorSampler::new();
        // The block is called on the main thread when the session ends, with
        // null for a cancel. The sampler retains itself until then.
        let handler = block2::RcBlock::new(move |color: *mut NSColor| {
            let hex = (!color.is_null())
                .then(|| unsafe { &*color })
                // Sampled colours arrive in the display's space; sRGB is what
                // every hex code downstream means.
                .and_then(|color| color.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace()))
                .map(|srgb| {
                    hex(
                        srgb.redComponent(),
                        srgb.greenComponent(),
                        srgb.blueComponent(),
                    )
                });
            let _ = tx.send(hex);
        });
        unsafe { sampler.showSamplerWithSelectionHandler(&handler) };
        // `sampler` must outlive the session; the handler block holds the only
        // other reference, so leak this one deliberately rather than let the
        // picker be torn down as this closure returns.
        std::mem::forget(sampler);
    })
    .map_err(AppError::new)?;
    // No timeout: the user decides how long to spend choosing a pixel. The
    // channel closes if the session is torn down, which reads as a cancel.
    Ok(rx.recv().unwrap_or(None))
}

/// No native sampler outside macOS yet.
#[cfg(not(target_os = "macos"))]
pub fn sample(_app: &tauri::AppHandle<crate::Runtime>) -> AppResult<Option<String>> {
    Err(AppError::new(
        "The eyedropper is not available on this platform yet. Pick from the palette instead.",
    ))
}

/// `#rrggbb` from three 0-1 sRGB components.
///
/// A sampled colour arrives as floats, and a display can report a component a
/// hair outside the range, so the value is clamped rather than wrapped: a
/// 255.4 that became 0 would be reported as black.
fn hex(r: f64, g: f64, b: f64) -> String {
    // The clamp above puts the value in 0..=255 before the cast, so neither a
    // truncation nor a lost sign is reachable here.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let channel = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", channel(r), channel(g), channel(b))
}

#[cfg(test)]
mod tests {
    use super::hex;

    #[test]
    fn components_become_the_hex_the_panel_shows() {
        assert_eq!(hex(0.0, 0.0, 0.0), "#000000");
        assert_eq!(hex(1.0, 1.0, 1.0), "#ffffff");
        // 18, 52, 86 -- the swatch the live check picks.
        assert_eq!(hex(18.0 / 255.0, 52.0 / 255.0, 86.0 / 255.0), "#123456");
    }

    #[test]
    fn a_component_past_the_ends_clamps_instead_of_wrapping() {
        // Wide-gamut displays report outside 0-1; wrapping would turn the
        // brightest pixel on screen into black.
        assert_eq!(hex(1.02, -0.01, 0.5), "#ff0080");
    }
}
