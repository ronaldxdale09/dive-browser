//! Console capture: maps CDP `Runtime`/`Log` events into one entry type the
//! dock renders. Pure mapping lives here so it can be unit-tested.

use dive_cdp::{CdpEvent, CdpSession};
use dive_core::TabId;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;

use crate::Runtime;

const MAX_TEXT: usize = 16 * 1024;
const MAX_URL: usize = 8 * 1024;

/// Severity of a console entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    /// `console.debug`, verbose logs.
    Debug,
    /// `console.log` / `console.info`.
    Info,
    /// `console.warn`.
    Warn,
    /// `console.error`, uncaught exceptions, failed loads.
    Error,
}

/// One line in the console panel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, Event)]
pub struct ConsoleEntry {
    /// Tab that produced it.
    pub tab_id: TabId,
    /// Severity.
    pub level: Level,
    /// Rendered text (arguments joined by spaces, objects as JSON).
    pub text: String,
    /// Origin: `console`, `exception`, `network`, `security`, ...
    pub source: String,
    /// Script URL, when known.
    pub url: Option<String>,
    /// 1-based line, when known.
    pub line: Option<u32>,
    /// Milliseconds since the epoch.
    pub timestamp: f64,
    /// 1-based column, when known.
    pub column: Option<u32>,
}

/// Enable the domains and forward every entry to the chrome.
pub fn attach(
    app: AppHandle<Runtime>,
    tab_id: TabId,
    session: CdpSession,
) -> crate::cdp_feed::Ready {
    crate::cdp_feed::attach(
        app,
        tab_id,
        session,
        &["Runtime.enable", "Log.enable"],
        map_event,
        |state, entry| {
            state.buffers.push_console(entry.clone());
        },
    )
}

/// Translate a CDP event into an entry, if it is console-worthy.
pub fn map_event(tab_id: TabId, event: &CdpEvent) -> Option<ConsoleEntry> {
    let p = &event.params;
    match event.method.as_str() {
        "Runtime.consoleAPICalled" => {
            let level = match p["type"].as_str().unwrap_or("log") {
                "debug" | "trace" => Level::Debug,
                "warning" => Level::Warn,
                "error" | "assert" => Level::Error,
                _ => Level::Info,
            };
            let text = p["args"]
                .as_array()
                .map(|args| {
                    args.iter()
                        .map(remote_object_text)
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            let frame = p["stackTrace"]["callFrames"].get(0);
            Some(ConsoleEntry {
                tab_id,
                level,
                text: capped(&text, MAX_TEXT),
                source: "console".into(),
                url: frame
                    .and_then(|f| f["url"].as_str())
                    .filter(|u| !u.is_empty())
                    .map(|url| capped(url, MAX_URL)),
                line: frame
                    .and_then(|f| f["lineNumber"].as_u64())
                    .map(|n| u32::try_from(n + 1).unwrap_or(u32::MAX)),
                timestamp: p["timestamp"].as_f64().unwrap_or_default(),
                column: None,
            })
        }
        "Runtime.exceptionThrown" => {
            let d = &p["exceptionDetails"];
            let text = d["exception"]["description"]
                .as_str()
                .or_else(|| d["text"].as_str())
                .unwrap_or("Uncaught exception")
                .to_owned();
            Some(ConsoleEntry {
                tab_id,
                level: Level::Error,
                text: capped(&text, MAX_TEXT),
                source: "exception".into(),
                url: d["url"].as_str().map(|url| capped(url, MAX_URL)),
                line: d["lineNumber"]
                    .as_u64()
                    .map(|n| u32::try_from(n + 1).unwrap_or(u32::MAX)),
                timestamp: p["timestamp"].as_f64().unwrap_or_default(),
                column: None,
            })
        }
        "Log.entryAdded" => {
            let e = &p["entry"];
            let level = match e["level"].as_str().unwrap_or("info") {
                "verbose" => Level::Debug,
                "warning" => Level::Warn,
                "error" => Level::Error,
                _ => Level::Info,
            };
            Some(ConsoleEntry {
                tab_id,
                level,
                text: capped(e["text"].as_str().unwrap_or_default(), MAX_TEXT),
                source: e["source"].as_str().unwrap_or("log").to_owned(),
                url: e["url"].as_str().map(|url| capped(url, MAX_URL)),
                line: e["lineNumber"]
                    .as_u64()
                    .map(|n| u32::try_from(n + 1).unwrap_or(u32::MAX)),
                timestamp: e["timestamp"].as_f64().unwrap_or_default(),
                column: None,
            })
        }
        _ => None,
    }
}

fn capped(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        value.to_owned()
    } else {
        let mut out: String = value.chars().take(max).collect();
        out.push('…');
        out
    }
}

/// Human text for a CDP `RemoteObject`.
fn remote_object_text(obj: &Value) -> String {
    if let Some(v) = obj.get("value") {
        return match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
    }
    if let Some(s) = obj["unserializableValue"].as_str() {
        return s.to_owned();
    }
    obj["description"]
        .as_str()
        .or_else(|| obj["type"].as_str())
        .unwrap_or("undefined")
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(method: &str, params: Value) -> CdpEvent {
        CdpEvent {
            method: method.into(),
            params,
        }
    }

    #[test]
    fn maps_console_api_calls() {
        let e = ev(
            "Runtime.consoleAPICalled",
            json!({"type": "warning", "timestamp": 12.5,
                   "args": [{"type":"string","value":"count:"}, {"type":"number","value":3}, {"type":"object","description":"Object"}],
                   "stackTrace": {"callFrames": [{"url": "http://x/app.js", "lineNumber": 9}]}}),
        );
        let entry = map_event(TabId::new(), &e).unwrap();
        assert_eq!(entry.level, Level::Warn);
        assert_eq!(entry.text, "count: 3 Object");
        assert_eq!(entry.url.as_deref(), Some("http://x/app.js"));
        assert_eq!(entry.line, Some(10));
    }

    #[test]
    fn maps_exceptions_and_log_entries() {
        let ex = ev(
            "Runtime.exceptionThrown",
            json!({"timestamp": 1.0, "exceptionDetails": {"text": "Uncaught", "url": "http://x/a.js", "lineNumber": 0,
                   "exception": {"description": "TypeError: x is not a function\n    at a.js:1"}}}),
        );
        let entry = map_event(TabId::new(), &ex).unwrap();
        assert_eq!(entry.level, Level::Error);
        assert!(entry.text.starts_with("TypeError"));
        assert_eq!(entry.source, "exception");

        let log = ev(
            "Log.entryAdded",
            json!({"entry": {"level": "error", "source": "network", "text": "404", "url": "http://x/m.png", "timestamp": 2.0}}),
        );
        let entry = map_event(TabId::new(), &log).unwrap();
        assert_eq!(
            (entry.level, entry.source.as_str()),
            (Level::Error, "network")
        );
        assert!(map_event(TabId::new(), &ev("Page.loadEventFired", json!({}))).is_none());
    }

    #[test]
    fn retained_console_text_is_bounded() {
        let event = ev(
            "Log.entryAdded",
            json!({"entry": {"text": "x".repeat(MAX_TEXT + 10), "url": "u".repeat(MAX_URL + 10)}}),
        );
        let entry = map_event(TabId::new(), &event).unwrap();
        assert_eq!(entry.text.chars().count(), MAX_TEXT + 1);
        assert_eq!(entry.url.unwrap().chars().count(), MAX_URL + 1);
    }
}
