//! Device emulation over CDP: viewport metrics, user agent, touch and media
//! features. State is per tab and cleared with `None`.

use dive_cdp::CdpSession;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;

use crate::error::{AppError, AppResult};

/// A device preset as sent by the chrome.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Device {
    /// Viewport width in CSS pixels.
    pub width: u32,
    /// Viewport height in CSS pixels.
    pub height: u32,
    /// Device pixel ratio.
    pub dpr: f64,
    /// Mobile layout (viewport meta honored, overlay scrollbars).
    pub mobile: bool,
    /// Emit touch events for mouse input.
    pub touch: bool,
    /// User agent override; empty keeps the default.
    pub user_agent: String,
    /// `"iOS" | "Android" | "macOS" | "Windows"`, used for client hints.
    pub platform: String,
}

/// Media feature overrides.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct MediaOverrides {
    /// `light` | `dark`, or none to clear.
    pub color_scheme: Option<String>,
    /// `reduce` | `no-preference`, or none to clear.
    pub reduced_motion: Option<String>,
    /// `print` | `screen`, or none to clear.
    pub media_type: Option<String>,
}

/// Build the CDP calls for a device, or the calls that clear emulation.
pub fn device_calls(device: Option<&Device>) -> Vec<(&'static str, Value)> {
    let Some(d) = device else {
        return vec![
            ("Emulation.clearDeviceMetricsOverride", json!({})),
            (
                "Emulation.setTouchEmulationEnabled",
                json!({"enabled": false}),
            ),
            ("Emulation.setUserAgentOverride", json!({"userAgent": ""})),
        ];
    };
    let landscape = d.width > d.height;
    let (orientation, angle) = if landscape {
        ("landscapePrimary", 90)
    } else {
        ("portraitPrimary", 0)
    };
    let max_touch_points = if d.touch { 5 } else { 1 };
    let touch_config = if d.mobile { "mobile" } else { "desktop" };
    let mut calls = vec![
        (
            "Emulation.setDeviceMetricsOverride",
            json!({
                "width": d.width,
                "height": d.height,
                "deviceScaleFactor": d.dpr,
                "mobile": d.mobile,
                "screenOrientation": { "type": orientation, "angle": angle }
            }),
        ),
        (
            "Emulation.setTouchEmulationEnabled",
            json!({"enabled": d.touch, "maxTouchPoints": max_touch_points}),
        ),
        (
            "Emulation.setEmitTouchEventsForMouse",
            json!({"enabled": d.touch, "configuration": touch_config}),
        ),
    ];
    if !d.user_agent.is_empty() {
        // Client hints must be set too or `navigator.userAgentData` disagrees with the UA string.
        let (platform, platform_version) = match d.platform.as_str() {
            "iOS" => ("iOS", "18.0"),
            "Android" => ("Android", "15"),
            "Windows" => ("Windows", "15.0.0"),
            _ => ("macOS", "15.0.0"),
        };
        let (architecture, model) = if d.mobile {
            ("", "device")
        } else {
            ("arm", "")
        };
        calls.push((
            "Emulation.setUserAgentOverride",
            json!({
                "userAgent": d.user_agent,
                "userAgentMetadata": {
                    "brands": [{"brand": "Chromium", "version": "140"}, {"brand": "Not=A?Brand", "version": "24"}],
                    "fullVersionList": [{"brand": "Chromium", "version": "140.0.0.0"}],
                    "platform": platform,
                    "platformVersion": platform_version,
                    "architecture": architecture,
                    "model": model,
                    "mobile": d.mobile,
                }
            }),
        ));
    }
    calls
}

/// Build the `Emulation.setEmulatedMedia` call.
pub fn media_call(m: &MediaOverrides) -> (&'static str, Value) {
    let mut features = Vec::new();
    if let Some(v) = &m.color_scheme {
        features.push(json!({"name": "prefers-color-scheme", "value": v}));
    }
    if let Some(v) = &m.reduced_motion {
        features.push(json!({"name": "prefers-reduced-motion", "value": v}));
    }
    (
        "Emulation.setEmulatedMedia",
        json!({"media": m.media_type.clone().unwrap_or_default(), "features": features}),
    )
}

/// Network condition presets, matching Chrome's `DevTools` throttling menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum NetworkProfile {
    Offline,
    Slow3g,
    Fast3g,
}

/// The CDP call for a throttling preset, or the one that clears it.
pub fn network_call(profile: Option<NetworkProfile>) -> (&'static str, Value) {
    // (latency ms, download B/s, upload B/s)
    let (offline, latency, down, up) = match profile {
        None => (false, 0, -1.0, -1.0),
        Some(NetworkProfile::Offline) => (true, 0, 0.0, 0.0),
        Some(NetworkProfile::Slow3g) => (false, 2000, 50_000.0, 50_000.0),
        Some(NetworkProfile::Fast3g) => (false, 560, 180_000.0, 84_375.0),
    };
    (
        "Network.emulateNetworkConditions",
        json!({"offline": offline, "latency": latency, "downloadThroughput": down, "uploadThroughput": up}),
    )
}

/// Parse a throttling profile from the name an agent or the chrome uses.
///
/// `none` is a real answer, not a parse failure: it is how a caller clears
/// throttling again.
pub fn profile_by_name(name: &str) -> Result<Option<NetworkProfile>, AppError> {
    match name.trim().to_ascii_lowercase().replace('_', "-").as_str() {
        "none" | "off" | "" => Ok(None),
        "offline" => Ok(Some(NetworkProfile::Offline)),
        "slow-3g" | "slow3g" => Ok(Some(NetworkProfile::Slow3g)),
        "fast-3g" | "fast3g" => Ok(Some(NetworkProfile::Fast3g)),
        other => Err(AppError::new(format!(
            "unknown throttling profile {other:?}; use offline, slow-3g, fast-3g or none"
        ))),
    }
}

/// A named device, as the chrome's simulator and `page_resize` both see it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Preset {
    /// Stable id, for example `iphone-15`.
    pub id: String,
    /// Display name.
    pub name: String,
    /// The device itself.
    pub device: Device,
}

/// User agents, kept as builders so the catalog stays readable.
fn ios_ua(version: &str) -> String {
    let major = version.split('_').next().unwrap_or("18");
    format!(
        "Mozilla/5.0 (iPhone; CPU iPhone OS {version} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{major}.0 Mobile/15E148 Safari/604.1"
    )
}

const IPAD_UA: &str = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

fn android_ua(model: &str) -> String {
    format!(
        "Mozilla/5.0 (Linux; Android 15; {model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36"
    )
}

/// The device catalog, mirroring `src/data/devices.ts`.
///
/// Duplicated deliberately: the chrome needs it synchronously to render the
/// device menu, and the host needs it to answer `page_resize` without a round
/// trip through the UI. A test asserts the two lists have not drifted.
pub fn presets() -> Vec<Preset> {
    let phone =
        |id: &str, name: &str, w: u32, h: u32, dpr: f64, ua: String, platform: &str| Preset {
            id: id.to_owned(),
            name: name.to_owned(),
            device: Device {
                width: w,
                height: h,
                dpr,
                mobile: true,
                touch: true,
                user_agent: ua,
                platform: platform.to_owned(),
            },
        };
    let desktop = |id: &str, name: &str, w: u32, h: u32, platform: &str| Preset {
        id: id.to_owned(),
        name: name.to_owned(),
        device: Device {
            width: w,
            height: h,
            dpr: 1.0,
            mobile: false,
            touch: false,
            user_agent: String::new(),
            platform: platform.to_owned(),
        },
    };
    vec![
        phone(
            "iphone-se",
            "iPhone SE",
            375,
            667,
            2.0,
            ios_ua("18_0"),
            "iOS",
        ),
        phone(
            "iphone-15",
            "iPhone 15",
            393,
            852,
            3.0,
            ios_ua("18_0"),
            "iOS",
        ),
        phone(
            "iphone-15-pro-max",
            "iPhone 15 Pro Max",
            430,
            932,
            3.0,
            ios_ua("18_0"),
            "iOS",
        ),
        phone(
            "pixel-8",
            "Pixel 8",
            412,
            915,
            2.625,
            android_ua("Pixel 8"),
            "Android",
        ),
        phone(
            "galaxy-s24",
            "Galaxy S24",
            360,
            780,
            3.0,
            android_ua("SM-S921B"),
            "Android",
        ),
        phone(
            "ipad-mini",
            "iPad Mini",
            768,
            1024,
            2.0,
            IPAD_UA.to_owned(),
            "iOS",
        ),
        phone(
            "ipad-pro-11",
            "iPad Pro 11",
            834,
            1194,
            2.0,
            IPAD_UA.to_owned(),
            "iOS",
        ),
        desktop("laptop", "Laptop 1366", 1366, 768, "Windows"),
        desktop("desktop", "Desktop 1920", 1920, 1080, "macOS"),
    ]
}

/// Look a preset up by id.
pub fn preset_by_id(id: &str) -> Option<Preset> {
    let wanted = id.trim().to_ascii_lowercase();
    presets().into_iter().find(|p| p.id == wanted)
}

/// Swap width and height. Landscape is the caller's business, not a
/// separate catalog entry.
pub fn rotate(mut preset: Preset) -> Preset {
    std::mem::swap(&mut preset.device.width, &mut preset.device.height);
    preset
}

/// Largest viewport `page_resize` will emulate. A pathological size makes
/// Chromium allocate a surface big enough to take the tab down with it.
pub const MAX_VIEWPORT_AREA: u64 = 8_294_400;

/// A plain viewport of exactly `width` by `height`, with no device traits.
pub fn exact(width: u32, height: u32) -> Result<Device, AppError> {
    if width == 0 || height == 0 {
        return Err(AppError::new("width and height have to be above zero"));
    }
    if u64::from(width) * u64::from(height) > MAX_VIEWPORT_AREA {
        return Err(AppError::new(format!(
            "{width}x{height} is larger than the {MAX_VIEWPORT_AREA} pixel limit"
        )));
    }
    Ok(Device {
        width,
        height,
        dpr: 1.0,
        mobile: false,
        touch: false,
        user_agent: String::new(),
        platform: "macOS".to_owned(),
    })
}

/// Apply a list of calls, stopping at the first failure.
pub async fn apply(session: &CdpSession, calls: Vec<(&'static str, Value)>) -> AppResult<()> {
    for (method, params) in calls {
        session
            .call(method, params)
            .await
            .map_err(|e| AppError::new(format!("{method}: {e}")))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn throttling_profiles_parse_by_name_and_none_clears() {
        assert_eq!(profile_by_name("none").unwrap(), None);
        assert_eq!(profile_by_name("").unwrap(), None);
        assert_eq!(
            profile_by_name("slow-3g").unwrap(),
            Some(NetworkProfile::Slow3g)
        );
        // Agents write it both ways; both mean the same thing.
        assert_eq!(
            profile_by_name("SLOW_3G").unwrap(),
            Some(NetworkProfile::Slow3g)
        );
        assert_eq!(
            profile_by_name("offline").unwrap(),
            Some(NetworkProfile::Offline)
        );
        let error = profile_by_name("dial-up").unwrap_err().message;
        assert!(error.contains("slow-3g"), "{error}");
    }

    #[test]
    fn presets_are_addressable_by_id_and_rotate() {
        let phone = preset_by_id("iphone-15").expect("catalogued");
        assert_eq!((phone.device.width, phone.device.height), (393, 852));
        assert!(phone.device.mobile && phone.device.touch);
        assert!(phone.device.user_agent.contains("iPhone"));

        let landscape = rotate(phone);
        assert_eq!(
            (landscape.device.width, landscape.device.height),
            (852, 393)
        );

        assert!(
            preset_by_id("IPHONE-15").is_some(),
            "ids are case-insensitive"
        );
        assert!(preset_by_id("nokia-3310").is_none());
        // Every id is unique, or `page_resize` would silently pick one.
        let mut ids: Vec<String> = presets().into_iter().map(|p| p.id).collect();
        let total = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), total, "duplicate preset id");
    }

    #[test]
    fn exact_sizes_are_bounded() {
        let device = exact(1024, 768).unwrap();
        assert_eq!((device.width, device.height), (1024, 768));
        assert!(!device.mobile, "an exact size is not a phone");
        assert!(exact(0, 768).is_err());
        assert!(
            exact(100_000, 100_000).is_err(),
            "a surface that large can take the tab down"
        );
    }

    #[test]
    fn the_host_catalog_matches_the_chrome_catalog() {
        // The device menu reads src/data/devices.ts; page_resize reads this
        // list. Drift means an agent resizes to something the user cannot see
        // in the menu, or the reverse.
        let ts = include_str!("../../src/data/devices.ts");
        for preset in presets() {
            let needle = format!("id: \"{}\"", preset.id);
            assert!(
                ts.contains(&needle),
                "{} is in the host catalog but not in devices.ts",
                preset.id
            );
            assert!(
                ts.contains(&format!(
                    "width: {}, height: {}",
                    preset.device.width, preset.device.height
                )),
                "{} has a different size in devices.ts",
                preset.id
            );
        }
        let in_ts = ts.matches("{ id: \"").count();
        assert_eq!(
            in_ts,
            presets().len(),
            "devices.ts has {in_ts} presets and the host has {}",
            presets().len()
        );
    }

    #[test]
    fn network_presets_clear_and_throttle() {
        let (_, clear) = network_call(None);
        assert_eq!(clear["downloadThroughput"], -1.0);
        assert_eq!(clear["offline"], false);
        let (m, slow) = network_call(Some(NetworkProfile::Slow3g));
        assert_eq!(m, "Network.emulateNetworkConditions");
        assert_eq!(slow["latency"], 2000);
        assert_eq!(
            network_call(Some(NetworkProfile::Offline)).1["offline"],
            true
        );
    }

    fn phone() -> Device {
        Device {
            width: 393,
            height: 852,
            dpr: 3.0,
            mobile: true,
            touch: true,
            user_agent: "Mozilla/5.0 (iPhone)".into(),
            platform: "iOS".into(),
        }
    }

    #[test]
    fn device_calls_cover_metrics_touch_and_ua() {
        let calls = device_calls(Some(&phone()));
        let names: Vec<_> = calls.iter().map(|(m, _)| *m).collect();
        assert_eq!(
            names,
            [
                "Emulation.setDeviceMetricsOverride",
                "Emulation.setTouchEmulationEnabled",
                "Emulation.setEmitTouchEventsForMouse",
                "Emulation.setUserAgentOverride"
            ]
        );
        assert_eq!(calls[0].1["screenOrientation"]["type"], "portraitPrimary");
        assert_eq!(calls[3].1["userAgentMetadata"]["platform"], "iOS");
        assert_eq!(calls[3].1["userAgentMetadata"]["mobile"], true);
    }

    #[test]
    fn landscape_and_desktop_without_ua() {
        let mut d = phone();
        d.width = 852;
        d.height = 393;
        d.user_agent.clear();
        let calls = device_calls(Some(&d));
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].1["screenOrientation"]["angle"], 90);
    }

    #[test]
    fn clearing_and_media() {
        let names: Vec<_> = device_calls(None).iter().map(|(m, _)| *m).collect();
        assert_eq!(names[0], "Emulation.clearDeviceMetricsOverride");
        let (m, p) = media_call(&MediaOverrides {
            color_scheme: Some("dark".into()),
            reduced_motion: None,
            media_type: Some("print".into()),
        });
        assert_eq!(m, "Emulation.setEmulatedMedia");
        assert_eq!(p["media"], "print");
        assert_eq!(p["features"][0]["value"], "dark");
    }
}
