//! Tool parameter types, the locator grammar and the request limits.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::error::BrowserError;

/// The locator grammar the browser resolves, quoted in tool descriptions and
/// reported by `dive_capabilities` so a caller does not have to guess.
///
/// Lives here rather than next to the engine so the tool schema, the agent
/// tool descriptions and the implementation cannot describe different
/// grammars.
pub const LOCATOR_GRAMMAR: &str = concat!(
    "role=button[name=\"Save\"] (also [exact], [checked], [selected], [disabled], [level=2]); ",
    "text=Continue (substring, case-insensitive; text=\"Continue\" is exact); ",
    "testid=submit; label=Email; placeholder=Search; alt=Logo; title=Close; ",
    "css=.btn > span (also the default with no prefix); ",
    "nth=0 (nth=-1 is the last); visible=true. ",
    "Chain with >> to scope each step inside the last: role=dialog >> text=Delete",
);

/// Longest wait `page_wait_for` will accept, so a stuck condition cannot hold
/// a tool call open indefinitely.
pub const MAX_WAIT_MS: u64 = 60_000;

/// Default wait when a caller does not say.
pub const DEFAULT_WAIT_MS: u64 = 15_000;

/// Longest locator accepted from a client.
pub const MAX_LOCATOR_CHARS: usize = 4_096;

/// Longest legacy accessibility reference accepted from a client.
pub const MAX_REF_CHARS: usize = 128;

/// Which tab; omitted means the active one.
#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct TabRef {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
}

/// Open a URL.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct OpenParams {
    /// Absolute URL (https://...).
    pub url: String,
}

/// Navigate a tab.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct NavigateParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// Absolute URL.
    pub url: String,
}

/// Screenshot options.
#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct ScreenshotParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// Capture the whole document instead of the viewport.
    #[serde(default)]
    pub full_page: bool,
}

/// How to address an element.
///
/// A `locator` is resolved against the live DOM at the moment of the action,
/// so it survives a re-render. A `ref` is a CDP backend node id from the last
/// `page_state` and goes stale as soon as the page changes, which is why it is
/// no longer the recommended way to point at anything.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct Target {
    /// Preferred. Playwright-style locator, resolved when the action runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locator: Option<String>,
    /// Legacy `ref` id such as `e3` from the most recent `page_state`.
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
    /// Viewport-relative x in CSS pixels. Must be paired with `y`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    /// Viewport-relative y in CSS pixels. Must be paired with `x`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
}

/// A [`Target`] that named exactly one element.
#[derive(Debug, Clone, PartialEq)]
pub enum Addressed {
    /// Resolve this locator against the live DOM.
    Locator(String),
    /// Look this `ref` up in the tab's last `page_state`.
    Ref(String),
    /// Act at these viewport coordinates.
    Point {
        /// x in CSS pixels.
        x: f64,
        /// y in CSS pixels.
        y: f64,
    },
}

impl Target {
    /// Which single element this names, or why it names none or several.
    pub fn resolve(&self) -> Result<Addressed, BrowserError> {
        let has_point = self.x.is_some() || self.y.is_some();
        if self.x.is_some() != self.y.is_some() {
            return Err(BrowserError::BadRequest(
                "x and y have to be given together".into(),
            ));
        }
        let modes = usize::from(self.locator.is_some())
            + usize::from(self.r#ref.is_some())
            + usize::from(has_point);
        match modes {
            0 => Err(BrowserError::BadRequest(
                "name the element with locator (preferred), ref, or x and y".into(),
            )),
            1 => {
                if let Some(locator) = &self.locator {
                    let trimmed = locator.trim();
                    if trimmed.is_empty() {
                        return Err(BrowserError::InvalidSelector {
                            locator: locator.clone(),
                            reason: "the locator is empty".into(),
                        });
                    }
                    if trimmed.chars().count() > MAX_LOCATOR_CHARS {
                        return Err(BrowserError::InvalidSelector {
                            locator: trimmed.chars().take(80).collect(),
                            reason: format!(
                                "the locator is over the {MAX_LOCATOR_CHARS} character limit"
                            ),
                        });
                    }
                    return Ok(Addressed::Locator(trimmed.to_owned()));
                }
                if let Some(reference) = &self.r#ref {
                    let reference = reference.trim();
                    if reference.is_empty() || reference.chars().count() > MAX_REF_CHARS {
                        return Err(BrowserError::BadRequest(format!(
                            "ref must be between 1 and {MAX_REF_CHARS} characters"
                        )));
                    }
                    return Ok(Addressed::Ref(reference.to_owned()));
                }
                let x = self.x.unwrap_or_default();
                let y = self.y.unwrap_or_default();
                if !x.is_finite() || !y.is_finite() {
                    return Err(BrowserError::BadRequest(
                        "x and y must be finite numbers".into(),
                    ));
                }
                Ok(Addressed::Point { x, y })
            }
            _ => Err(BrowserError::BadRequest(
                "give only one of locator, ref, or x and y".into(),
            )),
        }
    }

    /// A locator-only target, for callers that already have one.
    pub fn locator(locator: impl Into<String>) -> Self {
        Self {
            locator: Some(locator.into()),
            ..Self::default()
        }
    }
}

/// Click a target.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ClickParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// Which element to click.
    #[serde(flatten)]
    pub target: Target,
}

/// Type into a field.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct TypeParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// Which field to type into.
    #[serde(flatten)]
    pub target: Target,
    /// Text to insert.
    pub text: String,
    /// Replace the field's current value instead of appending (default true).
    pub clear: Option<bool>,
    /// Press Enter afterwards.
    #[serde(default)]
    pub submit: bool,
}

/// Press one key.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct PressParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// Focus this element first; omit to press against whatever has focus.
    #[serde(flatten)]
    pub target: Target,
    /// Key name: `Enter`, `Escape`, `Tab`, `ArrowDown`, `Backspace`, `a`, ...
    pub key: String,
    /// Held modifiers: any of `Meta`, `Control`, `Alt`, `Shift`.
    #[serde(default)]
    pub modifiers: Vec<String>,
}

/// Scroll the page or a container.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ScrollParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// Scroll inside this container; omit to scroll the page.
    #[serde(flatten)]
    pub target: Target,
    /// Positive scrolls right.
    #[serde(default)]
    pub delta_x: f64,
    /// Positive scrolls down.
    #[serde(default)]
    pub delta_y: f64,
}

/// Wait until the page satisfies every condition given.
#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct WaitForParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// Wait for at least one element to match this locator.
    pub locator: Option<String>,
    /// Wait for this text to appear in the page's visible text.
    pub text: Option<String>,
    /// Wait for the URL to contain this substring.
    pub url_includes: Option<String>,
    /// Wait for loading to finish.
    #[serde(default)]
    pub load: bool,
    /// Give up after this long. Default 15000, maximum 60000.
    pub timeout_ms: Option<u64>,
}

/// Resize a tab's viewport.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ResizeParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// A device preset id from `page_devices`, such as `iphone-15`.
    pub preset: Option<String>,
    /// Exact viewport width in CSS pixels. Pair with `height`.
    pub width: Option<u32>,
    /// Exact viewport height in CSS pixels. Pair with `width`.
    pub height: Option<u32>,
    /// `portrait` or `landscape`; only with a preset.
    pub orientation: Option<String>,
    /// What surrounds the page on the device: `browser` (the default; the
    /// viewport Safari or Chrome would give, minus their bars), `standalone`
    /// (an installed web app: status bar and home indicator only, with
    /// safe-area insets), or `none` (the whole screen). Only with a preset.
    pub ui: Option<String>,
    /// Clear emulation and go back to filling the window.
    #[serde(default)]
    pub reset: bool,
}

/// Emulate media preferences.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct AppearanceParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// `light`, `dark`, or `system` to clear the override.
    pub color_scheme: Option<String>,
    /// `reduce`, `no-preference`, or `system` to clear the override.
    pub reduced_motion: Option<String>,
    /// `screen`, `print`, or `system` to clear the override.
    pub media_type: Option<String>,
    /// `standalone`, `browser`, `fullscreen`, `minimal-ui`, or `system` to clear.
    pub display_mode: Option<String>,
}

/// Throttle a tab's network.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ThrottleParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// `offline`, `slow-3g`, `fast-3g`, or `none` to clear throttling.
    pub profile: String,
}

/// Describe what a locator matches.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct LocateParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// The locator to describe.
    pub locator: String,
}

/// Ask what rendered an element.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct ComponentParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// Which element to look up.
    #[serde(flatten)]
    pub target: Target,
}

/// Tab plus a row limit.
#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct TailParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// Maximum rows, newest kept (default 50).
    pub limit: Option<u32>,
}

/// One request's body.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct BodyParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// Request id from `network_list`.
    pub request_id: String,
}

/// Replace the rules.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct RulesParams {
    /// Full rule list. Each rule: {id, pattern (URL glob with *), enabled, action}
    /// where action is `{kind:"block"}`, `{kind:"mock", status, content_type, body}`
    /// or `{kind:"header", name, value}`.
    pub rules: Vec<serde_json::Value>,
}

/// Evaluate JavaScript.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct EvaluateParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// Expression; its JSON-serializable result is returned.
    pub expression: String,
}
