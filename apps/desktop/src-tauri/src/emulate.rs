//! Device emulation over CDP: viewport metrics, user agent, touch, safe-area
//! insets, media features, network conditions, and the environment the page
//! believes it runs in. State is per tab and cleared with `None`.
//!
//! The device catalog is `src/data/devices.json`, shared with the chrome. The
//! chrome needs it synchronously to draw the picker; the host needs it to
//! answer `page_resize` without a round trip through the UI. One file means
//! an agent and a person asking for "iPhone 15" get the same phone.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use dive_cdp::CdpSession;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;

use crate::error::{AppError, AppResult};

/// The shared catalog, verbatim.
const CATALOG: &str = include_str!("../../src/data/devices.json");

/// Insets in CSS pixels.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Insets {
    /// Top.
    pub top: u32,
    /// Bottom.
    pub bottom: u32,
    /// Left.
    pub left: u32,
    /// Right.
    pub right: u32,
}

/// A device as sent by the chrome, or built from a catalog preset.
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
    /// Draw the viewport at this fraction of its size, so a 932-tall phone
    /// fits a laptop window while `innerHeight` still says 932.
    #[serde(default)]
    pub scale: Option<f64>,
    /// What `env(safe-area-inset-*)` reports. Absent leaves it alone.
    #[serde(default)]
    pub safe_area: Option<Insets>,
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
    /// `standalone` | `browser` | `fullscreen` | `minimal-ui`, or none to
    /// clear. What `@media (display-mode: standalone)` matches, which is how
    /// an installed web app tells itself apart from a tab.
    #[serde(default)]
    pub display_mode: Option<String>,
}

/// Where and when the page thinks it is.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct Environment {
    /// Reported by `navigator.geolocation`; none clears the override.
    pub geolocation: Option<Geolocation>,
    /// IANA zone such as `Asia/Tokyo`; none clears the override.
    pub timezone: Option<String>,
    /// ICU locale such as `ja_JP`; none clears the override.
    pub locale: Option<String>,
}

/// A position for `navigator.geolocation`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Geolocation {
    /// Degrees north.
    pub latitude: f64,
    /// Degrees east.
    pub longitude: f64,
    /// Metres.
    pub accuracy: f64,
}

/// One CDP call, and whether it is allowed to fail.
///
/// Some emulation methods are experimental and absent from older engines
/// (`setSafeAreaInsetsOverride`, `setScrollbarsHidden`). Those are worth
/// trying and worth surviving; a failure to set the viewport itself is not.
#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    /// CDP method.
    pub method: &'static str,
    /// Parameters.
    pub params: Value,
    /// Fail the whole apply when this call fails.
    pub required: bool,
}

impl Call {
    fn required(method: &'static str, params: Value) -> Self {
        Self {
            method,
            params,
            required: true,
        }
    }

    fn optional(method: &'static str, params: Value) -> Self {
        Self {
            method,
            params,
            required: false,
        }
    }
}

/// Build the CDP calls for a device, or the calls that clear emulation.
pub fn device_calls(device: Option<&Device>) -> Vec<Call> {
    let Some(d) = device else {
        return vec![
            Call::required("Emulation.clearDeviceMetricsOverride", json!({})),
            Call::required(
                "Emulation.setTouchEmulationEnabled",
                json!({"enabled": false}),
            ),
            Call::required("Emulation.setUserAgentOverride", json!({"userAgent": ""})),
            Call::optional("Emulation.setSafeAreaInsetsOverride", json!({"insets": {}})),
            Call::optional("Emulation.setScrollbarsHidden", json!({"hidden": false})),
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
    // `dontSetVisibleSize` is load-bearing. Without it Chromium resizes the
    // widget's visible area to the emulated width and height, overriding the
    // bounds the chrome gave the native view and ignoring `scale`: the page
    // painted at full device size straight past the drawn phone. With it the
    // view keeps the slot's bounds and the page is drawn scaled inside them,
    // which is how DevTools' own device mode works.
    let mut metrics = json!({
        "width": d.width,
        "height": d.height,
        "deviceScaleFactor": d.dpr,
        "mobile": d.mobile,
        "dontSetVisibleSize": true,
        "screenOrientation": { "type": orientation, "angle": angle }
    });
    if let Some(scale) = d
        .scale
        .filter(|s| s.is_finite() && *s > 0.0 && (*s - 1.0).abs() > f64::EPSILON)
    {
        metrics["scale"] = json!(scale);
    }
    let mut calls = vec![
        Call::required("Emulation.setDeviceMetricsOverride", metrics),
        Call::required(
            "Emulation.setTouchEmulationEnabled",
            json!({"enabled": d.touch, "maxTouchPoints": max_touch_points}),
        ),
        Call::required(
            "Emulation.setEmitTouchEventsForMouse",
            json!({"enabled": d.touch, "configuration": touch_config}),
        ),
        // A phone has overlay scrollbars; a 15px gutter changes every
        // breakpoint the layout is being checked against.
        Call::optional("Emulation.setScrollbarsHidden", json!({"hidden": d.mobile})),
    ];
    if let Some(insets) = d.safe_area {
        calls.push(Call::optional(
            "Emulation.setSafeAreaInsetsOverride",
            json!({"insets": {
                "top": insets.top, "topMax": insets.top,
                "bottom": insets.bottom, "bottomMax": insets.bottom,
                "left": insets.left, "leftMax": insets.left,
                "right": insets.right, "rightMax": insets.right,
            }}),
        ));
    }
    if d.user_agent.is_empty() {
        // Leaving an earlier device's UA in place would make a laptop preset
        // announce itself as a phone.
        calls.push(Call::required(
            "Emulation.setUserAgentOverride",
            json!({"userAgent": ""}),
        ));
    } else {
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
        calls.push(Call::required(
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
    if let Some(v) = &m.display_mode {
        features.push(json!({"name": "display-mode", "value": v}));
    }
    (
        "Emulation.setEmulatedMedia",
        json!({"media": m.media_type.clone().unwrap_or_default(), "features": features}),
    )
}

/// The CDP calls for an environment, clearing whatever is unset.
pub fn environment_calls(env: &Environment) -> Vec<Call> {
    let mut calls = Vec::new();
    match &env.geolocation {
        Some(g) => calls.push(Call::required(
            "Emulation.setGeolocationOverride",
            json!({"latitude": g.latitude, "longitude": g.longitude, "accuracy": g.accuracy}),
        )),
        None => calls.push(Call::required(
            "Emulation.clearGeolocationOverride",
            json!({}),
        )),
    }
    // An empty id is how CDP clears each of these.
    calls.push(Call::required(
        "Emulation.setTimezoneOverride",
        json!({"timezoneId": env.timezone.clone().unwrap_or_default()}),
    ));
    calls.push(Call::optional(
        "Emulation.setLocaleOverride",
        match &env.locale {
            Some(l) => json!({"locale": l}),
            None => json!({}),
        },
    ));
    calls
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

// ----- the catalog -----

/// How the bezel is drawn, and which browser's bars go with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Frame {
    /// iPhone with a dynamic island.
    Island,
    /// iPhone with a notch.
    Notch,
    /// Classic iPhone with a home button.
    Home,
    /// Android with a punch-hole camera.
    Punch,
    /// Uniform bezel: tablets, foldables open.
    Bezel,
    /// Laptop or desktop: no phone chrome at all.
    Laptop,
}

/// A named device, as the chrome's simulator and `page_resize` both see it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Preset {
    /// Stable id, for example `iphone-15`.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Catalog group, for example `apple-phone`.
    pub group: String,
    /// Which frame it is drawn in.
    pub frame: Frame,
    /// Which browser's bars are drawn: `safari`, `chrome` or `none`.
    pub browser: String,
    /// Safe-area insets in portrait with `viewport-fit=cover`.
    pub safe_area: Insets,
    /// The device itself.
    pub device: Device,
}

/// What Dive draws around the page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum UiMode {
    /// The device's browser: status bar plus Safari or Chrome bars.
    Browser,
    /// An installed web app: status bar and home indicator only.
    Standalone,
    /// Nothing: the page gets the whole screen.
    None,
}

impl UiMode {
    /// Parse the name an agent uses.
    pub fn parse(name: &str) -> Result<Self, AppError> {
        match name.trim().to_ascii_lowercase().as_str() {
            "browser" | "safari" | "chrome" => Ok(Self::Browser),
            "standalone" | "app" | "pwa" => Ok(Self::Standalone),
            "none" | "screen" | "full" => Ok(Self::None),
            other => Err(AppError::new(format!(
                "unknown ui {other:?}; use browser, standalone or none"
            ))),
        }
    }
}

/// The strips around the page for one orientation, in device CSS pixels.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
struct Strips {
    status: u32,
    top: u32,
    bottom: u32,
    home: u32,
    left: u32,
    right: u32,
}

#[derive(Debug, Default, Deserialize)]
struct UiEntry {
    browser: String,
    portrait: Strips,
    landscape: Strips,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum UaSpec {
    Ios { version: String },
    Ipad,
    Android { model: String },
    Desktop { platform: String },
}

#[derive(Debug, Deserialize)]
struct RawDevice {
    id: String,
    name: String,
    group: String,
    width: u32,
    height: u32,
    dpr: f64,
    mobile: bool,
    touch: bool,
    ua: UaSpec,
    frame: Frame,
    #[serde(rename = "safeArea")]
    safe_area: Insets,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(not(test), allow(dead_code))]
struct Group {
    id: String,
}

#[derive(Debug, Default, Deserialize)]
struct Catalog {
    #[cfg_attr(not(test), allow(dead_code))]
    groups: Vec<Group>,
    ui: BTreeMap<String, UiEntry>,
    devices: Vec<RawDevice>,
}

fn parse_catalog(source: &str) -> Result<Catalog, serde_json::Error> {
    serde_json::from_str(source)
}

fn catalog() -> &'static Catalog {
    static PARSED: OnceLock<Catalog> = OnceLock::new();
    PARSED.get_or_init(|| {
        parse_catalog(CATALOG).unwrap_or_else(|error| {
            tracing::error!(%error, "embedded device catalog is invalid; simulator presets disabled");
            Catalog::default()
        })
    })
}

fn frame_key(frame: Frame) -> &'static str {
    match frame {
        Frame::Island => "island",
        Frame::Notch => "notch",
        Frame::Home => "home",
        Frame::Punch => "punch",
        Frame::Bezel => "bezel",
        Frame::Laptop => "laptop",
    }
}

fn ui_for_catalog(catalog: &Catalog, frame: Frame) -> Option<&UiEntry> {
    catalog.ui.get(frame_key(frame))
}

fn ui_for(frame: Frame) -> Option<&'static UiEntry> {
    ui_for_catalog(catalog(), frame)
}

/// Mirrors `iosUa` in devices.ts.
fn ios_ua(version: &str) -> String {
    let major = version.split('_').next().unwrap_or("18");
    format!(
        "Mozilla/5.0 (iPhone; CPU iPhone OS {version} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{major}.0 Mobile/15E148 Safari/604.1"
    )
}

const IPAD_UA: &str = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/// Mirrors `androidUa` in devices.ts.
fn android_ua(model: &str) -> String {
    format!(
        "Mozilla/5.0 (Linux; Android 15; {model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36"
    )
}

fn user_agent(spec: &UaSpec) -> (String, String) {
    match spec {
        UaSpec::Ios { version } => (ios_ua(version), "iOS".into()),
        UaSpec::Ipad => (IPAD_UA.to_owned(), "iOS".into()),
        UaSpec::Android { model } => (android_ua(model), "Android".into()),
        UaSpec::Desktop { platform } => (String::new(), platform.clone()),
    }
}

/// The device catalog.
pub fn presets() -> Vec<Preset> {
    catalog()
        .devices
        .iter()
        .filter_map(|d| {
            let ui = ui_for(d.frame)?;
            let (user_agent, platform) = user_agent(&d.ua);
            Some(Preset {
                id: d.id.clone(),
                name: d.name.clone(),
                group: d.group.clone(),
                frame: d.frame,
                browser: ui.browser.clone(),
                safe_area: d.safe_area,
                device: Device {
                    width: d.width,
                    height: d.height,
                    dpr: d.dpr,
                    mobile: d.mobile,
                    touch: d.touch,
                    user_agent,
                    platform,
                    scale: None,
                    safe_area: None,
                },
            })
        })
        .collect()
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

/// The strips Dive draws around the page, so the viewport is the one the
/// device's browser would actually give. Mirrors `stripsAround` in
/// `geometry.ts`; the two are tested against the same numbers.
pub fn strips_for(frame: Frame, landscape: bool, mode: UiMode) -> Insets {
    if mode == UiMode::None || frame == Frame::Laptop {
        return Insets::default();
    }
    let Some(entry) = ui_for(frame) else {
        return Insets::default();
    };
    let ui = if landscape {
        entry.landscape
    } else {
        entry.portrait
    };
    match mode {
        UiMode::Browser => Insets {
            top: ui.status + ui.top,
            bottom: ui.bottom,
            left: 0,
            right: 0,
        },
        UiMode::Standalone => Insets {
            top: ui.status,
            bottom: ui.home,
            left: ui.left,
            right: ui.right,
        },
        UiMode::None => Insets::default(),
    }
}

/// Safe-area insets to tell the page about. Zero in browser mode, as Safari
/// reports; the device's insets in standalone mode, where the page would
/// extend under the notch and the home indicator.
pub fn safe_area_for(preset: &Preset, landscape: bool, mode: UiMode) -> Insets {
    if mode != UiMode::Standalone || preset.frame == Frame::Laptop {
        return Insets::default();
    }
    if !landscape {
        return preset.safe_area;
    }
    let Some(ui) = ui_for(preset.frame).map(|entry| entry.landscape) else {
        return Insets::default();
    };
    Insets {
        top: 0,
        bottom: ui.home,
        left: ui.left,
        right: ui.right,
    }
}

/// Turn a preset into the device the page should be told about: rotated if
/// asked, shrunk by the strips, carrying the safe area.
pub fn realize(preset: &Preset, landscape: bool, mode: UiMode) -> Device {
    let base = if landscape {
        rotate(preset.clone())
    } else {
        preset.clone()
    };
    let strips = strips_for(preset.frame, landscape, mode);
    let mut device = base.device;
    device.width = device
        .width
        .saturating_sub(strips.left + strips.right)
        .max(1);
    device.height = device
        .height
        .saturating_sub(strips.top + strips.bottom)
        .max(1);
    device.safe_area = Some(safe_area_for(preset, landscape, mode));
    device
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
        scale: None,
        safe_area: None,
    })
}

/// Apply calls in order. A required failure stops and reports; an optional
/// one (an experimental method this engine lacks) is logged and skipped.
pub async fn apply(session: &CdpSession, calls: Vec<Call>) -> AppResult<()> {
    for call in calls {
        if let Err(e) = session.call(call.method, call.params).await {
            if call.required {
                return Err(AppError::new(format!("{}: {e}", call.method)));
            }
            tracing::debug!("{} unavailable, skipped: {e}", call.method);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(calls: &[Call]) -> Vec<&'static str> {
        calls.iter().map(|c| c.method).collect()
    }

    fn find<'a>(calls: &'a [Call], method: &str) -> &'a Call {
        calls
            .iter()
            .find(|c| c.method == method)
            .unwrap_or_else(|| panic!("{method} not issued"))
    }

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
    fn the_catalog_parses_and_is_consistent() {
        let all = presets();
        assert!(all.len() >= 30, "the catalog shrank to {}", all.len());
        let groups: Vec<&str> = catalog().groups.iter().map(|g| g.id.as_str()).collect();
        let mut ids: Vec<&str> = all.iter().map(|p| p.id.as_str()).collect();
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total, "duplicate preset id");
        for preset in &all {
            assert!(
                groups.contains(&preset.group.as_str()),
                "{} is in unlisted group {}",
                preset.id,
                preset.group
            );
            assert!(
                preset.device.width >= 200 && preset.device.height >= 200,
                "{}",
                preset.id
            );
            if preset.device.mobile {
                assert!(
                    preset.device.user_agent.contains("Mobile"),
                    "{} is mobile without a mobile UA",
                    preset.id
                );
            }
            // Every frame kind has strip geometry, or the stage would panic.
            let _ = ui_for(preset.frame);
        }
    }

    #[test]
    fn malformed_or_incomplete_catalog_data_is_fallible() {
        assert!(parse_catalog("{").is_err());
        let incomplete = parse_catalog(r#"{"groups":[],"ui":{},"devices":[]}"#)
            .expect("minimal catalog is valid JSON");
        assert!(ui_for_catalog(&incomplete, Frame::Island).is_none());
    }

    #[test]
    fn presets_are_addressable_by_id_and_rotate() {
        let phone = preset_by_id("iphone-15").expect("catalogued");
        assert_eq!((phone.device.width, phone.device.height), (393, 852));
        assert!(phone.device.mobile && phone.device.touch);
        assert!(phone.device.user_agent.contains("iPhone OS 18_0"));
        assert_eq!(phone.frame, Frame::Island);
        assert_eq!(phone.browser, "safari");

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
        // A laptop keeps Dive's own UA so server-side detection sees a desktop.
        assert!(preset_by_id("laptop").unwrap().device.user_agent.is_empty());
        assert_eq!(preset_by_id("pixel-8").unwrap().browser, "chrome");
    }

    #[test]
    fn the_page_gets_the_viewport_its_browser_would_give() {
        // The same numbers geometry.test.ts asserts; the two sides must agree
        // or the picker and page_resize describe different phones.
        let iphone = preset_by_id("iphone-15").unwrap();
        let safari = realize(&iphone, false, UiMode::Browser);
        assert_eq!((safari.width, safari.height), (393, 659));
        let standalone = realize(&iphone, false, UiMode::Standalone);
        assert_eq!((standalone.width, standalone.height), (393, 759));
        let bare = realize(&iphone, false, UiMode::None);
        assert_eq!((bare.width, bare.height), (393, 852));
        let landscape = realize(&iphone, true, UiMode::Browser);
        assert_eq!((landscape.width, landscape.height), (852, 322));

        let se = preset_by_id("iphone-se").unwrap();
        assert_eq!(realize(&se, false, UiMode::Browser).height, 559);

        let pixel = preset_by_id("pixel-8").unwrap();
        assert_eq!(
            realize(&pixel, false, UiMode::Browser).height,
            915 - 24 - 56 - 24
        );

        let laptop = preset_by_id("laptop").unwrap();
        for mode in [UiMode::Browser, UiMode::Standalone, UiMode::None] {
            let d = realize(&laptop, false, mode);
            assert_eq!((d.width, d.height), (1366, 768), "laptops draw no strips");
        }
    }

    #[test]
    fn safe_area_is_zero_in_a_browser_and_real_in_a_web_app() {
        let iphone = preset_by_id("iphone-15").unwrap();
        assert_eq!(
            safe_area_for(&iphone, false, UiMode::Browser),
            Insets::default()
        );
        assert_eq!(
            safe_area_for(&iphone, false, UiMode::Standalone),
            Insets {
                top: 59,
                bottom: 34,
                left: 0,
                right: 0
            }
        );
        assert_eq!(
            safe_area_for(&iphone, true, UiMode::Standalone),
            Insets {
                top: 0,
                bottom: 21,
                left: 59,
                right: 59
            }
        );
        assert_eq!(
            realize(&iphone, false, UiMode::Standalone).safe_area,
            Some(Insets {
                top: 59,
                bottom: 34,
                left: 0,
                right: 0
            })
        );
    }

    #[test]
    fn ui_modes_parse_the_names_people_use() {
        assert_eq!(UiMode::parse("browser").unwrap(), UiMode::Browser);
        assert_eq!(UiMode::parse("Safari").unwrap(), UiMode::Browser);
        assert_eq!(UiMode::parse("pwa").unwrap(), UiMode::Standalone);
        assert_eq!(UiMode::parse("none").unwrap(), UiMode::None);
        assert!(UiMode::parse("kiosk").is_err());
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
            scale: None,
            safe_area: None,
        }
    }

    #[test]
    fn device_calls_cover_metrics_touch_scrollbars_and_ua() {
        let calls = device_calls(Some(&phone()));
        assert_eq!(
            names(&calls),
            [
                "Emulation.setDeviceMetricsOverride",
                "Emulation.setTouchEmulationEnabled",
                "Emulation.setEmitTouchEventsForMouse",
                "Emulation.setScrollbarsHidden",
                "Emulation.setUserAgentOverride"
            ]
        );
        let metrics = find(&calls, "Emulation.setDeviceMetricsOverride");
        assert_eq!(
            metrics.params["screenOrientation"]["type"],
            "portraitPrimary"
        );
        assert!(
            metrics.params.get("scale").is_none(),
            "no scale unless asked"
        );
        assert!(metrics.required);
        let ua = find(&calls, "Emulation.setUserAgentOverride");
        assert_eq!(ua.params["userAgentMetadata"]["platform"], "iOS");
        assert_eq!(ua.params["userAgentMetadata"]["mobile"], true);
        // Scrollbar hiding is experimental; an engine without it must not
        // fail the whole device.
        assert!(!find(&calls, "Emulation.setScrollbarsHidden").required);
    }

    #[test]
    fn metrics_never_resize_the_widget() {
        // The stage sizes the native view; the override must not fight it.
        let d = exact(375, 667).unwrap();
        let calls = device_calls(Some(&d));
        assert_eq!(
            find(&calls, "Emulation.setDeviceMetricsOverride").params["dontSetVisibleSize"],
            json!(true)
        );
    }

    #[test]
    fn scale_and_safe_area_travel_when_given() {
        let mut d = phone();
        d.scale = Some(0.5);
        d.safe_area = Some(Insets {
            top: 59,
            bottom: 34,
            left: 0,
            right: 0,
        });
        let calls = device_calls(Some(&d));
        assert_eq!(
            find(&calls, "Emulation.setDeviceMetricsOverride").params["scale"],
            0.5
        );
        let insets = find(&calls, "Emulation.setSafeAreaInsetsOverride");
        assert_eq!(insets.params["insets"]["top"], 59);
        assert_eq!(insets.params["insets"]["bottomMax"], 34);
        assert!(!insets.required, "an older engine lacks this method");

        // A scale of exactly 1 is the default and is not sent.
        d.scale = Some(1.0);
        let calls = device_calls(Some(&d));
        assert!(
            find(&calls, "Emulation.setDeviceMetricsOverride")
                .params
                .get("scale")
                .is_none()
        );
    }

    #[test]
    fn a_desktop_preset_clears_a_previous_phone_ua() {
        let mut d = phone();
        d.width = 852;
        d.height = 393;
        d.user_agent.clear();
        d.mobile = false;
        let calls = device_calls(Some(&d));
        assert_eq!(
            find(&calls, "Emulation.setDeviceMetricsOverride").params["screenOrientation"]["angle"],
            90
        );
        // Switching from a phone to a laptop preset must not leave the phone's
        // UA behind.
        assert_eq!(
            find(&calls, "Emulation.setUserAgentOverride").params["userAgent"],
            ""
        );
        assert_eq!(
            find(&calls, "Emulation.setScrollbarsHidden").params["hidden"],
            false
        );
    }

    #[test]
    fn clearing_resets_everything_including_the_optional_overrides() {
        let calls = device_calls(None);
        assert_eq!(names(&calls)[0], "Emulation.clearDeviceMetricsOverride");
        assert!(names(&calls).contains(&"Emulation.setSafeAreaInsetsOverride"));
        assert_eq!(
            find(&calls, "Emulation.setScrollbarsHidden").params["hidden"],
            false
        );
    }

    #[test]
    fn media_covers_scheme_motion_type_and_display_mode() {
        let (m, p) = media_call(&MediaOverrides {
            color_scheme: Some("dark".into()),
            reduced_motion: None,
            media_type: Some("print".into()),
            display_mode: Some("standalone".into()),
        });
        assert_eq!(m, "Emulation.setEmulatedMedia");
        assert_eq!(p["media"], "print");
        assert_eq!(p["features"][0]["value"], "dark");
        assert_eq!(p["features"][1]["name"], "display-mode");
        assert_eq!(p["features"][1]["value"], "standalone");
    }

    #[test]
    fn environment_sets_and_clears_each_override() {
        let set = environment_calls(&Environment {
            geolocation: Some(Geolocation {
                latitude: 35.68,
                longitude: 139.69,
                accuracy: 50.0,
            }),
            timezone: Some("Asia/Tokyo".into()),
            locale: Some("ja_JP".into()),
        });
        assert_eq!(
            find(&set, "Emulation.setGeolocationOverride").params["latitude"],
            35.68
        );
        assert_eq!(
            find(&set, "Emulation.setTimezoneOverride").params["timezoneId"],
            "Asia/Tokyo"
        );
        assert_eq!(
            find(&set, "Emulation.setLocaleOverride").params["locale"],
            "ja_JP"
        );

        let clear = environment_calls(&Environment::default());
        assert!(names(&clear).contains(&"Emulation.clearGeolocationOverride"));
        assert_eq!(
            find(&clear, "Emulation.setTimezoneOverride").params["timezoneId"],
            ""
        );
        assert!(
            find(&clear, "Emulation.setLocaleOverride")
                .params
                .get("locale")
                .is_none()
        );
    }
}
