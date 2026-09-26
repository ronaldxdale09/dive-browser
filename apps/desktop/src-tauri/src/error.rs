//! Error type crossing the IPC boundary.

use serde::Serialize;
use specta::Type;

/// A failure reported to the chrome as a plain message.
#[derive(Debug, Clone, Serialize, Type, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    /// Human-readable description.
    pub message: String,
}

impl AppError {
    /// Build from anything displayable.
    pub fn new(message: impl std::fmt::Display) -> Self {
        Self {
            message: message.to_string(),
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
    std::io::Error,
    anyhow::Error
);

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
