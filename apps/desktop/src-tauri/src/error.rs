//! Error type crossing the IPC boundary.

use serde::Serialize;
use specta::Type;

/// What kind of failure, for the chrome to act on without reading the words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ErrorKind {
    /// The thing asked about no longer exists or no longer waits (a closed
    /// dialog, an answered sign-in).
    Gone,
    /// The page was mid-navigation; one retry is reasonable.
    NavigationRace,
    /// A typed value was refused; `field` names which one.
    Invalid {
        /// The input the refusal is about.
        field: String,
    },
}

/// A failure reported to the chrome: a message, and a kind where the chrome
/// has to act on what happened rather than show it.
#[derive(Debug, Clone, Serialize, Type, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    /// Human-readable description.
    pub message: String,
    /// `None` for most errors; set where the chrome needs to act on the kind.
    /// (Not skipped when empty: `skip_serializing_if` makes specta emit a
    /// separate `AppError_Serialize` and rewrites every command signature.)
    pub kind: Option<ErrorKind>,
}

impl AppError {
    /// Build from anything displayable.
    pub fn new(message: impl std::fmt::Display) -> Self {
        Self {
            message: message.to_string(),
            kind: None,
        }
    }

    /// The thing asked about no longer exists or no longer waits.
    pub fn gone(message: impl std::fmt::Display) -> Self {
        Self {
            kind: Some(ErrorKind::Gone),
            ..Self::new(message)
        }
    }

    /// The value typed into `field` was refused.
    pub fn invalid(field: &str, message: impl std::fmt::Display) -> Self {
        Self {
            kind: Some(ErrorKind::Invalid {
                field: field.to_owned(),
            }),
            ..Self::new(message)
        }
    }

    /// The page was replaced mid-call; trying once more is reasonable.
    pub fn navigation_race(message: impl std::fmt::Display) -> Self {
        Self {
            kind: Some(ErrorKind::NavigationRace),
            ..Self::new(message)
        }
    }
}

macro_rules! from_display {
    ($($t:ty),*) => {$(
        impl From<$t> for AppError {
            fn from(e: $t) -> Self { Self::new(e) }
        }
    )*};
}

from_display!(
    dive_core::CoreError,
    tauri::Error,
    url::ParseError,
    std::io::Error
);

/// A CDP failure keeps its words; one that is only the page being replaced (or
/// the tab going away) while the call was in flight also says so in its kind,
/// so the chrome retries instead of reporting it.
impl From<dive_cdp::CdpError> for AppError {
    fn from(e: dive_cdp::CdpError) -> Self {
        if e.is_navigation_race() || e.is_gone() {
            Self::navigation_race(e)
        } else {
            Self::new(e)
        }
    }
}

/// An `anyhow` chain prints whole (`outer: inner`): plain `Display` shows only
/// the outermost layer and drops every `.context()` below it.
impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        Self::new(format!("{e:#}"))
    }
}

/// Result alias for command handlers.
pub type AppResult<T> = std::result::Result<T, AppError>;

/// The JSON a page script handed back through `Runtime.evaluate` as a
/// string, or why there is none.
///
/// The panels that read the page this way used to take anything that was not
/// a string as `"{}"`, so a script that threw -- a page that replaced `JSON`,
/// a CSP that blocked the injection, a context torn down mid-read -- showed
/// an empty report that looked like a clean one.
pub fn page_json(result: &serde_json::Value, what: &str) -> AppResult<serde_json::Value> {
    if let Some(details) = result.get("exceptionDetails") {
        let why = details["exception"]["description"]
            .as_str()
            .or_else(|| details["text"].as_str())
            .unwrap_or("the script threw");
        return Err(AppError::new(format!("Could not read {what}: {why}")));
    }
    let Some(raw) = result["result"]["value"].as_str() else {
        return Err(AppError::new(format!(
            "Could not read {what}: the page returned nothing"
        )));
    };
    serde_json::from_str(raw).map_err(|_| {
        AppError::new(format!(
            "Could not read {what}: the page returned something else"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_anyhow_chain_keeps_every_layer() {
        let error = anyhow::anyhow!("inner").context("outer");
        assert_eq!(AppError::from(error).message, "outer: inner");
    }

    #[test]
    fn a_cdp_failure_from_a_page_that_moved_on_carries_the_race_kind() {
        let raced = dive_cdp::CdpError::Protocol {
            code: -32000,
            message: "Inspected target navigated or closed".into(),
        };
        let words = raced.to_string();
        let converted = AppError::from(raced);
        assert_eq!(converted.kind, Some(ErrorKind::NavigationRace));
        assert_eq!(converted.message, words, "the words do not change");
        assert_eq!(
            AppError::from(dive_cdp::CdpError::Closed).kind,
            Some(ErrorKind::NavigationRace)
        );
        let refused = AppError::from(dive_cdp::CdpError::Protocol {
            code: -32000,
            message: "Not allowed".into(),
        });
        assert_eq!(refused.kind, None);
    }

    #[test]
    fn a_kind_serializes_with_its_type_tag_and_a_plain_error_without_one() {
        let plain = serde_json::to_value(AppError::new("x")).unwrap();
        assert_eq!(plain, json!({"message": "x", "kind": null}));
        let gone = serde_json::to_value(AppError::gone("x")).unwrap();
        assert_eq!(gone["kind"], json!({"type": "gone"}));
        let raced = serde_json::to_value(AppError::navigation_race("x")).unwrap();
        assert_eq!(raced["kind"], json!({"type": "navigation_race"}));
        let invalid = serde_json::to_value(AppError::invalid("month", "x")).unwrap();
        assert_eq!(
            invalid["kind"],
            json!({"type": "invalid", "field": "month"})
        );
        assert_eq!(invalid["message"], "x");
    }

    #[test]
    fn a_page_script_that_failed_is_an_error_not_an_empty_report() {
        let ok = json!({"result": {"type": "string", "value": "{\"a\":1}"}});
        assert_eq!(page_json(&ok, "x").unwrap()["a"], 1);
        let threw = json!({"result": {"type": "object"}, "exceptionDetails": {"text": "Uncaught", "exception": {"description": "TypeError: JSON.stringify is not a function"}}});
        assert!(
            page_json(&threw, "vitals")
                .unwrap_err()
                .message
                .contains("TypeError")
        );
        let nothing = json!({"result": {"type": "undefined"}});
        assert!(page_json(&nothing, "vitals").is_err());
        let garbage = json!({"result": {"type": "string", "value": "not json"}});
        assert!(page_json(&garbage, "vitals").is_err());
    }
}
