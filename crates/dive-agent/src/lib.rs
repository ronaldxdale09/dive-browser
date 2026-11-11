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

use std::time::Duration;

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
    /// Per-send context that follows `system` (the page the person is on).
    /// Kept apart so the stable part can be cached across sends; wires that
    /// have one system string join them.
    pub context: String,
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
            context: String::new(),
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
    /// The client is set up wrong (a bad base URL, an HTTP client that could
    /// not be built). Fails the same way every time until settings change.
    #[error("{0}")]
    Config(String),
    /// HTTP-level failure. For a request, only a failed connect: nothing
    /// reached the provider, so it is safe to send again.
    #[error("request failed: {0}")]
    Http(String),
    /// The request went out but no usable answer came back (headers timed
    /// out, connection dropped after sending). The provider may have acted
    /// on it, so it is not repeated automatically.
    #[error("request failed: {0}")]
    Unanswered(String),
    /// Non-2xx response.
    #[error("api {status}: {message}")]
    Api {
        /// HTTP status.
        status: u16,
        /// Error body.
        message: String,
        /// How long the provider asked us to wait, from `Retry-After`.
        retry_after: Option<Duration>,
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

    /// Whether trying the same request again could plausibly work.
    ///
    /// Rate limits and the 5xx family are the provider asking for patience;
    /// a transport failure counts only when nothing was sent (a failed
    /// connect); once the request body may have reached the provider it could
    /// already be acting on it, so sending again risks running it twice.
    /// Everything else —
    /// a bad key, a malformed request, a model that does not exist — fails the
    /// same way however many times it is sent, so retrying only wastes the
    /// person's time and their tokens.
    pub fn is_transient(&self) -> bool {
        match self {
            Self::Api { status, .. } => *status == 408 || *status == 429 || *status >= 500,
            Self::Http(_) => true,
            Self::Unanswered(_) | Self::Config(_) | Self::MissingKey | Self::MissingBaseUrl => {
                false
            }
        }
    }

    /// How long the provider asked us to wait, when it said.
    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            Self::Api { retry_after, .. } => *retry_after,
            _ => None,
        }
    }
}

/// `Retry-After` as a duration.
///
/// Only the delay-seconds form, which is what Anthropic and `OpenAI` send. The
/// HTTP-date form is legal too, but parsing it would mean a date dependency
/// for a case no provider here uses; an unreadable value simply means "no
/// advice" and the caller backs off on its own schedule.
fn retry_after_of(response: &reqwest::Response) -> Option<Duration> {
    let raw = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?;
    raw.trim().parse::<u64>().ok().map(Duration::from_secs)
}

/// Wait before attempt `attempt` (1-based), honouring the provider's own
/// `Retry-After` when it sent one and otherwise backing off exponentially.
/// Capped so a run never sits silent for minutes.
pub fn retry_delay(attempt: u32, asked: Option<Duration>) -> Duration {
    const CAP: Duration = Duration::from_secs(20);
    let backoff = Duration::from_millis(500 * 2u64.saturating_pow(attempt.saturating_sub(1)));
    asked.unwrap_or(backoff).min(CAP)
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
        Self::with_http(provider, api_key, base_url, Ok(reqwest::Client::builder()))
    }

    /// Build a client on `http`, a builder the embedder has already pointed
    /// at its proxy; an `Err` says why it could not, and every request then
    /// fails with that reason instead of going around the proxy.
    pub fn with_http(
        provider: Provider,
        api_key: impl Into<String>,
        base_url: Option<&str>,
        http: Result<reqwest::ClientBuilder, String>,
    ) -> Self {
        let base_url = base_url
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map_or_else(
                || provider.info().base_url,
                |s| s.trim_end_matches('/').to_owned(),
            );
        Self {
            http: http.and_then(|builder| {
                builder
                    .connect_timeout(CONNECT_TIMEOUT)
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .map_err(|error| error.to_string())
            }),
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
            .map_err(|error| AgentError::Config(format!("invalid base URL: {error}")))?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(AgentError::Config(
                "base URL must be an HTTP(S) origin or path without credentials, query, or fragment"
                    .into(),
            ));
        }
        // A key sent over plain http can be read by anyone on the path. Local
        // servers (Ollama, LM Studio, a box on the LAN) are fine; anything
        // else has to be https once there is a key to send.
        if url.scheme() == "http" && !self.api_key.trim().is_empty() && !is_local_host(&url) {
            return Err(AgentError::Config(
                "an API key is only sent over https, or over http to this machine or the local network"
                    .into(),
            ));
        }
        self.http()?;
        Ok(())
    }

    fn http(&self) -> Result<&reqwest::Client, AgentError> {
        self.http.as_ref().map_err(|error| {
            AgentError::Config(format!("could not configure HTTP client: {error}"))
        })
    }

    async fn send(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, AgentError> {
        // One more try when the connection itself failed: nothing reached
        // the provider, so nothing can be sent twice, and it covers a pooled
        // connection that died while the machine slept.
        let again = request.try_clone();
        let first = Self::send_once(request).await;
        let outcome = match (first, again) {
            (Err(Some(error)), Some(again)) if error.is_connect() => Self::send_once(again).await,
            (first, _) => first,
        };
        outcome.map_err(|error| match error {
            // Never connected: nothing reached the provider.
            Some(error) if error.is_connect() => AgentError::Http(error.to_string()),
            // Sent, but no usable answer: the provider may have acted on it.
            Some(error) => AgentError::Unanswered(error.to_string()),
            None => AgentError::Unanswered("request timed out waiting for response headers".into()),
        })
    }

    /// One attempt. `Err(None)` is the header timeout; `Err(Some)` is what
    /// the connection said.
    async fn send_once(
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, Option<reqwest::Error>> {
        tokio::time::timeout(RESPONSE_HEADER_TIMEOUT, request.send())
            .await
            .map_err(|_| None)?
            .map_err(Some)
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
            // Read the header before the body: consuming the response moves it.
            let retry_after = retry_after_of(&response);
            let message = tokio::time::timeout(ERROR_BODY_TIMEOUT, read_error_body(response))
                .await
                .unwrap_or_else(|_| "error response timed out".to_owned());
            return Err(AgentError::Api {
                status: status.as_u16(),
                message: tidy_error(&message),
                retry_after,
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
        Ok(deltas(bytes, wire, self.provider))
    }

    /// The models this provider offers, most useful first.
    pub async fn models(&self) -> Result<Vec<ModelInfo>, AgentError> {
        self.check_ready()?;
        // Ollama's own listing knows each model's family and context window;
        // its OpenAI-compatible one has only ids.
        let ollama_tags = (self.provider == Provider::Ollama)
            .then(|| self.base_url.strip_suffix("/v1"))
            .flatten()
            .map(|root| format!("{root}/api/tags"));
        let url = match (&ollama_tags, self.provider.info().wire) {
            (Some(tags), _) => tags.clone(),
            (None, Wire::Anthropic) => format!("{}/v1/models?limit=1000", self.base_url),
            (None, Wire::OpenAi) => format!("{}/models", self.base_url),
        };
        let body = self.get_json(&url).await?;
        let mut models = match (&ollama_tags, self.provider.info().wire) {
            (Some(_), _) => openai::parse_tags(&body),
            (None, Wire::Anthropic) => anthropic::parse_models(&body),
            (None, Wire::OpenAi) => openai::parse_models(&body, self.provider),
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
            // Read the header before the body: consuming the response moves it.
            let retry_after = retry_after_of(&response);
            let message = tokio::time::timeout(ERROR_BODY_TIMEOUT, read_error_body(response))
                .await
                .unwrap_or_else(|_| "error response timed out".to_owned());
            return Err(AgentError::Api {
                status: status.as_u16(),
                message: tidy_error(&message),
                retry_after,
            });
        }
        tokio::time::timeout(JSON_BODY_TIMEOUT, read_json_body(response))
            .await
            .map_err(|_| AgentError::Unanswered("JSON response body timed out".into()))?
    }
}

/// The deltas in an SSE byte stream.
///
/// When the bytes end without the provider's own terminator (`[DONE]` on the
/// `OpenAI` wire, `message_stop` on Anthropic's), a reply whose stop reason
/// already arrived is still delivered rather than dropped on the floor.
fn deltas<S, B, E>(
    bytes: S,
    wire: Wire,
    provider: Provider,
) -> impl Stream<Item = Delta> + use<S, B, E>
where
    S: Stream<Item = Result<B, E>>,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    let events = eventsource_stream::Eventsource::eventsource(bytes);
    let state = std::sync::Arc::new(std::sync::Mutex::new(Parser::new(wire, provider)));
    let at_close = std::sync::Arc::clone(&state);
    events
        .flat_map(move |item| {
            let deltas = match item {
                Ok(ev) => state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .parse(&ev.event, &ev.data),
                Err(e) => vec![Delta::Error(e.to_string())],
            };
            futures_util::stream::iter(deltas)
        })
        .chain(
            futures_util::stream::iter(std::iter::once_with(move || {
                at_close
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .finish_on_close()
            }))
            .flat_map(futures_util::stream::iter),
        )
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

    /// What is still owed when the bytes ran out before the terminator.
    fn finish_on_close(&mut self) -> Vec<Delta> {
        match self {
            Self::Anthropic(s) => s.finish_on_close(),
            Self::OpenAi(s) => s.finish_on_close(),
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

/// Whether `url` names this machine or the local network, where plain http
/// does not expose a key to the wider internet.
fn is_local_host(url: &reqwest::Url) -> bool {
    use std::net::IpAddr;
    let Some(host) = url.host_str() else {
        return false;
    };
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    match bare.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => is_local_v4(ip),
        Ok(IpAddr::V6(ip)) => is_local_v6(ip),
        Err(_) => {
            let name = bare.trim_end_matches('.').to_ascii_lowercase();
            // `localhost`, `*.localhost` and mDNS `*.local` names: the last label.
            matches!(name.rsplit('.').next(), Some("localhost" | "local"))
        }
    }
}

fn is_local_v4(ip: std::net::Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        // Carrier-grade NAT, 100.64.0.0/10 (used by Tailscale).
        || (a == 100 && (64..=127).contains(&b))
}

fn is_local_v6(ip: std::net::Ipv6Addr) -> bool {
    let first = ip.segments()[0];
    ip.is_loopback()
        // Unique-local fc00::/7 and link-local fe80::/10.
        || first & 0xfe00 == 0xfc00
        || first & 0xffc0 == 0xfe80
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_transient_failures_are_worth_repeating() {
        let api = |status| AgentError::Api {
            status,
            message: String::new(),
            retry_after: None,
        };
        // The provider asking for patience, or a server that fell over.
        assert!(api(429).is_transient());
        assert!(api(500).is_transient());
        assert!(api(503).is_transient());
        assert!(api(408).is_transient());
        assert!(AgentError::Http("connection refused".into()).is_transient());
        assert!(
            !AgentError::Unanswered("request timed out waiting for response headers".into())
                .is_transient()
        );
        assert!(!AgentError::Config("invalid base URL: empty host".into()).is_transient());
        // These fail identically however many times they are sent.
        assert!(!api(401).is_transient());
        assert!(!api(403).is_transient());
        assert!(!api(400).is_transient());
        assert!(!api(404).is_transient());
        assert!(!AgentError::MissingKey.is_transient());
    }

    #[test]
    fn the_provider_sets_the_pace_when_it_says_so() {
        // Its own advice wins over our backoff.
        assert_eq!(
            retry_delay(1, Some(Duration::from_secs(7))),
            Duration::from_secs(7)
        );
        // Without advice, back off exponentially from half a second.
        assert_eq!(retry_delay(1, None), Duration::from_millis(500));
        assert_eq!(retry_delay(2, None), Duration::from_secs(1));
        assert_eq!(retry_delay(3, None), Duration::from_secs(2));
        // Never sit silent for minutes, whoever asked.
        assert_eq!(
            retry_delay(1, Some(Duration::from_secs(600))),
            Duration::from_secs(20)
        );
        assert_eq!(retry_delay(20, None), Duration::from_secs(20));
    }

    use super::*;

    #[tokio::test]
    async fn an_openai_stream_that_closes_without_done_delivers_the_reply() {
        let body: &[u8] = b"data: {\"choices\":[{\"delta\":{\"content\":\"hi there\"}}]}\n\n\
            data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n";
        let bytes = futures_util::stream::iter([Ok::<_, std::convert::Infallible>(body)]);
        let out: Vec<Delta> = deltas(bytes, Wire::OpenAi, Provider::Ollama)
            .collect()
            .await;
        assert_eq!(out[0], Delta::Text("hi there".into()));
        assert!(
            matches!(&out[1], Delta::Assistant(t) if t.content[0]["text"] == "hi there"),
            "{out:?}"
        );
        assert_eq!(out[2], Delta::Done("end_turn".into()));
        assert_eq!(out.len(), 3);

        // With [DONE] the tail is not emitted twice.
        let body: &[u8] =
            b"data: {\"choices\":[{\"delta\":{\"content\":\"x\"},\"finish_reason\":\"stop\"}]}\n\n\
            data: [DONE]\n\n";
        let bytes = futures_util::stream::iter([Ok::<_, std::convert::Infallible>(body)]);
        let out: Vec<Delta> = deltas(bytes, Wire::OpenAi, Provider::Ollama)
            .collect()
            .await;
        assert_eq!(out.len(), 3, "{out:?}");

        // Cut off before the finish reason: the caller is told nothing
        // finished, rather than handed a truncated answer as complete.
        let body: &[u8] = b"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n";
        let bytes = futures_util::stream::iter([Ok::<_, std::convert::Infallible>(body)]);
        let out: Vec<Delta> = deltas(bytes, Wire::OpenAi, Provider::Ollama)
            .collect()
            .await;
        assert_eq!(out, vec![Delta::Text("partial".into())]);
    }

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

    #[test]
    fn a_key_never_goes_over_plain_http_to_a_remote_host() {
        let ready = |key: &str, url: &str| {
            Client::new(Provider::Custom, key, Some(url))
                .check_ready()
                .is_ok()
        };
        assert!(!ready("k", "http://api.example.com/v1"));
        assert!(ready("k", "https://api.example.com/v1"));
        for local in [
            "http://127.0.0.1:8080/v1",
            "http://192.168.1.20:11434/v1",
            "http://box.local:1234/v1",
            "http://[::1]:8080/v1",
        ] {
            assert!(ready("k", local), "refused {local}");
        }
        assert!(ready("", "http://api.example.com/v1"));
        assert!(
            Client::new(Provider::Ollama, "", None)
                .check_ready()
                .is_ok()
        );
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

    /// Read one HTTP request off `stream`: the headers, then as many body
    /// bytes as `Content-Length` promises (a single `read` can miss the body
    /// of a `POST`).
    fn read_request(stream: &mut std::net::TcpStream) -> String {
        use std::io::Read;

        let mut raw = Vec::new();
        let mut buffer = [0_u8; 8 * 1024];
        loop {
            let read = stream.read(&mut buffer).unwrap();
            if read == 0 {
                break;
            }
            raw.extend_from_slice(&buffer[..read]);
            let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") else {
                continue;
            };
            let head = String::from_utf8_lossy(&raw[..end]).to_ascii_lowercase();
            let length = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|v| v.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if raw.len() >= end + 4 + length {
                break;
            }
        }
        String::from_utf8_lossy(&raw).to_ascii_lowercase()
    }

    /// Serve one HTTP exchange on loopback: write `chunks` one by one (with a
    /// flush and a short sleep between them so they arrive as separate TCP
    /// reads), then close. Returns the base URL and a handle yielding the
    /// raw request.
    fn serve_once(chunks: Vec<Vec<u8>>) -> (String, std::thread::JoinHandle<String>) {
        use std::io::Write;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            stream.set_nodelay(true).unwrap();
            for chunk in chunks {
                stream.write_all(&chunk).unwrap();
                stream.flush().unwrap();
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            request
        });
        (base_url, server)
    }

    /// One complete response with a body of known length.
    fn response(status_line: &str, headers: &str, body: &[u8]) -> Vec<u8> {
        let mut out = format!(
            "HTTP/1.1 {status_line}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        out.extend_from_slice(body);
        out
    }

    /// A streamed 200 whose body is cut at `cuts` (byte offsets into `body`),
    /// each piece written as its own TCP segment.
    fn event_stream(body: &[u8], cuts: &[usize]) -> Vec<Vec<u8>> {
        let mut chunks = vec![
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n"
                .to_vec(),
        ];
        let mut from = 0;
        for &cut in cuts {
            chunks.push(body[from..cut].to_vec());
            from = cut;
        }
        chunks.push(body[from..].to_vec());
        chunks
    }

    fn hi() -> Request {
        Request::new("s", vec![Turn::text(Role::User, "hi")])
    }

    #[tokio::test]
    async fn openrouter_requests_do_not_disclose_the_app_or_page_origin() {
        let (base_url, server) = serve_once(vec![response("200 OK", "", b"{}")]);

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

    #[tokio::test]
    async fn a_rate_limit_carries_the_providers_retry_after() {
        let (base_url, server) = serve_once(vec![response(
            "429 Too Many Requests",
            "Retry-After: 7\r\n",
            br#"{"error":{"message":"slow down"}}"#,
        )]);
        let err = Client::new(Provider::Anthropic, "k", Some(&base_url))
            .stream(&hi())
            .await
            .err()
            .unwrap();
        server.join().unwrap();

        assert!(
            matches!(
                &err,
                AgentError::Api { status: 429, message, retry_after: Some(wait) }
                    if message == "slow down" && *wait == Duration::from_secs(7)
            ),
            "{err:?}"
        );
        assert!(err.is_transient());
        assert_eq!(retry_delay(1, err.retry_after()), Duration::from_secs(7));
    }

    #[tokio::test]
    async fn an_unreadable_retry_after_means_no_advice() {
        let (base_url, server) = serve_once(vec![response(
            "429 Too Many Requests",
            "Retry-After: Wed, 21 Oct 2015 07:28:00 GMT\r\n",
            br#"{"error":{"message":"slow down"}}"#,
        )]);
        let err = Client::new(Provider::Anthropic, "k", Some(&base_url))
            .stream(&hi())
            .await
            .err()
            .unwrap();
        server.join().unwrap();

        assert!(
            matches!(
                &err,
                AgentError::Api {
                    status: 429,
                    retry_after: None,
                    ..
                }
            ),
            "{err:?}"
        );
        assert_eq!(err.retry_after(), None);
    }

    #[tokio::test]
    async fn a_huge_error_body_is_cut_and_says_so() {
        let body = vec![b'x'; 200 * 1024];
        let (base_url, server) = serve_once(vec![response("500 Internal Server Error", "", &body)]);
        let err = Client::new(Provider::Anthropic, "k", Some(&base_url))
            .stream(&hi())
            .await
            .err()
            .unwrap();
        // The server may still be writing when the client stops reading.
        let _ = server.join();

        let AgentError::Api {
            status: 500,
            message,
            ..
        } = &err
        else {
            panic!("{err:?}");
        };
        // `tidy_error` keeps the first 400 characters of a plain-text body, so
        // the truncation suffix of the raw read does not reach the message;
        // what reaches the chrome is bounded either way.
        assert!(message.len() <= MAX_ERROR_BODY + "\n[response truncated]".len());
        assert_eq!(message.len(), 400, "{}", message.len());
        assert!(message.bytes().all(|b| b == b'x'));
    }

    #[tokio::test]
    async fn the_error_body_reader_cuts_at_the_limit_and_says_so() {
        let body = vec![b'x'; 200 * 1024];
        let (base_url, server) = serve_once(vec![response("500 Internal Server Error", "", &body)]);
        let response = reqwest::Client::new().get(&base_url).send().await.unwrap();
        let message = read_error_body(response).await;
        let _ = server.join();

        assert!(
            message.ends_with("\n[response truncated]"),
            "{}",
            message.len()
        );
        assert_eq!(
            message.len(),
            MAX_ERROR_BODY + "\n[response truncated]".len()
        );
    }

    const ANTHROPIC_REPLY: &str = "event: message_start\n\
data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":120,\"cache_read_input_tokens\":100}}}\n\n\
event: content_block_start\n\
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"caf\u{e9} \"}}\n\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"au lait\"}}\n\n\
event: content_block_stop\n\
data: {\"type\":\"content_block_stop\",\"index\":0}\n\n\
event: message_delta\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":9}}\n\n\
event: message_stop\n\
data: {\"type\":\"message_stop\"}\n\n";

    #[tokio::test]
    async fn an_anthropic_stream_split_across_chunks_is_reassembled() {
        let body = ANTHROPIC_REPLY.as_bytes();
        // One cut inside an event name, one between the two bytes of the
        // accented character, one inside a data line further on.
        let inside_event = body
            .windows(b"content_block_start".len())
            .position(|w| w == b"content_block_start")
            .unwrap()
            + 8;
        let inside_char = body.iter().position(|&b| b == 0xC3).unwrap() + 1;
        let inside_data = body
            .windows(b"message_delta".len())
            .rposition(|w| w == b"message_delta")
            .unwrap()
            + 5;
        let (base_url, server) = serve_once(event_stream(
            body,
            &[inside_event, inside_char, inside_data],
        ));

        let out: Vec<Delta> = Client::new(Provider::Anthropic, "k", Some(&base_url))
            .stream(&hi())
            .await
            .unwrap()
            .collect()
            .await;
        let request = server.join().unwrap();

        assert!(request.starts_with("post /v1/messages "), "{request}");
        let text: String = out
            .iter()
            .filter_map(|d| match d {
                Delta::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "caf\u{e9} au lait", "{out:?}");
        let usage: Vec<&Usage> = out
            .iter()
            .filter_map(|d| match d {
                Delta::Usage(u) => Some(u),
                _ => None,
            })
            .collect();
        assert_eq!(usage.len(), 1, "{out:?}");
        assert_eq!(
            (
                usage[0].input_tokens,
                usage[0].cache_read_tokens,
                usage[0].output_tokens
            ),
            (220, 100, 9)
        );
        assert_eq!(
            out.iter()
                .filter(|d| matches!(d, Delta::Assistant(_)))
                .count(),
            1,
            "{out:?}"
        );
        assert_eq!(out.last(), Some(&Delta::Done("end_turn".into())));
    }

    #[tokio::test]
    async fn an_openai_stream_split_across_chunks_is_reassembled() {
        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"caf\u{e9}\"}}]}\n\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"page_click\",\"arguments\":\"\"}}]}}]}\n\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"locator\\\":\"}}]}}]}\n\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"text=Go\\\"\"}}]}}]}\n\n\
data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n\
data: [DONE]\n\n"
            .as_bytes();
        let inside_char = body.iter().position(|&b| b == 0xC3).unwrap() + 1;
        let inside_line = body
            .windows(b"\"locator\\\"".len())
            .position(|w| w == b"\"locator\\\"")
            .unwrap()
            + 4;
        let near_end = body.len() - 9;
        let (base_url, server) =
            serve_once(event_stream(body, &[inside_char, inside_line, near_end]));

        let out: Vec<Delta> = Client::new(Provider::Custom, "", Some(&base_url))
            .stream(&hi())
            .await
            .unwrap()
            .collect()
            .await;
        let request = server.join().unwrap();

        assert!(request.starts_with("post /chat/completions "), "{request}");
        assert_eq!(out[0], Delta::Text("caf\u{e9}".into()), "{out:?}");
        let calls: Vec<&ToolUse> = out
            .iter()
            .filter_map(|d| match d {
                Delta::ToolUse(c) => Some(c),
                _ => None,
            })
            .collect();
        assert_eq!(calls.len(), 1, "{out:?}");
        assert_eq!(calls[0].id, "call_1");
        assert_eq!(calls[0].name, "page_click");
        assert_eq!(calls[0].input, json!({"locator": "text=Go"}));
        assert_eq!(out.last(), Some(&Delta::Done("tool_use".into())));
    }

    #[tokio::test]
    async fn a_header_timeout_is_not_retried() {
        use std::io::Read;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let (read_tx, read_rx) = std::sync::mpsc::channel();
        // Accept, read the request, then say nothing until the client gives
        // up and closes; then see whether a second connection came (a retry).
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_request(&mut stream);
            read_tx.send(()).unwrap();
            let mut rest = [0_u8; 64];
            while stream.read(&mut rest).unwrap_or(0) > 0 {}
            listener.set_nonblocking(true).unwrap();
            listener.accept().is_ok()
        });

        let client = Client::new(Provider::Anthropic, "k", Some(&base_url));
        let call = tokio::spawn(async move { client.stream(&hi()).await.err() });
        // Pause the clock only once the request is out: while the socket is
        // still connecting, an auto-advancing clock would fire the connect
        // timeout instead of the header one.
        tokio::task::spawn_blocking(move || read_rx.recv().unwrap())
            .await
            .unwrap();
        tokio::time::pause();
        tokio::time::advance(RESPONSE_HEADER_TIMEOUT + Duration::from_secs(1)).await;
        let err = call.await.unwrap().unwrap();
        let retried = server.join().unwrap();

        assert!(matches!(err, AgentError::Unanswered(_)), "{err:?}");
        assert!(!err.is_transient());
        assert!(!retried, "the request was sent more than once");
    }
}
