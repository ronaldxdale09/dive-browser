//! Minimal Anthropic Messages API client used by the agent sidecar.
//!
//! Raw HTTPS on purpose: there is no official Rust SDK, and the sidecar only
//! needs streaming text and tool calls with a system prompt and prior turns.
//! Defaults follow the current API: Claude Opus 5, adaptive thinking,
//! server-side refusal fallbacks.

use eventsource_stream::Eventsource;
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Default model.
pub const DEFAULT_MODEL: &str = "claude-opus-5";
const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";
const BETAS: &str = "server-side-fallback-2026-07-01";

/// Who said a turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// The person.
    User,
    /// The model.
    Assistant,
}

/// One conversation turn. `content` is either a string or an array of
/// content blocks (text, `tool_use`, `tool_result`) in API shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Turn {
    /// Speaker.
    pub role: Role,
    /// Content in Messages API shape.
    pub content: Value,
}

impl Turn {
    /// A plain text turn.
    pub fn text(role: Role, text: impl Into<String>) -> Self {
        Self { role, content: Value::String(text.into()) }
    }

    /// The assistant turn that requested tools (text plus `tool_use` blocks).
    pub fn assistant_blocks(blocks: Vec<Value>) -> Self {
        Self { role: Role::Assistant, content: Value::Array(blocks) }
    }

    /// The user turn carrying every `tool_result` for the previous assistant turn.
    pub fn tool_results(results: Vec<ToolResult>) -> Self {
        let blocks = results
            .into_iter()
            .map(|r| {
                let mut b = json!({"type": "tool_result", "tool_use_id": r.tool_use_id, "content": r.content});
                if r.is_error {
                    b["is_error"] = json!(true);
                }
                b
            })
            .collect();
        Self { role: Role::User, content: Value::Array(blocks) }
    }
}

/// Outcome of running one tool call.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    /// Id from the matching `ToolUse`.
    pub tool_use_id: String,
    /// Result content: a string, or an array of content blocks (e.g. an image).
    pub content: Value,
    /// Whether the tool failed.
    pub is_error: bool,
}

/// A tool the model may call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    /// Tool name.
    pub name: String,
    /// What it does and when to use it.
    pub description: String,
    /// JSON schema of the input object.
    pub input_schema: Value,
}

/// A chat request.
#[derive(Debug, Clone)]
pub struct Request {
    /// Model id.
    pub model: String,
    /// System prompt (stable prefix; cached).
    pub system: String,
    /// Prior turns plus the new user turn, oldest first.
    pub turns: Vec<Turn>,
    /// Tools offered to the model.
    pub tools: Vec<ToolSpec>,
    /// Output cap.
    pub max_tokens: u32,
    /// `low` | `medium` | `high` | `xhigh` | `max`.
    pub effort: &'static str,
}

impl Request {
    /// A request with the defaults the sidecar uses.
    pub fn new(system: impl Into<String>, turns: Vec<Turn>) -> Self {
        Self { model: DEFAULT_MODEL.into(), system: system.into(), turns, tools: Vec::new(), max_tokens: 16_000, effort: "medium" }
    }

    /// JSON body for `POST /v1/messages`.
    pub fn body(&self) -> Value {
        let mut body = json!({
            "model": self.model,
            "max_tokens": self.max_tokens,
            "stream": true,
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": self.effort},
            "fallbacks": "default",
            "system": [{"type": "text", "text": self.system, "cache_control": {"type": "ephemeral"}}],
            "messages": self.turns.iter().map(|t| json!({"role": t.role, "content": t.content})).collect::<Vec<_>>(),
        });
        if !self.tools.is_empty() {
            body["tools"] = serde_json::to_value(&self.tools).unwrap_or(Value::Null);
        }
        body
    }
}

/// A tool call the model made.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolUse {
    /// Id to echo back in the `tool_result`.
    pub id: String,
    /// Tool name.
    pub name: String,
    /// Parsed input.
    pub input: Value,
}

/// Streamed pieces of a reply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum Delta {
    /// More answer text.
    Text(String),
    /// The model called a tool; the caller runs it and continues the loop.
    ToolUse(ToolUse),
    /// Reply finished; carries the stop reason (`end_turn`, `tool_use`, `max_tokens`, `refusal`, ...).
    Done(String),
    /// The API reported an error.
    Error(String),
}

/// Failures before the stream starts.
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    /// No API key configured.
    #[error("no API key configured")]
    MissingKey,
    /// HTTP-level failure.
    #[error("request failed: {0}")]
    Http(String),
    /// Non-2xx response.
    #[error("api {status}: {message}")]
    Api {
        /// HTTP status.
        status: u16,
        /// Error body.
        message: String,
    },
}

/// Accumulates one streamed tool-use block until it is complete.
#[derive(Debug, Default)]
pub struct StreamState {
    pending: Option<(usize, String, String, String)>, // (index, id, name, partial json)
}

impl StreamState {
    /// Turn one SSE event into a delta, if it carries something the caller acts on.
    pub fn parse_event(&mut self, event_name: &str, data: &str) -> Option<Delta> {
        let v: Value = serde_json::from_str(data).ok()?;
        match event_name {
            "content_block_start" => {
                let block = &v["content_block"];
                if block["type"] == "tool_use" {
                    let index = usize::try_from(v["index"].as_u64().unwrap_or(0)).unwrap_or(0);
                    self.pending = Some((
                        index,
                        block["id"].as_str().unwrap_or_default().to_owned(),
                        block["name"].as_str().unwrap_or_default().to_owned(),
                        String::new(),
                    ));
                }
                None
            }
            "content_block_delta" => {
                let d = &v["delta"];
                match d["type"].as_str() {
                    Some("text_delta") => Some(Delta::Text(d["text"].as_str().unwrap_or_default().to_owned())),
                    Some("input_json_delta") => {
                        if let Some(p) = &mut self.pending {
                            p.3.push_str(d["partial_json"].as_str().unwrap_or_default());
                        }
                        None
                    }
                    _ => None,
                }
            }
            "content_block_stop" => {
                let index = usize::try_from(v["index"].as_u64().unwrap_or(0)).unwrap_or(0);
                match self.pending.take() {
                    Some((i, id, name, raw)) if i == index => {
                        let input = if raw.trim().is_empty() { json!({}) } else { serde_json::from_str(&raw).unwrap_or(json!({})) };
                        Some(Delta::ToolUse(ToolUse { id, name, input }))
                    }
                    other => {
                        self.pending = other;
                        None
                    }
                }
            }
            "message_delta" => v["delta"]["stop_reason"].as_str().map(|s| Delta::Done(s.to_owned())),
            "error" => Some(Delta::Error(v["error"]["message"].as_str().unwrap_or("unknown error").to_owned())),
            _ => None,
        }
    }
}

/// Anthropic API client.
#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    api_key: String,
    url: String,
}

impl Client {
    /// Build a client for the given key.
    pub fn new(api_key: impl Into<String>) -> Self {
        Self { http: reqwest::Client::new(), api_key: api_key.into(), url: API_URL.into() }
    }

    /// Point at a different endpoint (tests, proxies).
    #[must_use]
    pub fn with_url(mut self, url: impl Into<String>) -> Self {
        self.url = url.into();
        self
    }

    /// Send a request and stream deltas until the reply ends.
    pub async fn stream(&self, request: &Request) -> Result<impl Stream<Item = Delta> + use<>, AgentError> {
        if self.api_key.trim().is_empty() {
            return Err(AgentError::MissingKey);
        }
        let response = self
            .http
            .post(&self.url)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", API_VERSION)
            .header("anthropic-beta", BETAS)
            .header("content-type", "application/json")
            .json(&request.body())
            .send()
            .await
            .map_err(|e| AgentError::Http(e.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            let message = response.text().await.unwrap_or_default();
            return Err(AgentError::Api { status: status.as_u16(), message });
        }
        let events = response.bytes_stream().eventsource();
        let state = std::sync::Arc::new(std::sync::Mutex::new(StreamState::default()));
        Ok(events.filter_map(move |item| {
            let state = std::sync::Arc::clone(&state);
            async move {
                match item {
                    Ok(ev) => state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).parse_event(&ev.event, &ev.data),
                    Err(e) => Some(Delta::Error(e.to_string())),
                }
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_has_current_api_shape() {
        let mut r = Request::new("be brief", vec![Turn::text(Role::User, "hi")]);
        let b = r.body();
        assert_eq!(b["model"], DEFAULT_MODEL);
        assert_eq!(b["thinking"]["type"], "adaptive");
        assert_eq!(b["fallbacks"], "default");
        assert_eq!(b["stream"], true);
        assert!(b.get("temperature").is_none());
        assert!(b.get("tools").is_none());
        assert_eq!(b["system"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(b["messages"][0]["role"], "user");
        r.tools.push(ToolSpec { name: "t".into(), description: "d".into(), input_schema: json!({"type": "object"}) });
        assert_eq!(r.body()["tools"][0]["name"], "t");
    }

    #[test]
    fn parses_text_and_tool_use_stream() {
        let mut st = StreamState::default();
        assert_eq!(st.parse_event("content_block_delta", r#"{"delta":{"type":"text_delta","text":"Hel"}}"#), Some(Delta::Text("Hel".into())));
        assert_eq!(st.parse_event("content_block_delta", r#"{"delta":{"type":"thinking_delta","thinking":"..."}}"#), None);
        assert_eq!(st.parse_event("content_block_start", r#"{"index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"page_click","input":{}}}"#), None);
        assert_eq!(st.parse_event("content_block_delta", r#"{"index":1,"delta":{"type":"input_json_delta","partial_json":"{\"ref\":"}}"#), None);
        assert_eq!(st.parse_event("content_block_delta", r#"{"index":1,"delta":{"type":"input_json_delta","partial_json":"\"e2\"}"}}"#), None);
        let done = st.parse_event("content_block_stop", r#"{"index":1}"#);
        assert_eq!(done, Some(Delta::ToolUse(ToolUse { id: "tu_1".into(), name: "page_click".into(), input: json!({"ref": "e2"}) })));
        assert_eq!(st.parse_event("message_delta", r#"{"delta":{"stop_reason":"tool_use"}}"#), Some(Delta::Done("tool_use".into())));
        assert_eq!(st.parse_event("error", r#"{"error":{"type":"overloaded_error","message":"busy"}}"#), Some(Delta::Error("busy".into())));
        assert_eq!(st.parse_event("ping", "{}"), None);
    }

    #[test]
    fn tool_result_turn_shape() {
        let t = Turn::tool_results(vec![ToolResult { tool_use_id: "tu_1".into(), content: json!("ok"), is_error: false }, ToolResult { tool_use_id: "tu_2".into(), content: json!("boom"), is_error: true }]);
        assert_eq!(t.role, Role::User);
        assert_eq!(t.content[0]["type"], "tool_result");
        assert_eq!(t.content[1]["is_error"], true);
        assert!(t.content[0].get("is_error").is_none());
    }

    #[tokio::test]
    async fn empty_key_is_rejected_before_any_request() {
        let client = Client::new("  ");
        let err = client.stream(&Request::new("s", vec![])).await.err().unwrap();
        assert!(matches!(err, AgentError::MissingKey));
    }
}
