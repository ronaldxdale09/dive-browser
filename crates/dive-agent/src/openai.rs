//! `OpenAI` chat-completions wire: request body, transcript translation and SSE
//! parsing. Spoken by `OpenAI`, `OpenRouter`, Google's compatibility endpoint,
//! xAI, Groq, Mistral, `DeepSeek`, the inference hosts and the local servers.
//!
//! The transcript arrives in Anthropic block shape and is translated here:
//! `tool_use` blocks become `tool_calls`, each `tool_result` becomes a `tool`
//! message, and an image result -- which a `tool` message cannot carry -- is
//! attached as a user message right after. Reasoning the model produced is
//! echoed back on `OpenRouter`, where a reasoning model in a tool loop expects
//! its own earlier thinking to come back untouched.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::{Delta, Effort, ModelInfo, Provider, Request, Role, ToolUse, Turn, Usage, u32_of};

/// JSON body for `POST /chat/completions`.
pub fn body(request: &Request, provider: Provider) -> Value {
    let mut messages = vec![json!({"role": "system", "content": request.system})];
    messages.extend(to_messages(&request.turns, provider));
    let mut body = json!({
        "model": request.model,
        "stream": true,
        "stream_options": {"include_usage": true},
        "messages": messages,
    });
    // OpenAI's own reasoning models reject `max_tokens`; everyone else's
    // servers reject the other spelling.
    let cap = if provider == Provider::Openai {
        "max_completion_tokens"
    } else {
        "max_tokens"
    };
    body[cap] = json!(request.max_tokens);
    if provider == Provider::Openrouter {
        // Adds `cost` to the final usage chunk.
        body["usage"] = json!({"include": true});
    }
    if !request.tools.is_empty() {
        body["tools"] = Value::Array(
            request
                .tools
                .iter()
                .map(|t| {
                    json!({"type": "function", "function": {
                        "name": t.name, "description": t.description, "parameters": t.input_schema,
                    }})
                })
                .collect(),
        );
        body["tool_choice"] = json!("auto");
    }
    // Only sent when asked: a model without reasoning rejects the parameter
    // on most providers, and OpenRouter would switch reasoning on for one
    // that has it off by default.
    let effort = match request.effort {
        Effort::Default => None,
        Effort::Low => Some("low"),
        Effort::Medium => Some("medium"),
        Effort::High => Some("high"),
        Effort::Max => Some(if provider == Provider::Openrouter {
            "max"
        } else {
            "high"
        }),
    };
    if let Some(effort) = effort {
        if provider == Provider::Openrouter {
            body["reasoning"] = json!({"effort": effort, "exclude": false});
        } else {
            body["reasoning_effort"] = json!(effort);
        }
    }
    body
}

/// Translate Anthropic-shaped turns into chat-completions messages.
pub fn to_messages(turns: &[Turn], provider: Provider) -> Vec<Value> {
    let mut out = Vec::with_capacity(turns.len());
    for turn in turns {
        match (&turn.role, &turn.content) {
            (Role::User, Value::Array(blocks))
                if blocks.iter().any(|b| b["type"] == "tool_result") =>
            {
                let mut images = Vec::new();
                for block in blocks {
                    if block["type"] != "tool_result" {
                        continue;
                    }
                    let id = block["tool_use_id"].as_str().unwrap_or_default();
                    let (text, image) = split_result(&block["content"]);
                    let mut text = text;
                    if block["is_error"] == true && !text.starts_with("Error") {
                        text = format!("Error: {text}");
                    }
                    if let Some(image) = image {
                        if text.is_empty() {
                            text = "Screenshot attached in the next message.".into();
                        }
                        images.push(json!({"type": "image_url", "image_url": {"url": image}}));
                    }
                    out.push(json!({"role": "tool", "tool_call_id": id, "content": text}));
                }
                if !images.is_empty() {
                    let mut content = vec![
                        json!({"type": "text", "text": "Screenshot from the tool call above."}),
                    ];
                    content.extend(images);
                    out.push(json!({"role": "user", "content": content}));
                }
            }
            (Role::User, content) => {
                out.push(json!({"role": "user", "content": plain_text(content)}));
            }
            (Role::Assistant, Value::Array(blocks)) => {
                let text: String = blocks
                    .iter()
                    .filter(|b| b["type"] == "text")
                    .filter_map(|b| b["text"].as_str())
                    .collect();
                let calls: Vec<Value> = blocks
                    .iter()
                    .filter(|b| b["type"] == "tool_use")
                    .map(|b| {
                        json!({"id": b["id"], "type": "function", "function": {
                            "name": b["name"], "arguments": b["input"].to_string(),
                        }})
                    })
                    .collect();
                let mut message = json!({"role": "assistant", "content": if text.is_empty() { Value::Null } else { Value::String(text) }});
                if !calls.is_empty() {
                    message["tool_calls"] = Value::Array(calls);
                }
                if provider == Provider::Openrouter
                    && let Some(details) =
                        turn.meta.as_ref().and_then(|m| m.get("reasoning_details"))
                    && details.as_array().is_some_and(|d| !d.is_empty())
                {
                    message["reasoning_details"] = details.clone();
                }
                out.push(message);
            }
            (Role::Assistant, content) => {
                out.push(json!({"role": "assistant", "content": plain_text(content)}));
            }
        }
    }
    out
}

/// The text of a tool result, and its image as a data URL if it has one.
fn split_result(content: &Value) -> (String, Option<String>) {
    match content {
        Value::String(s) => (s.clone(), None),
        Value::Array(blocks) => {
            let mut text = String::new();
            let mut image = None;
            for b in blocks {
                match b["type"].as_str() {
                    Some("text") => text.push_str(b["text"].as_str().unwrap_or_default()),
                    Some("image") => {
                        let src = &b["source"];
                        if let (Some(media), Some(data)) =
                            (src["media_type"].as_str(), src["data"].as_str())
                        {
                            image = Some(format!("data:{media};base64,{data}"));
                        }
                    }
                    _ => {}
                }
            }
            (text, image)
        }
        other => (other.to_string(), None),
    }
}

fn plain_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str())
            .collect(),
        other => other.to_string(),
    }
}

/// Models from `GET /models`. `OpenRouter`'s listing is rich; most others
/// give little more than ids, so every field beyond `id` is optional.
pub fn parse_models(body: &Value, provider: Provider) -> Vec<ModelInfo> {
    let Some(models) = body["data"].as_array() else {
        return Vec::new();
    };
    models
        .iter()
        .filter_map(|m| {
            let id = m["id"].as_str()?.to_owned();
            if provider == Provider::Openai && !looks_like_chat_model(&id) {
                return None;
            }
            let params: Vec<&str> = m["supported_parameters"]
                .as_array()
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let rich = !params.is_empty();
            if rich {
                // The agent cannot work without tools, and cannot read an
                // image-only model's output.
                if !params.contains(&"tools") {
                    return None;
                }
                let outputs = &m["architecture"]["output_modalities"];
                if outputs.is_array()
                    && !outputs
                        .as_array()
                        .is_some_and(|o| o.iter().any(|v| v == "text"))
                {
                    return None;
                }
            }
            let per_tok = |key: &str| {
                m["pricing"][key]
                    .as_str()
                    .and_then(|s| s.parse::<f64>().ok())
                    .or_else(|| m["pricing"][key].as_f64())
                    .map(|p| p * 1_000_000.0)
            };
            Some(ModelInfo {
                name: m["name"]
                    .as_str()
                    .or_else(|| m["display_name"].as_str())
                    .unwrap_or(&id)
                    .to_owned(),
                context_length: u32_of(&m["context_length"])
                    .or_else(|| u32_of(&m["context_window"]))
                    .or_else(|| u32_of(&m["max_context_length"])),
                tools: rich.then_some(true),
                reasoning: rich
                    .then(|| params.contains(&"reasoning") || params.contains(&"reasoning_effort")),
                input_per_mtok: per_tok("prompt"),
                output_per_mtok: per_tok("completion"),
                id,
            })
        })
        .collect()
}

/// Models from Ollama's own `GET /api/tags`, which says what its
/// OpenAI-compatible `/v1/models` does not: the family (so embedding-only
/// models such as bge or nomic-embed stay out of a chat picker) and the
/// context window.
pub fn parse_tags(body: &Value) -> Vec<ModelInfo> {
    let Some(models) = body["models"].as_array() else {
        return Vec::new();
    };
    models
        .iter()
        .filter_map(|m| {
            let id = m["name"]
                .as_str()
                .or_else(|| m["model"].as_str())?
                .to_owned();
            let details = &m["details"];
            let families: Vec<String> = details["families"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_lowercase)
                        .collect()
                })
                .unwrap_or_default();
            let family = details["family"].as_str().unwrap_or("").to_lowercase();
            let embedding = |f: &str| f == "bert" || f == "nomic-bert" || f.contains("embed");
            if embedding(&family) || families.iter().any(|f| embedding(f)) {
                return None;
            }
            Some(ModelInfo {
                name: id.clone(),
                context_length: u32_of(&details["context_length"]),
                tools: None,
                reasoning: None,
                input_per_mtok: None,
                output_per_mtok: None,
                id,
            })
        })
        .collect()
}

/// `OpenAI`'s `/models` lists embeddings, speech and image models alongside
/// the chat ones, with nothing but the id to tell them apart.
fn looks_like_chat_model(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    let excluded = [
        "embedding",
        "tts",
        "whisper",
        "transcribe",
        "dall-e",
        "moderation",
        "realtime",
        "audio",
        "image",
        "sora",
        "babbage",
        "davinci",
        "instruct",
        "search",
        "computer-use",
    ];
    !excluded.iter().any(|e| id.contains(e))
}

/// Accumulates one streamed completion.
#[derive(Debug)]
pub struct StreamState {
    provider: Provider,
    text: String,
    /// Tool calls by their `index`, as `(id, name, partial arguments)`.
    calls: BTreeMap<usize, (String, String, String)>,
    /// Reasoning detail objects by index, accumulated for replay.
    reasoning_details: BTreeMap<usize, Value>,
    finish_reason: Option<String>,
    usage: Option<Usage>,
    finished: bool,
}

impl StreamState {
    /// A parser for `provider`'s dialect.
    pub fn new(provider: Provider) -> Self {
        Self {
            provider,
            text: String::new(),
            calls: BTreeMap::new(),
            reasoning_details: BTreeMap::new(),
            finish_reason: None,
            usage: None,
            finished: false,
        }
    }

    /// Turn one SSE `data:` payload into the deltas the caller acts on.
    pub fn parse_data(&mut self, data: &str) -> Vec<Delta> {
        let data = data.trim();
        if data.is_empty() {
            return Vec::new();
        }
        if data == "[DONE]" {
            return self.finish();
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            return Vec::new();
        };
        if let Some(err) = v.get("error")
            && !err.is_null()
        {
            let message = err["message"]
                .as_str()
                .map_or_else(|| err.to_string(), str::to_owned);
            return vec![Delta::Error(message)];
        }
        let mut out = Vec::new();
        if let Some(u) = v.get("usage")
            && u.is_object()
        {
            self.usage = Some(Usage {
                input_tokens: u32_of(&u["prompt_tokens"]).unwrap_or(0),
                output_tokens: u32_of(&u["completion_tokens"]).unwrap_or(0),
                cache_read_tokens: u32_of(&u["prompt_tokens_details"]["cached_tokens"])
                    .unwrap_or(0),
                cost_usd: u["cost"].as_f64(),
            });
        }
        let Some(choice) = v["choices"].as_array().and_then(|c| c.first()) else {
            return out;
        };
        let delta = &choice["delta"];
        if let Some(text) = delta["content"].as_str()
            && !text.is_empty()
        {
            self.text.push_str(text);
            out.push(Delta::Text(text.to_owned()));
        }
        // Three spellings of the same thing: OpenRouter's structured
        // details, its older plain string, and DeepSeek's `reasoning_content`.
        if let Some(details) = delta["reasoning_details"].as_array() {
            for d in details {
                let index = usize::try_from(d["index"].as_u64().unwrap_or(0)).unwrap_or(0);
                let text = d["text"]
                    .as_str()
                    .or_else(|| d["summary"].as_str())
                    .unwrap_or_default();
                if !text.is_empty() {
                    out.push(Delta::Reasoning(text.to_owned()));
                }
                self.merge_detail(index, d);
            }
        } else if let Some(text) = delta["reasoning"]
            .as_str()
            .or_else(|| delta["reasoning_content"].as_str())
            && !text.is_empty()
        {
            out.push(Delta::Reasoning(text.to_owned()));
        }
        if let Some(calls) = delta["tool_calls"].as_array() {
            for c in calls {
                let index = usize::try_from(c["index"].as_u64().unwrap_or(0)).unwrap_or(0);
                let entry = self
                    .calls
                    .entry(index)
                    .or_insert_with(|| (String::new(), String::new(), String::new()));
                if let Some(id) = c["id"].as_str() {
                    id.clone_into(&mut entry.0);
                }
                if let Some(name) = c["function"]["name"].as_str() {
                    entry.1.push_str(name);
                }
                if let Some(args) = c["function"]["arguments"].as_str() {
                    entry.2.push_str(args);
                }
            }
        }
        if let Some(reason) = choice["finish_reason"].as_str() {
            self.finish_reason = Some(reason.to_owned());
        }
        out
    }

    /// Fold one streamed reasoning detail into the accumulated block at its
    /// index: text and summaries concatenate, everything else is replaced.
    fn merge_detail(&mut self, index: usize, d: &Value) {
        let slot = self
            .reasoning_details
            .entry(index)
            .or_insert_with(|| json!({}));
        let Some(obj) = slot.as_object_mut() else {
            return;
        };
        if let Some(incoming) = d.as_object() {
            for (k, v) in incoming {
                match (k.as_str(), v.as_str(), obj.get_mut(k)) {
                    ("text" | "summary", Some(more), Some(Value::String(existing))) => {
                        existing.push_str(more);
                    }
                    _ => {
                        obj.insert(k.clone(), v.clone());
                    }
                }
            }
        }
    }

    /// The trailing deltas when the bytes ended without `[DONE]`, which some
    /// OpenAI-compatible servers never send: a reply whose `finish_reason`
    /// arrived is complete and is delivered; one cut off before that stays
    /// unfinished so the caller reports it.
    pub(crate) fn finish_on_close(&mut self) -> Vec<Delta> {
        if self.finish_reason.is_some() {
            self.finish()
        } else {
            Vec::new()
        }
    }

    /// The trailing deltas: tool calls, usage, the replayable turn, then the
    /// stop reason in Anthropic vocabulary.
    fn finish(&mut self) -> Vec<Delta> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        let mut out = Vec::new();
        let mut blocks = Vec::new();
        if !self.text.is_empty() {
            blocks.push(json!({"type": "text", "text": std::mem::take(&mut self.text)}));
        }
        for (i, (id, name, raw)) in std::mem::take(&mut self.calls) {
            // Some servers omit ids on streamed calls; the result still has
            // to name its call, so mint one.
            let id = if id.is_empty() {
                format!("call_{i}")
            } else {
                id
            };
            let input = match crate::anthropic::parse_arguments(&raw) {
                Ok(input) => input,
                // Running a tool with made-up empty arguments is worse than
                // stopping: the caller learns the call was unusable.
                Err(reason) => {
                    return vec![Delta::Error(crate::anthropic::malformed_call(
                        &name, &id, &reason,
                    ))];
                }
            };
            blocks.push(json!({"type": "tool_use", "id": id, "name": name, "input": input}));
            out.push(Delta::ToolUse(ToolUse { id, name, input }));
        }
        let had_calls = blocks.iter().any(|b| b["type"] == "tool_use");
        if let Some(usage) = self.usage.take() {
            out.push(Delta::Usage(usage));
        }
        let details: Vec<Value> = std::mem::take(&mut self.reasoning_details)
            .into_values()
            .collect();
        let meta = (self.provider == Provider::Openrouter && !details.is_empty())
            .then(|| json!({"reasoning_details": details}));
        out.push(Delta::Assistant(Turn {
            role: Role::Assistant,
            content: Value::Array(blocks),
            meta,
        }));
        let reason = match (self.finish_reason.take().as_deref(), had_calls) {
            (Some("tool_calls" | "function_call"), _) | (_, true) => "tool_use",
            (Some("length"), _) => "max_tokens",
            (Some("content_filter"), _) => "refusal",
            _ => "end_turn",
        };
        out.push(Delta::Done(reason.to_owned()));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ToolResult, ToolSpec};

    fn request() -> Request {
        let mut r = Request::new("sys", vec![Turn::text(Role::User, "hi")]);
        r.model = "openai/gpt-5".into();
        r.tools.push(ToolSpec {
            name: "page_click".into(),
            description: "Click.".into(),
            input_schema: json!({"type": "object", "properties": {}}),
        });
        r
    }

    #[test]
    fn body_is_chat_completions_shaped() {
        let b = body(&request(), Provider::Openrouter);
        assert_eq!(b["stream"], true);
        assert_eq!(b["stream_options"]["include_usage"], true);
        assert_eq!(
            b["usage"]["include"], true,
            "OpenRouter reports cost when asked"
        );
        assert_eq!(
            b["messages"][0],
            json!({"role": "system", "content": "sys"})
        );
        assert_eq!(b["messages"][1], json!({"role": "user", "content": "hi"}));
        assert_eq!(b["tools"][0]["type"], "function");
        assert_eq!(b["tools"][0]["function"]["name"], "page_click");
        assert_eq!(b["tool_choice"], "auto");
        assert_eq!(b["max_tokens"], 16_000);
        assert!(b.get("reasoning").is_none(), "default effort sends nothing");
        assert!(b.get("thinking").is_none(), "no Anthropic fields leak");

        let b = body(&request(), Provider::Openai);
        assert_eq!(b["max_completion_tokens"], 16_000);
        assert!(b.get("max_tokens").is_none());
        assert!(b.get("usage").is_none());
    }

    #[test]
    fn effort_maps_onto_each_dialect() {
        let mut r = request();
        r.effort = Effort::Max;
        assert_eq!(
            body(&r, Provider::Openrouter)["reasoning"],
            json!({"effort": "max", "exclude": false})
        );
        assert_eq!(body(&r, Provider::Openai)["reasoning_effort"], "high");
        r.effort = Effort::Low;
        assert_eq!(body(&r, Provider::Google)["reasoning_effort"], "low");
    }

    #[test]
    fn transcript_translates_tool_calls_results_and_images() {
        let turns = vec![
            Turn::text(Role::User, "click it"),
            Turn {
                role: Role::Assistant,
                content: json!([
                    {"type": "thinking", "thinking": "hmm", "signature": "x"},
                    {"type": "text", "text": "Sure."},
                    {"type": "tool_use", "id": "c1", "name": "page_click", "input": {"locator": "text=Go"}},
                    {"type": "tool_use", "id": "c2", "name": "page_screenshot", "input": {}},
                ]),
                meta: Some(
                    json!({"reasoning_details": [{"type": "reasoning.text", "text": "hmm", "index": 0}]}),
                ),
            },
            Turn::tool_results(vec![
                ToolResult {
                    tool_use_id: "c1".into(),
                    content: json!("clicked"),
                    is_error: false,
                },
                ToolResult {
                    tool_use_id: "c2".into(),
                    content: json!([{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}}]),
                    is_error: false,
                },
            ]),
        ];
        let m = to_messages(&turns, Provider::Openrouter);
        assert_eq!(m[0], json!({"role": "user", "content": "click it"}));
        assert_eq!(m[1]["role"], "assistant");
        assert_eq!(m[1]["content"], "Sure.");
        assert_eq!(m[1]["tool_calls"][0]["id"], "c1");
        assert_eq!(
            m[1]["tool_calls"][0]["function"]["arguments"],
            r#"{"locator":"text=Go"}"#
        );
        assert!(
            m[1].get("thinking").is_none(),
            "Anthropic thinking blocks never go out on this wire"
        );
        assert_eq!(
            m[1]["reasoning_details"][0]["text"], "hmm",
            "OpenRouter gets its reasoning back"
        );
        assert_eq!(
            m[2],
            json!({"role": "tool", "tool_call_id": "c1", "content": "clicked"})
        );
        assert_eq!(m[3]["role"], "tool");
        assert_eq!(m[3]["tool_call_id"], "c2");
        // The image cannot ride in the tool message, so it follows as a user turn.
        assert_eq!(m[4]["role"], "user");
        assert_eq!(
            m[4]["content"][1]["image_url"]["url"],
            "data:image/png;base64,AAAA"
        );
        assert_eq!(m.len(), 5);

        // Other providers do not get OpenRouter's private field.
        let m = to_messages(&turns, Provider::Openai);
        assert!(m[1].get("reasoning_details").is_none());
    }

    #[test]
    fn errors_are_marked_for_the_model() {
        let turns = vec![Turn::tool_results(vec![ToolResult {
            tool_use_id: "c1".into(),
            content: json!("nothing matched"),
            is_error: true,
        }])];
        assert_eq!(
            to_messages(&turns, Provider::Groq)[0]["content"],
            "Error: nothing matched"
        );
    }

    #[test]
    fn parses_a_streamed_tool_call_with_reasoning_and_usage() {
        let mut st = StreamState::new(Provider::Openrouter);
        assert!(st.parse_data(": OPENROUTER PROCESSING").is_empty());
        assert_eq!(
            st.parse_data(r#"{"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"think ","index":0,"id":"r1"}]}}]}"#),
            vec![Delta::Reasoning("think ".into())]
        );
        assert_eq!(
            st.parse_data(r#"{"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"more","index":0}]}}]}"#),
            vec![Delta::Reasoning("more".into())]
        );
        assert_eq!(
            st.parse_data(r#"{"choices":[{"delta":{"content":"On it."}}]}"#),
            vec![Delta::Text("On it.".into())]
        );
        assert!(st.parse_data(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"page_click","arguments":""}}]}}]}"#).is_empty());
        assert!(st.parse_data(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"locator\":"}}]}}]}"#).is_empty());
        assert!(st.parse_data(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"text=Go\"}"}}]},"finish_reason":"tool_calls"}]}"#).is_empty());
        assert!(st.parse_data(r#"{"choices":[{"delta":{}}],"usage":{"prompt_tokens":50,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":10},"cost":0.0012}}"#).is_empty());
        let tail = st.parse_data("[DONE]");
        assert_eq!(
            tail[0],
            Delta::ToolUse(ToolUse {
                id: "call_1".into(),
                name: "page_click".into(),
                input: json!({"locator": "text=Go"})
            })
        );
        assert_eq!(
            tail[1],
            Delta::Usage(Usage {
                input_tokens: 50,
                output_tokens: 20,
                cache_read_tokens: 10,
                cost_usd: Some(0.0012)
            })
        );
        let Delta::Assistant(turn) = &tail[2] else {
            panic!("expected the assistant turn, got {:?}", tail[2]);
        };
        assert_eq!(turn.content[0], json!({"type": "text", "text": "On it."}));
        assert_eq!(turn.content[1]["type"], "tool_use");
        assert_eq!(turn.content[1]["input"]["locator"], "text=Go");
        // The two streamed fragments were folded into one detail for replay.
        assert_eq!(
            turn.meta.as_ref().unwrap()["reasoning_details"][0]["text"],
            "think more"
        );
        assert_eq!(
            turn.meta.as_ref().unwrap()["reasoning_details"][0]["id"],
            "r1"
        );
        assert_eq!(tail[3], Delta::Done("tool_use".into()));
        assert!(st.parse_data("[DONE]").is_empty());
    }

    #[test]
    fn plain_answers_and_other_dialects() {
        let mut st = StreamState::new(Provider::Deepseek);
        assert_eq!(
            st.parse_data(r#"{"choices":[{"delta":{"reasoning_content":"why"}}]}"#),
            vec![Delta::Reasoning("why".into())]
        );
        assert_eq!(
            st.parse_data(r#"{"choices":[{"delta":{"content":"42"},"finish_reason":"stop"}]}"#),
            vec![Delta::Text("42".into())]
        );
        let tail = st.parse_data("[DONE]");
        let Delta::Assistant(turn) = &tail[0] else {
            panic!("{tail:?}");
        };
        assert_eq!(turn.content, json!([{"type": "text", "text": "42"}]));
        assert!(
            turn.meta.is_none(),
            "only OpenRouter gets reasoning replayed"
        );
        assert_eq!(tail[1], Delta::Done("end_turn".into()));

        let mut st = StreamState::new(Provider::Openai);
        assert_eq!(
            st.parse_data(r#"{"choices":[{"delta":{"content":"x"},"finish_reason":"length"}]}"#)
                .len(),
            1
        );
        assert!(
            st.parse_data("[DONE]")
                .contains(&Delta::Done("max_tokens".into()))
        );

        // A mid-stream error object is surfaced, not swallowed.
        let mut st = StreamState::new(Provider::Openrouter);
        assert_eq!(
            st.parse_data(r#"{"error":{"message":"Rate limit exceeded","code":429}}"#),
            vec![Delta::Error("Rate limit exceeded".into())]
        );
    }

    #[test]
    fn a_call_with_malformed_arguments_is_an_error_not_an_empty_call() {
        let mut st = StreamState::new(Provider::Ollama);
        st.parse_data(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"page_click","arguments":"{\"locator\": text=Go}"}}]},"finish_reason":"tool_calls"}]}"#);
        let tail = st.parse_data("[DONE]");
        let [Delta::Error(message)] = tail.as_slice() else {
            panic!("expected one error, got {tail:?}");
        };
        assert!(message.contains("page_click"), "{message}");
        assert!(message.contains("call_9"), "{message}");
        assert!(message.contains("not valid JSON"), "{message}");
        assert!(st.parse_data("[DONE]").is_empty(), "finished once");
    }

    #[test]
    fn a_stream_that_closes_without_done_still_delivers_a_finished_reply() {
        let mut st = StreamState::new(Provider::Ollama);
        st.parse_data(r#"{"choices":[{"delta":{"content":"hello"}}]}"#);
        // No finish_reason yet: the reply was cut off, so nothing to deliver.
        assert!(st.finish_on_close().is_empty());
        st.parse_data(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#);
        let tail = st.finish_on_close();
        assert!(
            matches!(&tail[0], Delta::Assistant(t) if t.content[0]["text"] == "hello"),
            "{tail:?}"
        );
        assert_eq!(tail[1], Delta::Done("end_turn".into()));
        assert!(st.finish_on_close().is_empty());
    }

    #[test]
    fn a_call_without_an_id_gets_one() {
        let mut st = StreamState::new(Provider::Ollama);
        st.parse_data(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"page_text","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}"#);
        let tail = st.parse_data("[DONE]");
        let Delta::ToolUse(call) = &tail[0] else {
            panic!("{tail:?}");
        };
        assert_eq!(call.id, "call_0");
        assert_eq!(call.name, "page_text");
    }

    #[test]
    fn model_listings_from_rich_and_bare_providers() {
        let rich = json!({"data": [
            {"id": "anthropic/claude-opus-5", "name": "Anthropic: Claude Opus 5", "context_length": 1_000_000,
             "pricing": {"prompt": "0.000005", "completion": "0.000025"},
             "supported_parameters": ["tools", "reasoning"], "architecture": {"output_modalities": ["text"]}},
            {"id": "some/image-model", "name": "Image", "supported_parameters": ["tools"], "architecture": {"output_modalities": ["image"]}},
            {"id": "some/no-tools", "name": "No tools", "supported_parameters": ["max_tokens"]},
        ]});
        let models = parse_models(&rich, Provider::Openrouter);
        assert_eq!(
            models.len(),
            1,
            "image-only and tool-less models are dropped"
        );
        assert_eq!(models[0].name, "Anthropic: Claude Opus 5");
        assert_eq!(models[0].tools, Some(true));
        assert_eq!(models[0].reasoning, Some(true));
        assert!((models[0].input_per_mtok.unwrap() - 5.0).abs() < 1e-9);
        assert!((models[0].output_per_mtok.unwrap() - 25.0).abs() < 1e-9);

        let bare = json!({"data": [
            {"id": "gpt-5", "object": "model"},
            {"id": "text-embedding-3-large"},
            {"id": "whisper-1"},
        ]});
        let models = parse_models(&bare, Provider::Openai);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-5");
        assert_eq!(models[0].tools, None, "a bare listing cannot say");

        let groq = json!({"data": [{"id": "openai/gpt-oss-120b", "context_window": 131_072}]});
        assert_eq!(
            parse_models(&groq, Provider::Groq)[0].context_length,
            Some(131_072)
        );
    }

    #[test]
    fn ollama_tags_keep_chat_models_and_their_context() {
        let tags = json!({"models": [
            {"name": "qwen2.5:0.5b", "details": {"family": "qwen2", "families": ["qwen2"], "context_length": 32768}},
            {"name": "bge-m3:latest", "details": {"family": "bert", "families": ["bert"], "context_length": 8192}},
            {"name": "nomic-embed-text:latest", "details": {"family": "nomic-bert"}},
            {"name": "llama3.2:latest", "details": {"family": "llama"}}
        ]});
        let models = parse_tags(&tags);
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["qwen2.5:0.5b", "llama3.2:latest"]);
        assert_eq!(models[0].context_length, Some(32768));
        assert_eq!(models[1].context_length, None);
        assert!(parse_tags(&json!({})).is_empty());
    }
}
