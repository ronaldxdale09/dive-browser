//! LLM client for the Dive agent, provider-neutral.
//!
//! Raw HTTPS on purpose: there is no official Rust SDK for any of these, and
//! the agent only needs streaming text, tool calls, a system prompt and prior
//! turns. Two wire protocols cover every provider a person brings a key for --
//! Anthropic's Messages API and the `OpenAI` chat-completions shape -- and each
//! lives in its own module. The transcript is kept in one internal shape
//! (Anthropic-style content blocks) and translated at the edge, so the agent
//! loop never learns which wire it is on.

pub mod anthropic;
pub mod openai;
pub mod providers;

use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;

pub use providers::{Provider, ProviderInfo, Wire, catalog};

const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const RESPONSE_HEADER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const ERROR_BODY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const JSON_BODY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const MAX_ERROR_BODY: usize = 64 * 1024;
const MAX_JSON_BODY: usize = 8 * 1024 * 1024;
const MAX_STREAM_BYTES: usize = 32 * 1024 * 1024;

/// Default model, for the default provider.
pub const DEFAULT_MODEL: &str = "claude-opus-5";

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
/// content blocks (text, `thinking`, `tool_use`, `tool_result`) in Anthropic
/// Messages shape; the `OpenAI` wire translates on the way out.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Turn {
    /// Speaker.
    pub role: Role,
    /// Content in Messages API shape.
    pub content: Value,
    /// Provider-specific state that has to travel with the turn when it is
    /// replayed -- `OpenRouter`'s `reasoning_details`, for one. Opaque here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

impl Turn {
    /// A plain text turn.
    pub fn text(role: Role, text: impl Into<String>) -> Self {
        Self {
            role,
            content: Value::String(text.into()),
            meta: None,
        }
    }

    /// The assistant turn that requested tools (text plus `tool_use` blocks).
    pub fn assistant_blocks(blocks: Vec<Value>) -> Self {
        Self {
            role: Role::Assistant,
            content: Value::Array(blocks),
            meta: None,
        }
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
        Self {
            role: Role::User,
            content: Value::Array(blocks),
            meta: None,
        }
    }

    /// The `tool_use` blocks in this turn, if any.
    pub fn tool_uses(&self) -> Vec<ToolUse> {
        let Some(blocks) = self.content.as_array() else {
            return Vec::new();
        };
        blocks
            .iter()
            .filter(|b| b["type"] == "tool_use")
            .map(|b| ToolUse {
                id: b["id"].as_str().unwrap_or_default().to_owned(),
                name: b["name"].as_str().unwrap_or_default().to_owned(),
                input: b["input"].clone(),
            })
            .collect()
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

/// How hard the model should think. Each wire maps this onto its own knob;
/// `Default` sends nothing and lets the provider choose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    /// Whatever the provider does when not asked.
    #[default]
    Default,
    /// Quick.
    Low,
    /// Balanced.
    Medium,
    /// Thorough.
    High,
    /// As much as the model allows.
    Max,
}

impl Effort {
    /// Parse a preferences value; anything unknown is `Default`.
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "low" => Self::Low,
            "medium" => Self::Medium,
            "high" => Self::High,
            "max" => Self::Max,
            _ => Self::Default,
        }
    }

    /// The preferences value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Max => "max",
        }
    }
}

/// A chat request.
#[derive(Debug, Clone)]
pub struct Request {
    /// Model id, in the provider's own naming.
    pub model: String,
    /// System prompt (stable prefix; cached where the wire allows).
    pub system: String,
    /// Prior turns plus the new user turn, oldest first.
    pub turns: Vec<Turn>,
    /// Tools offered to the model.
    pub tools: Vec<ToolSpec>,
    /// Output cap.
    pub max_tokens: u32,
    /// Reasoning depth.
    pub effort: Effort,
}

impl Request {
    /// A request with the defaults the agent uses.
    pub fn new(system: impl Into<String>, turns: Vec<Turn>) -> Self {
        Self {
            model: DEFAULT_MODEL.into(),
            system: system.into(),
            turns,
            tools: Vec::new(),
            max_tokens: 16_000,
            effort: Effort::Default,
        }
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

/// Token accounting for one reply.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize, Type)]
pub struct Usage {
    /// Prompt tokens, including cached ones.
    pub input_tokens: u32,
    /// Generated tokens, including reasoning.
    pub output_tokens: u32,
    /// Prompt tokens served from cache.
    pub cache_read_tokens: u32,
    /// Cost in USD when the provider reports it (`OpenRouter` does).
    pub cost_usd: Option<f64>,
}

impl Usage {
    /// Fold another reply's usage into this one.
    pub fn add(&mut self, other: Usage) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_add(other.cache_read_tokens);
        self.cost_usd = match (self.cost_usd, other.cost_usd) {
            (Some(a), Some(b)) => Some(a + b),
            (a, None) => a,
            (None, b) => b,
        };
    }
}

/// Streamed pieces of a reply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum Delta {
    /// More answer text.
    Text(String),
    /// More of the model's reasoning, when the provider shows it.
    Reasoning(String),
    /// The model called a tool; the caller runs it and continues the loop.
    ToolUse(ToolUse),
    /// Token accounting for this reply.
    Usage(Usage),
    /// The complete assistant turn, exactly as it must be replayed on the
    /// next request. Arrives once, before `Done`.
    Assistant(Turn),
    /// Reply finished; carries the stop reason (`end_turn`, `tool_use`,
    /// `max_tokens`, `refusal`, ...).
    Done(String),
    /// The API reported an error.
    Error(String),
}

/// Failures before the stream starts.
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    /// No API key configured for a provider that needs one.
    #[error("no API key configured")]
    MissingKey,
    /// No base URL for a custom endpoint.
    #[error("no base URL configured for the custom endpoint")]
    MissingBaseUrl,
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

impl AgentError {
    /// Whether the provider rejected the credentials.
    pub fn is_unauthorized(&self) -> bool {
        matches!(
            self,
            Self::Api {
                status: 401 | 403,
                ..
            }
        )
    }
}

/// A model a provider offers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ModelInfo {
    /// Id to send.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Context window in tokens, when known.
    pub context_length: Option<u32>,
    /// Whether the provider says it supports tool calling. `None` when the
    /// listing does not say; the agent needs tools, so the chrome can warn.
    pub tools: Option<bool>,
    /// Whether it can reason (think) before answering, when known.
    pub reasoning: Option<bool>,
    /// USD per million input tokens, when the listing carries prices.
    pub input_per_mtok: Option<f64>,
    /// USD per million output tokens.
    pub output_per_mtok: Option<f64>,
}

/// Client for one provider and one key.
#[derive(Clone)]
pub struct Client {
    http: Result<reqwest::Client, String>,
    provider: Provider,
    base_url: String,
    api_key: String,
}

impl Client {
    /// Build a client. `base_url` overrides the catalog's, and is required
    /// for [`Provider::Custom`].
    pub fn new(provider: Provider, api_key: impl Into<String>, base_url: Option<&str>) -> Self {
        let base_url = base_url
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map_or_else(
                || provider.info().base_url,
                |s| s.trim_end_matches('/').to_owned(),
            );
        Self {
            http: reqwest::Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|error| error.to_string()),
            provider,
            base_url,
            api_key: api_key.into(),
        }
    }

    /// The provider this client talks to.
    pub fn provider(&self) -> Provider {
        self.provider
    }

    fn check_ready(&self) -> Result<(), AgentError> {
        if self.base_url.is_empty() {
            return Err(AgentError::MissingBaseUrl);
        }
        if self.provider.info().needs_key && self.api_key.trim().is_empty() {
            return Err(AgentError::MissingKey);
        }
        let url = reqwest::Url::parse(&self.base_url)
            .map_err(|error| AgentError::Http(format!("invalid base URL: {error}")))?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(AgentError::Http(
                "base URL must be an HTTP(S) origin or path without credentials, query, or fragment"
                    .into(),
            ));
        }
        self.http()?;
        Ok(())
    }

    fn http(&self) -> Result<&reqwest::Client, AgentError> {
        self.http
            .as_ref()
            .map_err(|error| AgentError::Http(format!("could not configure HTTP client: {error}")))
    }

    async fn send(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, AgentError> {
        tokio::time::timeout(RESPONSE_HEADER_TIMEOUT, request.send())
            .await
            .map_err(|_| AgentError::Http("request timed out waiting for response headers".into()))?
            .map_err(|error| AgentError::Http(error.to_string()))
    }

    /// Authentication headers for this provider.
    ///
    /// Deliberately omit optional app-attribution headers. In particular,
    /// `OpenRouter` uses `HTTP-Referer` and `X-OpenRouter-Title` to publish and
    /// analyze where a key is being used; authentication does not require
    /// either header.
    fn headers(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match self.provider.info().wire {
            Wire::Anthropic => request
                .header("x-api-key", &self.api_key)
                .header("anthropic-version", anthropic::API_VERSION)
                .header("anthropic-beta", anthropic::BETAS),
            Wire::OpenAi if self.api_key.trim().is_empty() => request,
            Wire::OpenAi => request.header("authorization", format!("Bearer {}", self.api_key)),
        }
    }

    /// Send a request and stream deltas until the reply ends.
    pub async fn stream(
        &self,
        request: &Request,
    ) -> Result<impl Stream<Item = Delta> + use<>, AgentError> {
        self.check_ready()?;
        let wire = self.provider.info().wire;
        let (url, body) = match wire {
            Wire::Anthropic => (
                format!("{}/v1/messages", self.base_url),
                anthropic::body(request),
            ),
            Wire::OpenAi => (
                format!("{}/chat/completions", self.base_url),
                openai::body(request, self.provider),
            ),
        };
        let response = self
            .send(
                self.headers(self.http()?.post(&url))
                    .header("content-type", "application/json")
                    .header("accept", "text/event-stream")
                    .json(&body),
            )
            .await?;
        let status = response.status();
        if !status.is_success() {
            let message = tokio::time::timeout(ERROR_BODY_TIMEOUT, read_error_body(response))
                .await
                .unwrap_or_else(|_| "error response timed out".to_owned());
            return Err(AgentError::Api {
                status: status.as_u16(),
                message: tidy_error(&message),
            });
        }
        let bytes = response
            .bytes_stream()
            .scan((0usize, false), |(seen, finished), item| {
                let next = if *finished {
                    None
                } else {
                    Some(match item {
                        Ok(chunk) if chunk.len() <= MAX_STREAM_BYTES.saturating_sub(*seen) => {
                            *seen += chunk.len();
                            Ok(chunk)
                        }
                        Ok(_) => {
                            *finished = true;
                            Err(StreamTransportError::TooLarge)
                        }
                        Err(error) => {
                            *finished = true;
                            Err(StreamTransportError::Http(error))
                        }
                    })
                };
                std::future::ready(next)
            });
        let events = eventsource_stream::Eventsource::eventsource(bytes);
        let state = std::sync::Arc::new(std::sync::Mutex::new(Parser::new(wire, self.provider)));
        Ok(events.flat_map(move |item| {
            let deltas = match item {
                Ok(ev) => state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .parse(&ev.event, &ev.data),
                Err(e) => vec![Delta::Error(e.to_string())],
            };
            futures_util::stream::iter(deltas)
        }))
    }

    /// The models this provider offers, most useful first.
    pub async fn models(&self) -> Result<Vec<ModelInfo>, AgentError> {
        self.check_ready()?;
        let url = match self.provider.info().wire {
            Wire::Anthropic => format!("{}/v1/models?limit=1000", self.base_url),
            Wire::OpenAi => format!("{}/models", self.base_url),
        };
        let body = self.get_json(&url).await?;
        let mut models = match self.provider.info().wire {
            Wire::Anthropic => anthropic::parse_models(&body),
            Wire::OpenAi => openai::parse_models(&body, self.provider),
        };
        models.sort_by_key(|model| model.name.to_lowercase());
        Ok(models)
    }

    /// Check that the key is accepted, with the cheapest authenticated call
    /// the provider has.
    pub async fn verify(&self) -> Result<(), AgentError> {
        self.check_ready()?;
        let url = match (self.provider, self.provider.info().wire) {
            (Provider::Openrouter, _) => format!("{}/key", self.base_url),
            (_, Wire::Anthropic) => format!("{}/v1/models?limit=1", self.base_url),
            (_, Wire::OpenAi) => format!("{}/models", self.base_url),
        };
        self.get_json(&url).await.map(|_| ())
    }

    async fn get_json(&self, url: &str) -> Result<Value, AgentError> {
        let response = self.send(self.headers(self.http()?.get(url))).await?;
        let status = response.status();
        if !status.is_success() {
            let message = tokio::time::timeout(ERROR_BODY_TIMEOUT, read_error_body(response))
                .await
                .unwrap_or_else(|_| "error response timed out".to_owned());
            return Err(AgentError::Api {
                status: status.as_u16(),
                message: tidy_error(&message),
            });
        }
        tokio::time::timeout(JSON_BODY_TIMEOUT, read_json_body(response))
            .await
            .map_err(|_| AgentError::Http("JSON response body timed out".into()))?
    }
}

#[derive(Debug, thiserror::Error)]
enum StreamTransportError {
    #[error("{0}")]
    Http(reqwest::Error),
    #[error("stream response exceeded {MAX_STREAM_BYTES} bytes")]
    TooLarge,
}

/// One SSE parser for whichever wire the client is on.
enum Parser {
    Anthropic(anthropic::StreamState),
    OpenAi(openai::StreamState),
}

impl Parser {
    fn new(wire: Wire, provider: Provider) -> Self {
        match wire {
            Wire::Anthropic => Self::Anthropic(anthropic::StreamState::default()),
            Wire::OpenAi => Self::OpenAi(openai::StreamState::new(provider)),
        }
    }

    fn parse(&mut self, event: &str, data: &str) -> Vec<Delta> {
        match self {
            Self::Anthropic(s) => s.parse_event(event, data),
            Self::OpenAi(s) => s.parse_data(data),
        }
    }
}

/// A JSON number as a `u32`, which is what the chrome can hold without loss.
pub(crate) fn u32_of(v: &Value) -> Option<u32> {
    v.as_u64().and_then(|n| u32::try_from(n).ok())
}

/// Pull the human-readable message out of a provider's JSON error body, so
/// the chrome shows "invalid x-api-key" rather than a wall of JSON.
pub fn tidy_error(body: &str) -> String {
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return body.trim().chars().take(400).collect();
    };
    let candidates = [
        &v["error"]["message"],
        &v["error"]["metadata"]["raw"],
        &v["message"],
        &v["error"],
        &v["detail"],
    ];
    for c in candidates {
        if let Some(s) = c.as_str()
            && !s.trim().is_empty()
        {
            return s.trim().chars().take(400).collect();
        }
    }
    body.trim().chars().take(400).collect()
}

async fn read_error_body(response: reqwest::Response) -> String {
    let mut chunks = response.bytes_stream();
    let mut body = Vec::with_capacity(MAX_ERROR_BODY.min(8 * 1024));
    let mut truncated = false;
    while let Some(chunk) = chunks.next().await {
        let Ok(chunk) = chunk else {
            break;
        };
        let remaining = MAX_ERROR_BODY.saturating_sub(body.len());
        if chunk.len() > remaining {
            body.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            break;
        }
        body.extend_from_slice(&chunk);
        if body.len() == MAX_ERROR_BODY {
            truncated = chunks.next().await.is_some();
            break;
        }
    }
    let mut message = String::from_utf8_lossy(&body).into_owned();
    if truncated {
        message.push_str("\n[response truncated]");
    }
    message
}

async fn read_json_body(response: reqwest::Response) -> Result<Value, AgentError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_JSON_BODY as u64)
    {
        return Err(AgentError::Http(format!(
            "JSON response exceeded {MAX_JSON_BODY} bytes"
        )));
    }
    let mut chunks = response.bytes_stream();
    let mut body = Vec::with_capacity(64 * 1024);
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(|error| AgentError::Http(error.to_string()))?;
        if chunk.len() > MAX_JSON_BODY.saturating_sub(body.len()) {
            return Err(AgentError::Http(format!(
                "JSON response exceeded {MAX_JSON_BODY} bytes"
            )));
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|error| AgentError::Http(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_result_turn_shape() {
        let t = Turn::tool_results(vec![
            ToolResult {
                tool_use_id: "tu_1".into(),
                content: json!("ok"),
                is_error: false,
            },
            ToolResult {
                tool_use_id: "tu_2".into(),
                content: json!("boom"),
                is_error: true,
            },
        ]);
        assert_eq!(t.role, Role::User);
        assert_eq!(t.content[0]["type"], "tool_result");
        assert_eq!(t.content[1]["is_error"], true);
        assert!(t.content[0].get("is_error").is_none());
        // `meta` is for provider state and must not leak into the wire body.
        assert!(serde_json::to_value(&t).unwrap().get("meta").is_none());
    }

    #[test]
    fn tool_uses_are_read_back_out_of_an_assistant_turn() {
        let t = Turn::assistant_blocks(vec![
            json!({"type": "text", "text": "ok"}),
            json!({"type": "tool_use", "id": "a", "name": "page_click", "input": {"locator": "text=Go"}}),
        ]);
        let uses = t.tool_uses();
        assert_eq!(uses.len(), 1);
        assert_eq!(uses[0].name, "page_click");
        assert_eq!(uses[0].input["locator"], "text=Go");
        assert!(Turn::text(Role::Assistant, "hi").tool_uses().is_empty());
    }

    #[test]
    fn effort_round_trips() {
        for e in [
            Effort::Default,
            Effort::Low,
            Effort::Medium,
            Effort::High,
            Effort::Max,
        ] {
            assert_eq!(Effort::parse(e.as_str()), e);
        }
        assert_eq!(Effort::parse("xhigh"), Effort::Default);
    }

    #[test]
    fn usage_adds_up_and_keeps_cost_when_only_one_side_has_it() {
        let mut a = Usage {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_tokens: 3,
            cost_usd: None,
        };
        a.add(Usage {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_tokens: 0,
            cost_usd: Some(0.5),
        });
        assert_eq!(
            (a.input_tokens, a.output_tokens, a.cache_read_tokens),
            (11, 6, 3)
        );
        assert_eq!(a.cost_usd, Some(0.5));
    }

    #[test]
    fn error_bodies_are_reduced_to_their_message() {
        assert_eq!(
            tidy_error(
                r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#
            ),
            "invalid x-api-key"
        );
        assert_eq!(
            tidy_error(
                r#"{"error":{"message":"Provider returned error","code":400,"metadata":{"raw":"model not found"}}}"#
            ),
            "Provider returned error"
        );
        assert_eq!(
            tidy_error("<html>bad gateway</html>"),
            "<html>bad gateway</html>"
        );
    }

    #[test]
    fn custom_base_urls_are_trimmed_and_required() {
        let c = Client::new(Provider::Custom, "", Some(" http://localhost:8080/v1/ "));
        assert_eq!(c.base_url, "http://localhost:8080/v1");
        assert!(matches!(
            Client::new(Provider::Custom, "", None).check_ready(),
            Err(AgentError::MissingBaseUrl)
        ));
        // Local servers need no key; hosted ones do.
        assert!(
            Client::new(Provider::Ollama, "", None)
                .check_ready()
                .is_ok()
        );
        assert!(matches!(
            Client::new(Provider::Openai, "  ", None).check_ready(),
            Err(AgentError::MissingKey)
        ));
        for invalid in [
            "file:///tmp/socket",
            "https://user:secret@example.com/v1",
            "https://example.com/v1?token=secret",
            "not a URL",
        ] {
            assert!(
                Client::new(Provider::Custom, "", Some(invalid))
                    .check_ready()
                    .is_err(),
                "accepted {invalid}"
            );
        }
    }

    #[tokio::test]
    async fn empty_key_is_rejected_before_any_request() {
        let client = Client::new(Provider::Anthropic, "  ", None);
        let err = client
            .stream(&Request::new("s", vec![]))
            .await
            .err()
            .unwrap();
        assert!(matches!(err, AgentError::MissingKey));
    }

    #[tokio::test]
    async fn openrouter_requests_do_not_disclose_the_app_or_page_origin() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 8 * 1024];
            let read = stream.read(&mut buffer).unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .unwrap();
            String::from_utf8_lossy(&buffer[..read]).to_ascii_lowercase()
        });

        Client::new(Provider::Openrouter, "secret", Some(&base_url))
            .verify()
            .await
            .unwrap();
        let request = server.join().unwrap();

        assert!(request.contains("authorization: bearer secret\r\n"));
        for identifying_header in [
            "http-referer",
            "x-openrouter-title",
            "x-title",
            "origin",
            "referer",
        ] {
            assert!(
                !request.contains(&format!("{identifying_header}:")),
                "OpenRouter request disclosed {identifying_header}"
            );
        }
    }
}
