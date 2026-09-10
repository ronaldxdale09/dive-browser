//! The screen eyedropper.
//!
//! Chromium's own `EyeDropper` is not an option here: Blink exposes the API,
//! but the browser half of it lives in Chrome's UI layer, which CEF does not
//! ship. The call therefore resolves instantly with "the user canceled the
//! selection" — a picker that silently does nothing, indistinguishable from a
//! real dismissal. macOS has the same picker natively as `NSColorSampler`, so
//! Dive asks the system for it and leaves the page out of it entirely. That
//! also picks from anywhere on screen, not only from Dive's own window.
//!
//! Windows ships no such picker, so this reads the screen directly: watch the
//! cursor, and on the next click read that pixel off the desktop. Both routes
//! sample the composited screen, so both see what the user sees -- video,
//! other applications, the desktop -- rather than only what the page drew.

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

/// Ask the user to sample a pixel. `Ok(None)` means they dismissed it.
///
/// Windows has no system colour sampler, so this is the sampler: wait for a
/// click and read that pixel off the desktop device context. Runs on the
/// calling thread, which is an IPC worker rather than the UI thread, so the
/// wait blocks nothing the user can see.
#[cfg(target_os = "windows")]
#[allow(unsafe_code)] // Reading the screen is Win32-only.
pub fn sample(_app: &tauri::AppHandle<crate::Runtime>) -> AppResult<Option<String>> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{CLR_INVALID, GetDC, GetPixel, ReleaseDC};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE, VK_LBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    // The high bit is "down right now"; the low bit is "was pressed since the
    // last call" and would report the click that opened the picker.
    let down = |key: i32| unsafe { GetAsyncKeyState(key) as u16 & 0x8000 != 0 };

    // The click on "Pick a colour" is very likely still held. Sampling now
    // would return the colour of the button the user just pressed, so let go
    // of that one first and wait for a fresh press.
    let deadline = std::time::Instant::now() + WAIT;
    while down(VK_LBUTTON.0.into()) {
        if std::time::Instant::now() > deadline {
            return Ok(None);
        }
        std::thread::sleep(POLL);
    }

    loop {
        if down(VK_ESCAPE.0.into()) || std::time::Instant::now() > deadline {
            return Ok(None);
        }
        if !down(VK_LBUTTON.0.into()) {
            std::thread::sleep(POLL);
            continue;
        }
        let mut point = POINT::default();
        if unsafe { GetCursorPos(&mut point) }.is_err() {
            return Err(AppError::new("could not read the cursor position"));
        }
        // A null DC is the whole screen, which is the point: the eyedropper
        // reads any pixel, not only Dive's own window.
        let screen = unsafe { GetDC(None) };
        let colour = unsafe { GetPixel(screen, point.x, point.y) };
        unsafe { ReleaseDC(None, screen) };
        if colour == CLR_INVALID {
            return Err(AppError::new("that pixel could not be read"));
        }
        // COLORREF is 0x00bbggrr, the reverse of the hex the panel shows.
        let byte = |shift: u32| f64::from((colour.0 >> shift) & 0xff) / 255.0;
        return Ok(Some(hex(byte(0), byte(8), byte(16))));
    }
}

/// How often to look at the mouse. Fast enough to feel instant, idle enough
/// not to spin a core while the user decides.
#[cfg(target_os = "windows")]
const POLL: std::time::Duration = std::time::Duration::from_millis(16);

/// The picker gives up eventually rather than leaving a worker parked
/// forever. macOS needs no equivalent: its sampler owns the session and ends
/// it itself.
#[cfg(target_os = "windows")]
const WAIT: std::time::Duration = std::time::Duration::from_secs(120);

/// No native sampler on this platform yet.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
