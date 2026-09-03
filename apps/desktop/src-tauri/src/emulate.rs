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
