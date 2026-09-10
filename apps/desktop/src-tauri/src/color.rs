//! The page's colours: an eyedropper over any pixel, and the palette it uses.
//!
//! The colour-picker extensions read `background-color` off the DOM, so they
//! are blind to a pixel inside a canvas, a video frame, an image or a
//! gradient — the places a colour usually needs picking from. Chromium's
//! `EyeDropper` samples the composited surface instead, which answers for all
//! of them, and Dive can open it in the page because it drives the page.
//!
//! The conversions live here rather than in the page so they are testable
//! without a DOM, and so the panel and the agent see the same numbers.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::{AppError, AppResult};

/// One colour the page paints, and how much it leans on it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct PaletteEntry {
    /// `#rrggbb`.
    pub hex: String,
    /// Alpha as painted, 0-1.
    pub alpha: f64,
    /// How many elements paint it.
    pub count: u32,
    /// What it is mostly used for: `text`, `background` or `border`.
    pub role: String,
    /// A selector-ish description of one element using it.
    pub sample: String,
}

/// The palette of a page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, Default)]
pub struct Palette {
    /// Most-used first.
    pub colors: Vec<PaletteEntry>,
    /// `<meta name="theme-color">`, when declared.
    pub theme_color: Option<String>,
    /// How many elements were examined.
    pub scanned: u32,
}

/// A colour in every notation a developer pastes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ColorFormats {
    /// `#rrggbb`.
    pub hex: String,
    /// `rgb(r g b)`.
    pub rgb: String,
    /// `hsl(h s% l%)`.
    pub hsl: String,
    /// Relative luminance, 0-1, for contrast work.
    pub luminance: f64,
    /// Contrast against white, 1-21.
    pub on_white: f64,
    /// Contrast against black, 1-21.
    pub on_black: f64,
}

/// Parse `#rgb`, `#rrggbb` or `#rrggbbaa` into 8-bit channels.
pub fn parse_hex(value: &str) -> Option<(u8, u8, u8)> {
    let raw = value.trim().trim_start_matches('#');
    // A hex digit is 0..=15, so `d * 17` is 0..=255: shorthand doubles the
    // digit, #a -> #aa. `u8::try_from` proves that rather than asserting it.
    let expand = |c: char| -> Option<u8> { u8::try_from(c.to_digit(16)? * 17).ok() };
    match raw.len() {
        3 | 4 => {
            let mut chars = raw.chars();
            Some((
                expand(chars.next()?)?,
                expand(chars.next()?)?,
                expand(chars.next()?)?,
            ))
        }
        6 | 8 => Some((
            u8::from_str_radix(raw.get(0..2)?, 16).ok()?,
            u8::from_str_radix(raw.get(2..4)?, 16).ok()?,
            u8::from_str_radix(raw.get(4..6)?, 16).ok()?,
        )),
        _ => None,
    }
}

/// Relative luminance, per WCAG 2.
pub fn luminance(r: u8, g: u8, b: u8) -> f64 {
    let channel = |v: u8| {
        let c = f64::from(v) / 255.0;
        if c <= 0.03928 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/// Contrast ratio between two luminances, 1-21, per WCAG 2.
pub fn contrast(a: f64, b: f64) -> f64 {
    let (hi, lo) = if a >= b { (a, b) } else { (b, a) };
    (hi + 0.05) / (lo + 0.05)
}

/// RGB as hue, saturation and lightness, each rounded for display.
// r, g, b, h, s and l are the names these formulas are written in; a longer
// spelling makes the arithmetic harder to check against the spec.
#[allow(clippy::many_single_char_names)]
pub fn to_hsl(r: u8, g: u8, b: u8) -> (u32, u32, u32) {
    let (rf, gf, bf) = (
        f64::from(r) / 255.0,
        f64::from(g) / 255.0,
        f64::from(b) / 255.0,
    );
    let max = rf.max(gf).max(bf);
    let min = rf.min(gf).min(bf);
    let delta = max - min;
    let l = f64::midpoint(max, min);
    let s = if delta == 0.0 {
        0.0
    } else {
        delta / (1.0 - (2.0f64.mul_add(l, -1.0)).abs())
    };
    let h = if delta == 0.0 {
        0.0
    } else if (max - rf).abs() < f64::EPSILON {
        60.0 * (((gf - bf) / delta) % 6.0)
    } else if (max - gf).abs() < f64::EPSILON {
        60.0 * (((bf - rf) / delta) + 2.0)
    } else {
        60.0 * (((rf - gf) / delta) + 4.0)
    };
    let h = if h < 0.0 { h + 360.0 } else { h };
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    (
        h.round() as u32 % 360,
        (s * 100.0).round() as u32,
        (l * 100.0).round() as u32,
    )
}

/// Every notation for one colour, plus what it contrasts with.
// r, g, b, h, s and l are the names these formulas are written in; a longer
// spelling makes the arithmetic harder to check against the spec.
#[allow(clippy::many_single_char_names)]
pub fn formats(value: &str) -> Option<ColorFormats> {
    let (r, g, b) = parse_hex(value)?;
    let (h, s, l) = to_hsl(r, g, b);
    let lum = luminance(r, g, b);
    Some(ColorFormats {
        hex: format!("#{r:02x}{g:02x}{b:02x}"),
        rgb: format!("rgb({r} {g} {b})"),
        hsl: format!("hsl({h} {s}% {l}%)"),
        luminance: lum,
        on_white: contrast(lum, 1.0),
        on_black: contrast(lum, 0.0),
    })
}

async fn evaluate(session: &dive_cdp::CdpSession, script: String) -> AppResult<serde_json::Value> {
    let result = session
        .call(
            "Runtime.evaluate",
            serde_json::json!({
                "expression": script,
                "returnByValue": true,
                "awaitPromise": true,
            }),
        )
        .await
        .map_err(|e| AppError::new(format!("could not read the page's colours: {e}")))?;
    Ok(result["result"]["value"].clone())
}

/// The colours a page paints, most-used first.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_palette(
    state: tauri::State<'_, crate::state::AppState>,
    id: dive_core::TabId,
) -> AppResult<Palette> {
    let session = crate::commands::cdp_for(&state, id)?;
    let script = crate::pagescript::build("color.js", &[]);
    let value = evaluate(&session, script).await?;
    let mut palette: Palette = serde_json::from_value(value)
        .map_err(|e| AppError::new(format!("the palette came back in an odd shape: {e}")))?;
    palette.theme_color = palette.theme_color.filter(|t| !t.is_empty());
    Ok(palette)
}

/// Sample a pixel with the system eyedropper and return the colour chosen.
///
/// `None` means the person dismissed it, which is an outcome rather than an
/// error: the caller closes the cursor and says nothing.
///
/// The page is put on screen first even though the sampler can reach any
/// pixel: the colour being reached for is almost always one this tab is
/// painting, and the panel sits over it.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_eyedropper(
    app: tauri::AppHandle<crate::Runtime>,
    id: dive_core::TabId,
) -> AppResult<Option<ColorFormats>> {
    crate::commands::focus_page(&app, id)?;
    let picked = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || crate::eyedropper::sample(&app)
    })
    .await
    .map_err(AppError::new)??;
    let Some(hex) = picked else { return Ok(None) };
    formats(&hex).map(Some).ok_or_else(|| {
        AppError::new(format!(
            "the eyedropper returned a colour we cannot read: {hex}"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_is_read_in_every_length_it_is_written() {
        assert_eq!(parse_hex("#7fd8c8"), Some((0x7f, 0xd8, 0xc8)));
        assert_eq!(parse_hex("7fd8c8"), Some((0x7f, 0xd8, 0xc8)));
        // Shorthand doubles each digit, so #abc is #aabbcc.
        assert_eq!(parse_hex("#abc"), Some((0xaa, 0xbb, 0xcc)));
        // An alpha channel is read and dropped: it is carried separately.
        assert_eq!(parse_hex("#7fd8c880"), Some((0x7f, 0xd8, 0xc8)));
        assert_eq!(parse_hex("#ABC"), Some((0xaa, 0xbb, 0xcc)));
        assert_eq!(parse_hex("not a colour"), None);
        assert_eq!(parse_hex("#12345"), None);
        assert_eq!(parse_hex(""), None);
    }

    #[test]
    fn contrast_matches_the_wcag_anchors() {
        let white = luminance(255, 255, 255);
        let black = luminance(0, 0, 0);
        // The two ends of the scale, which the spec fixes exactly.
        assert!((contrast(white, black) - 21.0).abs() < 0.01);
        assert!((contrast(white, white) - 1.0).abs() < 0.001);
        // Order does not matter.
        assert!((contrast(black, white) - contrast(white, black)).abs() < f64::EPSILON);
    }

    #[test]
    fn formats_give_every_notation_and_both_contrasts() {
        let f = formats("#7fd8c8").unwrap();
        assert_eq!(f.hex, "#7fd8c8");
        assert_eq!(f.rgb, "rgb(127 216 200)");
        // (127,216,200): max=g so h = 60·((b−r)/Δ + 2) = 169.2, s = Δ/(1−|2l−1|) = 53%.
        assert_eq!(f.hsl, "hsl(169 53% 67%)");
        // A pale mint reads well on black and poorly on white.
        assert!(f.on_black > f.on_white);
        assert!(f.on_white < 4.5, "not AA on white: {}", f.on_white);
        assert!(f.on_black > 4.5, "AA on black: {}", f.on_black);
    }

    #[test]
    fn hsl_handles_grey_and_each_hue_sector() {
        // Grey has no hue and no saturation.
        assert_eq!(to_hsl(128, 128, 128).1, 0);
        assert_eq!(to_hsl(255, 0, 0), (0, 100, 50));
        assert_eq!(to_hsl(0, 255, 0), (120, 100, 50));
        assert_eq!(to_hsl(0, 0, 255), (240, 100, 50));
        // Hue stays inside one turn rather than reporting 360.
        assert!(to_hsl(255, 0, 1).0 < 360);
        assert_eq!(to_hsl(255, 255, 255), (0, 0, 100));
        assert_eq!(to_hsl(0, 0, 0), (0, 0, 0));
    }

    #[test]
    fn an_unreadable_colour_is_refused_rather_than_guessed() {
        assert!(formats("rgb(1,2,3)").is_none());
        assert!(formats("#xyz").is_none());
    }
}
