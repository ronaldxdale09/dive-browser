//! Anthropic Messages API: request body and SSE parsing.
//!
//! Every content block the model produces is kept in order and handed back
//! whole in [`Delta::Assistant`], thinking blocks and signatures included.
//! That is what the API needs replayed on the next request of a tool loop;
//! rebuilding the turn from the text and tool calls alone drops the thinking
//! and, on current models, gets the request refused.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::{Delta, Effort, ModelInfo, Request, Role, ToolUse, Turn, Usage, u32_of};

/// API version header.
pub const API_VERSION: &str = "2023-06-01";
/// Beta features the body relies on: server-side refusal fallbacks.
pub const BETAS: &str = "server-side-fallback-2026-07-01";

/// JSON body for `POST /v1/messages`.
pub fn body(request: &Request) -> Value {
    let mut body = json!({
        "model": request.model,
        "max_tokens": request.max_tokens,
        "stream": true,
        // Summaries are what the chrome shows while the model works; the
        // default hides them and a long silence reads as a hang.
        "thinking": {"type": "adaptive", "display": "summarized"},
        "fallbacks": "default",
        "system": [{"type": "text", "text": request.system, "cache_control": {"type": "ephemeral"}}],
        "messages": request.turns.iter().map(|t| json!({"role": t.role, "content": t.content})).collect::<Vec<_>>(),
    });
    let effort = match request.effort {
        Effort::Default => None,
        Effort::Low => Some("low"),
        Effort::Medium => Some("medium"),
        Effort::High => Some("high"),
        Effort::Max => Some("max"),
    };
    if let Some(effort) = effort {
        body["output_config"] = json!({"effort": effort});
    }
    if !request.tools.is_empty() {
        body["tools"] = serde_json::to_value(&request.tools).unwrap_or(Value::Null);
    }
    body
}

/// Models from `GET /v1/models`. Every current Claude model takes tools and
/// thinks, so both flags are set outright.
pub fn parse_models(body: &Value) -> Vec<ModelInfo> {
    body["data"]
        .as_array()
        .map(|models| {
            models
                .iter()
                .filter_map(|m| {
                    let id = m["id"].as_str()?.to_owned();
                    Some(ModelInfo {
                        name: m["display_name"].as_str().unwrap_or(&id).to_owned(),
                        id,
                        context_length: u32_of(&m["max_input_tokens"]),
                        tools: Some(true),
                        reasoning: Some(true),
                        input_per_mtok: None,
                        output_per_mtok: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Accumulates one streamed message, block by block.
#[derive(Debug, Default)]
pub struct StreamState {
    /// Blocks by index, in the shape they will be replayed.
    blocks: BTreeMap<usize, Value>,
    /// Partial JSON for `tool_use` inputs, by index.
    partial_inputs: BTreeMap<usize, String>,
    stop_reason: Option<String>,
    usage: Usage,
    finished: bool,
}

impl StreamState {
    /// Turn one SSE event into the deltas the caller acts on.
    pub fn parse_event(&mut self, event_name: &str, data: &str) -> Vec<Delta> {
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            return Vec::new();
        };
        match event_name {
            "message_start" => {
                let u = &v["message"]["usage"];
                self.usage.input_tokens = u32_of(&u["input_tokens"]).unwrap_or(0);
                self.usage.cache_read_tokens = u32_of(&u["cache_read_input_tokens"]).unwrap_or(0);
                Vec::new()
            }
            "content_block_start" => {
                let index = index_of(&v);
                let block = &v["content_block"];
                let skeleton = match block["type"].as_str() {
                    Some("tool_use") => {
                        self.partial_inputs.insert(index, String::new());
                        json!({"type": "tool_use", "id": block["id"], "name": block["name"], "input": {}})
                    }
                    Some("text") => json!({"type": "text", "text": ""}),
                    Some("thinking") => {
                        json!({"type": "thinking", "thinking": "", "signature": ""})
                    }
                    // Redacted thinking and anything newer arrive complete
                    // and are replayed exactly as received.
                    _ => block.clone(),
                };
                self.blocks.insert(index, skeleton);
                Vec::new()
            }
            "content_block_delta" => {
                let index = index_of(&v);
                let d = &v["delta"];
                match d["type"].as_str() {
                    Some("text_delta") => {
                        let text = d["text"].as_str().unwrap_or_default();
                        append(self.blocks.get_mut(&index), "text", text);
                        vec![Delta::Text(text.to_owned())]
                    }
                    Some("thinking_delta") => {
                        let text = d["thinking"].as_str().unwrap_or_default();
                        append(self.blocks.get_mut(&index), "thinking", text);
                        if text.is_empty() {
                            Vec::new()
                        } else {
                            vec![Delta::Reasoning(text.to_owned())]
                        }
                    }
                    Some("signature_delta") => {
                        append(
                            self.blocks.get_mut(&index),
                            "signature",
                            d["signature"].as_str().unwrap_or_default(),
                        );
                        Vec::new()
                    }
                    Some("input_json_delta") => {
                        if let Some(p) = self.partial_inputs.get_mut(&index) {
                            p.push_str(d["partial_json"].as_str().unwrap_or_default());
                        }
                        Vec::new()
                    }
                    _ => Vec::new(),
                }
            }
            "content_block_stop" => {
                let index = index_of(&v);
                let Some(raw) = self.partial_inputs.remove(&index) else {
                    return Vec::new();
                };
                let input = if raw.trim().is_empty() {
                    json!({})
                } else {
                    serde_json::from_str(&raw).unwrap_or(json!({}))
                };
                let Some(block) = self.blocks.get_mut(&index) else {
                    return Vec::new();
                };
                block["input"] = input.clone();
                vec![Delta::ToolUse(ToolUse {
                    id: block["id"].as_str().unwrap_or_default().to_owned(),
                    name: block["name"].as_str().unwrap_or_default().to_owned(),
                    input,
                })]
            }
            "message_delta" => {
                if let Some(s) = v["delta"]["stop_reason"].as_str() {
                    self.stop_reason = Some(s.to_owned());
                }
                if let Some(n) = u32_of(&v["usage"]["output_tokens"]) {
                    self.usage.output_tokens = n;
                }
                Vec::new()
            }
            "message_stop" => self.finish(),
            "error" => vec![Delta::Error(
                v["error"]["message"]
                    .as_str()
                    .unwrap_or("unknown error")
                    .to_owned(),
            )],
            _ => Vec::new(),
        }
    }

    /// The trailing deltas: usage, the replayable turn, then the stop reason.
    fn finish(&mut self) -> Vec<Delta> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        let blocks: Vec<Value> = std::mem::take(&mut self.blocks).into_values().collect();
        vec![
            Delta::Usage(self.usage),
            Delta::Assistant(Turn {
                role: Role::Assistant,
                content: Value::Array(blocks),
                meta: None,
            }),
            Delta::Done(
                self.stop_reason
                    .take()
                    .unwrap_or_else(|| "end_turn".to_owned()),
            ),
        ]
    }
}

fn index_of(v: &Value) -> usize {
    usize::try_from(v["index"].as_u64().unwrap_or(0)).unwrap_or(0)
}

fn append(block: Option<&mut Value>, key: &str, text: &str) {
    if let Some(Value::String(s)) = block.and_then(|b| b.get_mut(key)) {
        s.push_str(text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Role, ToolSpec, Turn};

    #[test]
    fn body_has_current_api_shape() {
        let mut r = Request::new("be brief", vec![Turn::text(Role::User, "hi")]);
        let b = body(&r);
        assert_eq!(b["model"], crate::DEFAULT_MODEL);
        assert_eq!(b["thinking"]["type"], "adaptive");
        assert_eq!(b["thinking"]["display"], "summarized");
        assert_eq!(b["fallbacks"], "default");
        assert_eq!(b["stream"], true);
        assert!(b.get("temperature").is_none());
        assert!(b.get("tools").is_none());
        // Default effort sends nothing and lets the API choose.
        assert!(b.get("output_config").is_none());
        assert_eq!(b["system"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(b["messages"][0]["role"], "user");
        r.tools.push(ToolSpec {
            name: "t".into(),
            description: "d".into(),
            input_schema: json!({"type": "object"}),
        });
        r.effort = Effort::Max;
        let b = body(&r);
        assert_eq!(b["tools"][0]["name"], "t");
        assert_eq!(b["output_config"]["effort"], "max");
    }

    #[test]
    #[allow(clippy::too_many_lines)] // One end-to-end parser fixture is easier to audit in order.
    fn parses_text_thinking_and_tool_use_into_a_replayable_turn() {
        let mut st = StreamState::default();
        assert!(
            st.parse_event(
                "message_start",
                r#"{"message":{"usage":{"input_tokens":120,"cache_read_input_tokens":100}}}"#
            )
            .is_empty()
        );
        assert!(
            st.parse_event(
                "content_block_start",
                r#"{"index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}"#
            )
            .is_empty()
        );
        assert_eq!(
            st.parse_event(
                "content_block_delta",
                r#"{"index":0,"delta":{"type":"thinking_delta","thinking":"plan"}}"#
            ),
            vec![Delta::Reasoning("plan".into())]
        );
        assert!(
            st.parse_event(
                "content_block_delta",
                r#"{"index":0,"delta":{"type":"signature_delta","signature":"sig=="}}"#
            )
            .is_empty()
        );
        assert!(
            st.parse_event("content_block_stop", r#"{"index":0}"#)
                .is_empty()
        );

        assert!(
            st.parse_event(
                "content_block_start",
                r#"{"index":1,"content_block":{"type":"text","text":""}}"#
            )
            .is_empty()
        );
        assert_eq!(
            st.parse_event(
                "content_block_delta",
                r#"{"index":1,"delta":{"type":"text_delta","text":"Hel"}}"#
            ),
            vec![Delta::Text("Hel".into())]
        );
        assert_eq!(
            st.parse_event(
                "content_block_delta",
                r#"{"index":1,"delta":{"type":"text_delta","text":"lo"}}"#
            ),
            vec![Delta::Text("lo".into())]
        );

        assert!(st.parse_event("content_block_start", r#"{"index":2,"content_block":{"type":"tool_use","id":"tu_1","name":"page_click","input":{}}}"#).is_empty());
        assert!(
            st.parse_event(
                "content_block_delta",
                r#"{"index":2,"delta":{"type":"input_json_delta","partial_json":"{\"locator\":"}}"#
            )
            .is_empty()
        );
        assert!(
            st.parse_event(
                "content_block_delta",
                r#"{"index":2,"delta":{"type":"input_json_delta","partial_json":"\"text=Go\"}"}}"#
            )
            .is_empty()
        );
        let done = st.parse_event("content_block_stop", r#"{"index":2}"#);
        assert_eq!(
            done,
            vec![Delta::ToolUse(ToolUse {
                id: "tu_1".into(),
                name: "page_click".into(),
                input: json!({"locator": "text=Go"})
            })]
        );

        assert!(
            st.parse_event(
                "message_delta",
                r#"{"delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}"#
            )
            .is_empty()
        );
        let tail = st.parse_event("message_stop", "{}");
        assert_eq!(tail.len(), 3);
        assert_eq!(
            tail[0],
            Delta::Usage(Usage {
                input_tokens: 120,
                output_tokens: 42,
                cache_read_tokens: 100,
                cost_usd: None
            })
        );
        let Delta::Assistant(turn) = &tail[1] else {
            panic!("expected the assistant turn, got {:?}", tail[1]);
        };
        assert_eq!(turn.role, Role::Assistant);
        // In order, with the thinking block and its signature intact.
        assert_eq!(turn.content[0]["type"], "thinking");
        assert_eq!(turn.content[0]["thinking"], "plan");
        assert_eq!(turn.content[0]["signature"], "sig==");
        assert_eq!(turn.content[1], json!({"type": "text", "text": "Hello"}));
        assert_eq!(turn.content[2]["type"], "tool_use");
        assert_eq!(turn.content[2]["input"], json!({"locator": "text=Go"}));
        assert_eq!(tail[2], Delta::Done("tool_use".into()));

        // A second stop is not a second turn.
        assert!(st.parse_event("message_stop", "{}").is_empty());
    }

    #[test]
    fn errors_and_unknown_events() {
        let mut st = StreamState::default();
        assert_eq!(
            st.parse_event(
                "error",
                r#"{"error":{"type":"overloaded_error","message":"busy"}}"#
            ),
            vec![Delta::Error("busy".into())]
        );
        assert!(st.parse_event("ping", "{}").is_empty());
        assert!(st.parse_event("content_block_delta", "not json").is_empty());
    }

    #[test]
    fn model_listing_is_read() {
        let models = parse_models(&json!({"data": [
            {"id": "claude-opus-5", "display_name": "Claude Opus 5", "max_input_tokens": 1_000_000},
            {"id": "claude-haiku-4-5", "display_name": "Claude Haiku 4.5"}
        ]}));
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].name, "Claude Opus 5");
        assert_eq!(models[0].context_length, Some(1_000_000));
        assert_eq!(models[0].tools, Some(true));
        assert!(parse_models(&json!({})).is_empty());
    }
}
