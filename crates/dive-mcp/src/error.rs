//! The error a [`Browser`](crate::Browser) reports and its MCP encoding.

use rmcp::model::ErrorData;

/// Errors a browser implementation reports.
///
/// The distinctions are the ones that change what a caller should do next.
/// "Nothing matched that locator" means try a different locator; "the element
/// is there but disabled" means the app is in the wrong state; "the result was
/// too large" means narrow the query. Collapsing all three into one string
/// makes an agent retry the thing that cannot work.
#[derive(Debug, thiserror::Error)]
pub enum BrowserError {
    /// No such tab.
    #[error("tab not found: {0}")]
    TabNotFound(String),
    /// The locator parsed but matched nothing.
    #[error("nothing matches locator {locator:?}; call page_inspect to see what is on the page")]
    TargetNotFound {
        /// The locator as given.
        locator: String,
    },
    /// The locator could not be parsed.
    #[error("locator {locator:?} is not valid: {reason}")]
    InvalidSelector {
        /// The locator as given.
        locator: String,
        /// What the engine objected to.
        reason: String,
    },
    /// Matched, but the element is not rendered.
    #[error("locator {locator:?} matches an element that is not visible")]
    NotVisible {
        /// The locator as given.
        locator: String,
    },
    /// Matched and visible, but disabled.
    #[error("locator {locator:?} matches a disabled element")]
    NotEnabled {
        /// The locator as given.
        locator: String,
    },
    /// Matched, but cannot accept text.
    #[error("locator {locator:?} matches an element that cannot accept text")]
    NotEditable {
        /// The locator as given.
        locator: String,
    },
    /// A coordinate click landed outside the page.
    #[error("({x}, {y}) is outside the {width}x{height} viewport")]
    OutsideViewport {
        /// Requested x in CSS pixels.
        x: f64,
        /// Requested y in CSS pixels.
        y: f64,
        /// Viewport width in CSS pixels.
        width: f64,
        /// Viewport height in CSS pixels.
        height: f64,
    },
    /// A wait ran out before its conditions held.
    #[error("{operation} timed out after {timeout_ms}ms: {detail}")]
    Timeout {
        /// Which operation gave up.
        operation: String,
        /// The budget it was given.
        timeout_ms: u64,
        /// Which conditions were still unmet.
        detail: String,
    },
    /// The result would not fit in a tool response.
    #[error("the result is {bytes} bytes, over the {max} byte limit; narrow the query")]
    ResultTooLarge {
        /// Size of the result that was refused.
        bytes: usize,
        /// The cap.
        max: usize,
    },
    /// The operation exists but is turned off or unavailable here.
    #[error("{operation} is not available: {reason}")]
    NotAllowed {
        /// Which operation was refused.
        operation: String,
        /// Why.
        reason: String,
    },
    /// The arguments do not make sense together.
    #[error("{0}")]
    BadRequest(String),
    /// Anything else.
    #[error("{0}")]
    Other(String),
}

impl BrowserError {
    /// Stable machine-readable tag, sent alongside the message so a caller
    /// can branch without parsing English.
    pub fn code(&self) -> &'static str {
        match self {
            Self::TabNotFound(_) => "tab_not_found",
            Self::TargetNotFound { .. } => "target_not_found",
            Self::InvalidSelector { .. } => "invalid_selector",
            Self::NotVisible { .. } => "not_visible",
            Self::NotEnabled { .. } => "not_enabled",
            Self::NotEditable { .. } => "not_editable",
            Self::OutsideViewport { .. } => "outside_viewport",
            Self::Timeout { .. } => "timeout",
            Self::ResultTooLarge { .. } => "result_too_large",
            Self::NotAllowed { .. } => "not_allowed",
            Self::BadRequest(_) => "bad_request",
            Self::Other(_) => "error",
        }
    }

    /// Whether trying the same call again could plausibly succeed. A disabled
    /// button may become enabled; an unparseable locator will not fix itself.
    pub fn retryable(&self) -> bool {
        matches!(
            self,
            Self::TargetNotFound { .. }
                | Self::NotVisible { .. }
                | Self::NotEnabled { .. }
                | Self::Timeout { .. }
        )
    }

    /// The locator this failure is about, when it is about one.
    pub fn locator(&self) -> Option<&str> {
        match self {
            Self::TargetNotFound { locator }
            | Self::InvalidSelector { locator, .. }
            | Self::NotVisible { locator }
            | Self::NotEnabled { locator }
            | Self::NotEditable { locator } => Some(locator),
            _ => None,
        }
    }
}

impl From<BrowserError> for ErrorData {
    fn from(e: BrowserError) -> Self {
        // The tag and the retry hint travel in `data` so a caller can decide
        // what to do next without matching on the prose.
        let mut data = serde_json::json!({ "code": e.code(), "retryable": e.retryable() });
        if let Some(locator) = e.locator() {
            data["locator"] = serde_json::Value::String(locator.to_owned());
        }
        let message = e.to_string();
        let data = Some(data);
        match e {
            BrowserError::Other(_) => ErrorData::internal_error(message, data),
            BrowserError::Timeout { .. } | BrowserError::NotAllowed { .. } => {
                ErrorData::invalid_request(message, data)
            }
            _ => ErrorData::invalid_params(message, data),
        }
    }
}
