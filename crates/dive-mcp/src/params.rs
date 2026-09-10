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

/// Move through a tab's history, or reload it.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct HistoryParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// `back`, `forward` or `reload`.
    pub action: String,
}

/// Choose an option in a `<select>`.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct SelectParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// Which select element.
    #[serde(flatten)]
    pub target: Target,
    /// The option's `value` attribute.
    pub value: Option<String>,
    /// The option's visible text, matched whole and case-insensitively when `value` is not given.
    pub label: Option<String>,
}

/// One field of a form, and what to put in it.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct FormField {
    /// Which control. A locator, as everywhere else.
    pub locator: String,
    /// What to put in it: the text for a field, the option's value or visible
    /// label for a `<select>`, and "true"/"false" for a checkbox or radio.
    pub value: String,
}

/// Fill a whole form in one call.
#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct FillFormParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// The fields, filled in the order given.
    pub fields: Vec<FormField>,
    /// Press Enter in the last field when every field is filled.
    pub submit: Option<bool>,
}

/// Attach files to a file input.
#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct UploadParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// The `<input type="file">`, as a locator.
    pub locator: Option<String>,
    /// Absolute paths of the files to attach. An empty list clears the input.
    pub paths: Vec<String>,
}

/// Drag one element onto another.
#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct DragParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// What to pick up, as a locator.
    pub from: Option<String>,
    /// Where to drop it, as a locator.
    pub to: Option<String>,
}

/// A value a field is expected to hold.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ValueCheck {
    /// Which field.
    pub locator: String,
    /// What it should hold, matched exactly.
    pub equals: String,
}

/// How many elements a locator is expected to match.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct CountCheck {
    /// Which elements.
    pub locator: String,
    /// Exactly this many.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub equals: Option<u32>,
    /// At least this many.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at_least: Option<u32>,
    /// At most this many.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at_most: Option<u32>,
}

/// One thing that should be true of the page. Give exactly one field.
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct ExpectCheck {
    /// This locator matches something a person can see.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<String>,
    /// This locator matches nothing visible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<String>,
    /// The page shows this text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The page does not show this text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_text: Option<String>,
    /// A field holds a value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<ValueCheck>,
    /// A locator matches a number of elements.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<CountCheck>,
    /// The address contains this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url_includes: Option<String>,
    /// The title contains this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_includes: Option<String>,
}

/// Check several things about the page at once.
#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct ExpectParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// The things that should be true. All of them are reported, not just
    /// the first that is not.
    pub checks: Vec<ExpectCheck>,
    /// Keep re-checking for up to this long before giving up. Omit for a
    /// single look at the page as it is right now.
    pub timeout_ms: Option<u64>,
}

/// What one step of a pointer gesture does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum MouseAction {
    /// Move the pointer, dragging if a button is held.
    Move,
    /// Press and hold a button where the pointer is.
    Down,
    /// Release a held button.
    Up,
    /// A press and release in place.
    Click,
    /// Turn the wheel.
    Wheel,
}

/// One step of a pointer gesture.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct MouseStep {
    /// What this step does.
    pub action: MouseAction,
    /// Viewport x in CSS pixels. Required for the first `move`; otherwise the
    /// pointer stays where the last step left it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    /// Viewport y in CSS pixels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    /// `left`, `right` or `middle`. Left when omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button: Option<String>,
    /// Horizontal wheel movement for a `wheel` step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta_x: Option<f64>,
    /// Vertical wheel movement for a `wheel` step. Positive scrolls down.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta_y: Option<f64>,
    /// Pause after this step, in milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_ms: Option<u64>,
}

/// A pointer gesture, as a sequence of steps.
#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct MouseParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// The steps, played in order.
    pub steps: Vec<MouseStep>,
}

/// One cookie, as the browser holds it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct Cookie {
    /// Name.
    pub name: String,
    /// Value.
    pub value: String,
    /// Host it belongs to. Defaults to the page's own host when setting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    /// Path it is sent for. Defaults to `/`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Expiry as a Unix timestamp in seconds. Absent means a session cookie.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<f64>,
    /// Not readable by page scripts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_only: Option<bool>,
    /// Sent over https only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secure: Option<bool>,
    /// `Strict`, `Lax` or `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub same_site: Option<String>,
}

/// Which kinds of stored state a call applies to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum StorageKind {
    /// Cookies for the page's origin.
    Cookies,
    /// `window.localStorage`.
    Local,
    /// `window.sessionStorage`.
    Session,
}

/// Read the state a site keeps on this machine.
#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct StorageGetParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// Which kinds to read. All three when omitted.
    pub include: Option<Vec<StorageKind>>,
}

/// Write state a site will read back.
#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct StorageSetParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// Cookies to add or replace.
    pub cookies: Option<Vec<Cookie>>,
    /// `localStorage` keys to add or replace.
    pub local: Option<std::collections::BTreeMap<String, String>>,
    /// `sessionStorage` keys to add or replace.
    pub session: Option<std::collections::BTreeMap<String, String>>,
}

/// Throw stored state away.
#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct StorageClearParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// Which kinds to clear. All three when omitted.
    pub clear: Option<Vec<StorageKind>>,
}

/// Answer the JavaScript dialog a page has open.
#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct DialogParams {
    /// Tab id from `tabs_list`; defaults to the active tab.
    pub tab_id: Option<String>,
    /// `true` presses OK (or Leave); `false` presses Cancel (or Stay). Default true.
    pub accept: Option<bool>,
    /// What to enter in a `prompt()`; ignored by the other kinds.
    pub text: Option<String>,
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
