//! Minimal Anthropic Messages API client used by the agent sidecar.
//!
//! Raw HTTPS on purpose: there is no official Rust SDK, and the sidecar only
//! needs streaming text with a system prompt and prior turns. Defaults follow
//! the current API: Claude Opus 5, adaptive thinking, server-side refusal
//! fallbacks.

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

/// One conversation turn (text only for now).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Turn {
    /// Speaker.
    pub role: Role,
    /// Text content.
    pub content: String,
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
    /// Output cap.
    pub max_tokens: u32,
    /// `low` | `medium` | `high` | `xhigh` | `max`.
    pub effort: &'static str,
}

impl Request {
    /// A request with the defaults the sidecar uses.
    pub fn new(system: impl Into<String>, turns: Vec<Turn>) -> Self {
        Self {
            model: DEFAULT_MODEL.into(),
            system: system.into(),
            turns,
            max_tokens: 16_000,
            effort: "medium",
        }
    }

    /// JSON body for `POST /v1/messages`.
    pub fn body(&self) -> Value {
        json!({
            "model": self.model,
            "max_tokens": self.max_tokens,
            "stream": true,
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": self.effort},
            "fallbacks": "default",
            "system": [{"type": "text", "text": self.system, "cache_control": {"type": "ephemeral"}}],
            "messages": self.turns.iter().map(|t| json!({"role": t.role, "content": t.content})).collect::<Vec<_>>(),
        })
    }
}

/// Streamed pieces of a reply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum Delta {
    /// More answer text.
    Text(String),
    /// Reply finished; carries the stop reason (`end_turn`, `max_tokens`, `refusal`, ...).
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

/// Turn one SSE event into a delta, if it carries something the UI shows.
pub fn parse_event(event_name: &str, data: &str) -> Option<Delta> {
    let v: Value = serde_json::from_str(data).ok()?;
    match event_name {
        "content_block_delta" => {
            let d = &v["delta"];
            (d["type"] == "text_delta")
                .then(|| Delta::Text(d["text"].as_str().unwrap_or_default().to_owned()))
        }
        "message_delta" => v["delta"]["stop_reason"]
            .as_str()
            .map(|s| Delta::Done(s.to_owned())),
        "error" => Some(Delta::Error(
            v["error"]["message"]
                .as_str()
                .unwrap_or("unknown error")
                .to_owned(),
        )),
        _ => None,
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
        Self {
            http: reqwest::Client::new(),
            api_key: api_key.into(),
            url: API_URL.into(),
        }
    }

    /// Point at a different endpoint (tests, proxies).
    #[must_use]
    pub fn with_url(mut self, url: impl Into<String>) -> Self {
        self.url = url.into();
        self
    }

    /// Send a request and stream deltas until the reply ends.
    pub async fn stream(
        &self,
        request: &Request,
    ) -> Result<impl Stream<Item = Delta> + use<>, AgentError> {
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
            return Err(AgentError::Api {
                status: status.as_u16(),
                message,
            });
        }
        let events = response.bytes_stream().eventsource();
        Ok(events.filter_map(|item| async move {
            match item {
                Ok(ev) => parse_event(&ev.event, &ev.data),
                Err(e) => Some(Delta::Error(e.to_string())),
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_has_current_api_shape() {
        let r = Request::new(
            "be brief",
            vec![Turn {
                role: Role::User,
                content: "hi".into(),
            }],
        );
        let b = r.body();
        assert_eq!(b["model"], DEFAULT_MODEL);
        assert_eq!(b["thinking"]["type"], "adaptive");
        assert_eq!(b["fallbacks"], "default");
        assert_eq!(b["stream"], true);
        assert!(b.get("temperature").is_none());
        assert_eq!(b["system"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(b["messages"][0]["role"], "user");
    }

    #[test]
    fn parses_stream_events() {
        assert_eq!(
            parse_event(
                "content_block_delta",
                r#"{"delta":{"type":"text_delta","text":"Hel"}}"#
            ),
            Some(Delta::Text("Hel".into()))
        );
        assert_eq!(
            parse_event(
                "content_block_delta",
                r#"{"delta":{"type":"thinking_delta","thinking":"..."}}"#
            ),
            None
        );
        assert_eq!(
            parse_event("message_delta", r#"{"delta":{"stop_reason":"end_turn"}}"#),
            Some(Delta::Done("end_turn".into()))
        );
        assert_eq!(
            parse_event(
                "error",
                r#"{"error":{"type":"overloaded_error","message":"busy"}}"#
            ),
            Some(Delta::Error("busy".into()))
        );
        assert_eq!(parse_event("ping", "{}"), None);
        assert_eq!(parse_event("message_delta", "not json"), None);
    }

    #[tokio::test]
    async fn empty_key_is_rejected_before_any_request() {
        let client = Client::new("  ");
        let err = client
            .stream(&Request::new("s", vec![]))
            .await
            .err()
            .unwrap();
        assert!(matches!(err, AgentError::MissingKey));
    }
}
