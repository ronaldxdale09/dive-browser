//! The tools the sidecar agent may call: the same surface as the MCP server,
//! executed through the `Browser` implementation. Every call is reported to
//! the chrome so the Trace tab shows what the agent did.

use base64::Engine as _;
use dive_agent::{ToolResult, ToolSpec, ToolUse};
use dive_core::TabId;
use dive_mcp::{AppearanceParams, Browser, ResizeParams, Target, WaitForParams};
use serde_json::{Value, json};

const MAX_AGENT_SCREENSHOT_BYTES: usize = 8 * 1024 * 1024;

/// Tools offered to the model. Kept small and described for a developer's
/// page: read cheaply first, act only when asked.
///
/// Elements are addressed by locator rather than by the `[ref=eN]` ids
/// `page_state` hands out. A ref is a DOM node id that goes stale on the next
/// render, so an agent that read the tree and then acted would click the
/// wrong thing after any update; a locator is resolved when the action runs.
#[allow(clippy::too_many_lines)] // Keeping the complete model-visible tool catalog together makes it auditable.
pub fn specs() -> Vec<ToolSpec> {
    let tab = json!({"type": "string", "description": "Tab id from tabs_list; omit for the current tab."});
    let locator = json!({
        "type": "string",
        "description": format!("Element locator. {}", dive_mcp::LOCATOR_GRAMMAR),
    });
    let obj = |props: Value, required: &[&str]| json!({"type": "object", "properties": props, "required": required, "additionalProperties": false});
    let spec = |name: &str, description: String, schema: Value| ToolSpec {
        name: name.to_owned(),
        description,
        input_schema: schema,
    };
    vec![
        spec("tabs_list", "List open tabs with ids, URLs and titles.".into(), obj(json!({}), &[])),
        spec(
            "page_inspect",
            "Everything about the page in one call: URL, title, loading state, visible text, every interactive element with the locator that addresses it, recent console warnings and errors, failed requests, and what you have already done to this tab. Start here.".into(),
            obj(json!({"tab_id": tab}), &[]),
        ),
        spec("page_text", "Visible text of the page. Cheapest way to read it.".into(), obj(json!({"tab_id": tab}), &[])),
        spec("page_markdown", "The page as Markdown: headings, absolute link targets, lists, tables and form state. Costs about what page_text costs but keeps the structure, so prefer it when deciding where to click or navigate next.".into(), obj(json!({"tab_id": tab}), &[])),
        spec(
            "page_state",
            "Accessibility tree as indented text. page_inspect is usually the better read; use this when you need the full tree.".into(),
            obj(json!({"tab_id": tab}), &[]),
        ),
        spec(
            "page_screenshot",
            "Screenshot of the viewport, or of the whole page with full_page. Use only when layout matters.".into(),
            obj(json!({"tab_id": tab, "full_page": {"type": "boolean", "description": "Capture the entire scrollable page instead of the viewport."}}), &[]),
        ),
        spec(
            "page_click",
            "Click one element.".into(),
            obj(json!({"tab_id": tab, "locator": locator, "ref": {"type": "string", "description": "Legacy ref from page_state; prefer locator."}, "x": {"type": "number"}, "y": {"type": "number"}}), &[]),
        ),
        spec(
            "page_type",
            "Type into one field. Replaces the current value unless clear is false; submit presses Enter.".into(),
            obj(json!({"tab_id": tab, "locator": locator, "ref": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}, "text": {"type": "string"}, "clear": {"type": "boolean"}, "submit": {"type": "boolean"}}), &["text"]),
        ),
        spec(
            "page_press",
            "Press one key: Enter, Escape, Tab, ArrowDown, Backspace, or a single character. Modifiers are Meta, Control, Alt, Shift. Give a locator to focus an editable field first, or omit it to press against the focused element.".into(),
            obj(json!({"tab_id": tab, "locator": locator, "ref": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}, "key": {"type": "string"}, "modifiers": {"type": "array", "items": {"type": "string"}}}), &["key"]),
        ),
        spec(
            "page_scroll",
            "Scroll the page, or a container named by a locator. Positive delta_y scrolls down. Use this to reach content below the fold.".into(),
            obj(json!({"tab_id": tab, "locator": locator, "ref": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}, "delta_x": {"type": "number"}, "delta_y": {"type": "number"}}), &[]),
        ),
        spec(
            "page_wait_for",
            "Wait until every condition given holds: a locator matches, text appears, the URL contains a fragment, loading finishes. Call this after anything that starts work instead of guessing how long it takes.".into(),
            obj(json!({"tab_id": tab, "locator": locator, "text": {"type": "string"}, "url_includes": {"type": "string"}, "load": {"type": "boolean"}, "timeout_ms": {"type": "integer"}}), &[]),
        ),
        spec(
            "page_locate",
            "Describe what a locator matches without acting on it. Use it when a click reported nothing matched, or to check a locator is unambiguous.".into(),
            obj(json!({"tab_id": tab, "locator": locator}), &["locator"]),
        ),
        spec(
            "page_resize",
            "Resize the viewport to check responsive layout: a preset from page_devices, an exact width and height, or reset to fill the window.".into(),
            obj(json!({"tab_id": tab, "preset": {"type": "string"}, "width": {"type": "integer"}, "height": {"type": "integer"}, "orientation": {"type": "string", "enum": ["portrait", "landscape"]}, "ui": {"type": "string", "enum": ["browser", "standalone", "none"], "description": "What surrounds the page: the device's browser bars (default), an installed web app, or nothing."}, "reset": {"type": "boolean"}}), &[]),
        ),
        spec("page_devices", "Device presets page_resize accepts.".into(), obj(json!({}), &[])),
        spec(
            "page_appearance",
            "Emulate media preferences: color_scheme light or dark, reduced_motion reduce, media_type print, or display_mode standalone. Pass system to clear one.".into(),
            obj(json!({"tab_id": tab, "color_scheme": {"type": "string"}, "reduced_motion": {"type": "string"}, "media_type": {"type": "string"}, "display_mode": {"type": "string"}}), &[]),
        ),
        spec(
            "page_throttle",
            "Throttle the network to offline, slow-3g or fast-3g, or none to clear it.".into(),
            obj(json!({"tab_id": tab, "profile": {"type": "string"}}), &["profile"]),
        ),
        spec(
            "page_component",
            "The React component that rendered an element and the source file it is in. Needs a development build.".into(),
            obj(json!({"tab_id": tab, "locator": locator, "ref": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}}), &[]),
        ),
        spec("tab_navigate", "Navigate the tab to a URL.".into(), obj(json!({"tab_id": tab, "url": {"type": "string"}}), &["url"])),
        spec("tab_activate", "Bring a tab to the front so the person sees it.".into(), obj(json!({"tab_id": tab}), &[])),
        spec("tab_close", "Close a tab you opened.".into(), obj(json!({"tab_id": tab}), &[])),
        spec("console_tail", "Recent console output: logs, warnings, exceptions, failed loads.".into(), obj(json!({"tab_id": tab, "limit": {"type": "integer"}}), &[])),
        spec(
            "page_report",
            "Bug report for the tab: console errors/warnings and failed requests. Start here when something is broken.".into(),
            obj(json!({"tab_id": tab}), &[]),
        ),
        spec("rules_list", "Mock/rewrite rules of the workspace (URL globs that block, mock or add a header).".into(), obj(json!({}), &[])),
        spec(
            "rules_set",
            "Replace the workspace's mock/rewrite rules. Each: {id, pattern, enabled, action:{kind:'block'}|{kind:'mock',status,content_type,body}|{kind:'header',name,value}}. Empty list clears.".into(),
            obj(json!({"rules": {"type": "array", "items": {"type": "object"}}}), &["rules"]),
        ),
        spec("page_snapshot", "Remember the page state now so page_diff can report what changed later.".into(), obj(json!({"tab_id": tab}), &[])),
        spec("page_diff", "What changed since the last page_snapshot: text, structure, errors, requests.".into(), obj(json!({"tab_id": tab}), &[])),
        spec("network_list", "Recent requests with method, status, type, size and errors. No bodies; use network_body for one.".into(), obj(json!({"tab_id": tab, "limit": {"type": "integer"}}), &[])),
        spec(
            "network_body",
            "Captured JSON response body of one request (truncated to a few KB), or the recent frames of a WebSocket / event stream.".into(),
            obj(json!({"tab_id": tab, "request_id": {"type": "string"}}), &["request_id"]),
        ),
        spec("dev_servers", "Dev servers listening on this machine, with port, framework, page title, process and PID when the OS reports them.".into(), obj(json!({}), &[])),
    ]
}

/// MCP tools the sidecar agent is deliberately not offered, with the reason.
/// Everything else the server advertises the agent gets, and a test holds
/// the two catalogs to that.
#[cfg(test)]
pub const NOT_FOR_AGENT: &[(&str, &str)] = &[
    (
        "page_evaluate",
        "arbitrary JavaScript is behind the DIVE_MCP_ALLOW_EVAL opt-in; the agent gets typed tools",
    ),
    (
        "api_spec",
        "an OpenAPI export is a developer artefact to save, not something to reason over mid-task",
    ),
    (
        "dive_capabilities",
        "MCP clients ask what the server can do; the agent is told in its system prompt",
    ),
    (
        "tab_open",
        "the agent works in the tab the person is in; it may navigate it but not multiply tabs",
    ),
];

/// Tools that change the page or leave it; the UI labels these as actions.
pub fn is_action(name: &str) -> bool {
    matches!(
        name,
        "page_click"
            | "page_type"
            | "page_press"
            | "page_scroll"
            | "page_resize"
            | "page_appearance"
            | "page_throttle"
            | "tab_navigate"
            | "tab_activate"
            | "tab_close"
            | "rules_set"
    )
}

/// Run one tool call against the browser.
pub async fn run<B: Browser>(
    browser: &B,
    default_tab: Option<TabId>,
    call: &ToolUse,
) -> ToolResult {
    let outcome = execute(browser, default_tab, call).await;
    match outcome {
        Ok(content) => ToolResult {
            tool_use_id: call.id.clone(),
            content,
            is_error: false,
        },
        Err(message) => ToolResult {
            tool_use_id: call.id.clone(),
            content: Value::String(message),
            is_error: true,
        },
    }
}

/// Render a browser failure for the model.
///
/// The machine-readable tag and the retry hint go in the text: the sidecar
/// protocol has nowhere structured to put them, and "retryable: false" is
/// what stops a model from trying an unparseable locator four more times.
// `Result::map_err` consumes its error, while formatting only borrows it.
#[allow(clippy::needless_pass_by_value)]
fn err(e: dive_mcp::BrowserError) -> String {
    if e.retryable() {
        format!("{e} [{}]", e.code())
    } else {
        format!("{e} [{}, do not retry as-is]", e.code())
    }
}

/// Read the element target out of a call's arguments.
fn target_of(input: &Value) -> Target {
    Target {
        locator: input["locator"].as_str().map(str::to_owned),
        r#ref: input["ref"].as_str().map(str::to_owned),
        x: input["x"].as_f64(),
        y: input["y"].as_f64(),
    }
}

// Keeping the tool-name dispatch in one exhaustive match makes additions and
// schema/implementation drift straightforward to review.
#[allow(clippy::too_many_lines)]
async fn execute<B: Browser>(
    browser: &B,
    default_tab: Option<TabId>,
    call: &ToolUse,
) -> Result<Value, String> {
    let input = &call.input;
    let tab = || -> Result<TabId, String> {
        match input["tab_id"].as_str() {
            Some(id) => id.parse().map_err(|_| format!("bad tab id {id}")),
            None => default_tab.ok_or_else(|| "no current tab".to_owned()),
        }
    };
    let text = |v: Value| {
        Ok(Value::String(
            serde_json::to_string_pretty(&v).unwrap_or_default(),
        ))
    };
    let limit = || usize::try_from(input["limit"].as_u64().unwrap_or(50)).unwrap_or(50);
    let s = |key: &str| {
        input[key]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| format!("missing {key}"))
    };
    let strings = |key: &str| -> Vec<String> {
        input[key]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    };
    match call.name.as_str() {
        "tabs_list" => text(
            serde_json::to_value(browser.tabs().await.map_err(err)?).map_err(|e| e.to_string())?,
        ),
        "page_inspect" => text(browser.page_inspect(tab()?).await.map_err(err)?),
        "page_text" => browser
            .page_text(tab()?)
            .await
            .map(Value::String)
            .map_err(err),
        "page_markdown" => browser
            .page_markdown(tab()?)
            .await
            .map(Value::String)
            .map_err(err),
        "page_state" => browser
            .page_state(tab()?)
            .await
            .map(Value::String)
            .map_err(err),
        "page_screenshot" => {
            let full_page = input["full_page"].as_bool().unwrap_or(false);
            let png = browser.screenshot(tab()?, full_page).await.map_err(err)?;
            if png.len() > MAX_AGENT_SCREENSHOT_BYTES {
                return Err(format!(
                    "screenshot is over the {MAX_AGENT_SCREENSHOT_BYTES} byte agent limit; resize the page and try again"
                ));
            }
            Ok(
                json!([{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": base64::engine::general_purpose::STANDARD.encode(png)}}]),
            )
        }
        "page_click" => text(
            browser
                .page_click(tab()?, target_of(input))
                .await
                .map_err(err)?,
        ),
        "page_type" => text(
            browser
                .page_type(
                    tab()?,
                    target_of(input),
                    s("text")?,
                    input["clear"].as_bool().unwrap_or(true),
                    input["submit"].as_bool().unwrap_or(false),
                )
                .await
                .map_err(err)?,
        ),
        "page_press" => browser
            .page_press(tab()?, target_of(input), s("key")?, strings("modifiers"))
            .await
            .map(|()| Value::String("pressed".into()))
            .map_err(err),
        "page_scroll" => text(
            browser
                .page_scroll(
                    tab()?,
                    target_of(input),
                    input["delta_x"].as_f64().unwrap_or(0.0),
                    input["delta_y"].as_f64().unwrap_or(0.0),
                )
                .await
                .map_err(err)?,
        ),
        "page_wait_for" => text(
            browser
                .page_wait_for(
                    tab()?,
                    WaitForParams {
                        tab_id: None,
                        locator: input["locator"].as_str().map(str::to_owned),
                        text: input["text"].as_str().map(str::to_owned),
                        url_includes: input["url_includes"].as_str().map(str::to_owned),
                        load: input["load"].as_bool().unwrap_or(false),
                        timeout_ms: input["timeout_ms"].as_u64(),
                    },
                )
                .await
                .map_err(err)?,
        ),
        "page_locate" => text(
            browser
                .page_locate(tab()?, s("locator")?)
                .await
                .map_err(err)?,
        ),
        "page_resize" => text(
            browser
                .page_resize(
                    tab()?,
                    ResizeParams {
                        tab_id: None,
                        preset: input["preset"].as_str().map(str::to_owned),
                        width: input["width"].as_u64().and_then(|v| u32::try_from(v).ok()),
                        height: input["height"].as_u64().and_then(|v| u32::try_from(v).ok()),
                        orientation: input["orientation"].as_str().map(str::to_owned),
                        ui: input["ui"].as_str().map(str::to_owned),
                        reset: input["reset"].as_bool().unwrap_or(false),
                    },
                )
                .await
                .map_err(err)?,
        ),
        "page_devices" => text(browser.page_devices().await.map_err(err)?),
        "page_appearance" => text(
            browser
                .page_appearance(
                    tab()?,
                    AppearanceParams {
                        tab_id: None,
                        color_scheme: input["color_scheme"].as_str().map(str::to_owned),
                        reduced_motion: input["reduced_motion"].as_str().map(str::to_owned),
                        media_type: input["media_type"].as_str().map(str::to_owned),
                        display_mode: input["display_mode"].as_str().map(str::to_owned),
                    },
                )
                .await
                .map_err(err)?,
        ),
        "page_throttle" => text(
            browser
                .page_throttle(tab()?, s("profile")?)
                .await
                .map_err(err)?,
        ),
        "page_component" => text(
            browser
                .page_component(tab()?, target_of(input))
                .await
                .map_err(err)?,
        ),
        "tab_close" => browser
            .close(tab()?)
            .await
            .map(|()| Value::String("closed".into()))
            .map_err(err),
        "tab_activate" => browser
            .activate(tab()?)
            .await
            .map(|()| Value::String("activated".into()))
            .map_err(err),
        "tab_navigate" => browser
            .navigate(tab()?, s("url")?)
            .await
            .map(|()| Value::String("navigating".into()))
            .map_err(err),
        "page_report" => browser
            .page_report(tab()?)
            .await
            .map(Value::String)
            .map_err(err),
        "rules_list" => text(browser.rules().await.map_err(err)?),
        "rules_set" => browser
            .set_rules(input["rules"].clone())
            .await
            .map(|()| Value::String("rules applied".into()))
            .map_err(err),
        "page_snapshot" => browser
            .page_snapshot(tab()?)
            .await
            .map(Value::String)
            .map_err(err),
        "page_diff" => Ok(Value::String(
            browser.page_diff(tab()?).await.map_err(err)?["summary"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        )),
        "console_tail" => text(browser.console_tail(tab()?, limit()).await.map_err(err)?),
        "network_list" => text(browser.requests(tab()?, limit()).await.map_err(err)?),
        "network_body" => text(
            browser
                .request_body(tab()?, s("request_id")?)
                .await
                .map_err(err)?,
        ),
        "dev_servers" => text(browser.dev_servers().await.map_err(err)?),
        other => Err(format!("unknown tool {other}")),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_agent_catalog_is_the_mcp_catalog_minus_documented_exceptions() {
        use std::collections::{BTreeSet, HashMap};
        let mcp: HashMap<String, dive_mcp::CatalogEntry> = dive_mcp::tool_catalog()
            .into_iter()
            .map(|e| (e.name.clone(), e))
            .collect();
        let props = |schema: &Value| -> BTreeSet<String> {
            schema["properties"]
                .as_object()
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_default()
        };
        let offered: BTreeSet<String> = specs().into_iter().map(|s| s.name).collect();
        let mut drift = Vec::new();
        for spec in specs() {
            let entry = mcp.get(&spec.name).unwrap_or_else(|| {
                panic!(
                    "{} is offered to the agent but is not an MCP tool",
                    spec.name
                )
            });
            let (agent, server) = (props(&spec.input_schema), props(&entry.input_schema));
            if agent != server {
                drift.push(format!(
                    "{}: agent {agent:?} vs server {server:?}",
                    spec.name
                ));
            }
        }
        assert!(
            drift.is_empty(),
            "the agent's parameters drifted from the server's:\n{}",
            drift.join("\n")
        );
        for name in mcp.keys() {
            assert!(
                offered.contains(name) || NOT_FOR_AGENT.iter().any(|(n, _)| n == name),
                "{name} is an MCP tool the agent neither offers nor documents as excluded"
            );
        }
        for (name, why) in NOT_FOR_AGENT {
            assert!(
                mcp.contains_key(*name),
                "{name} is excluded but no longer exists"
            );
            assert!(
                !offered.contains(*name),
                "{name} is both offered and excluded"
            );
            assert!(!why.is_empty());
        }
    }

    use super::*;

    #[test]
    fn specs_are_well_formed() {
        let specs = specs();
        assert!(specs.iter().any(|s| s.name == "page_state"));
        for s in &specs {
            assert_eq!(s.input_schema["type"], "object");
            assert_eq!(s.input_schema["additionalProperties"], false);
            assert!(!s.description.is_empty(), "{} has no description", s.name);
        }
        let mut names: Vec<&str> = specs.iter().map(|s| s.name.as_str()).collect();
        let total = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), total, "a tool name is declared twice");
    }

    #[test]
    fn every_spec_is_dispatchable_and_every_action_is_labelled() {
        // A spec with no arm in `execute` is a tool the model can call and
        // always get "unknown tool" from.
        let dispatch = include_str!("agent_tools.rs");
        for spec in specs() {
            assert!(
                dispatch.contains(&format!("\"{}\" =>", spec.name)),
                "{} is offered but not dispatched",
                spec.name
            );
        }
        for name in [
            "page_click",
            "page_type",
            "page_press",
            "page_scroll",
            "tab_navigate",
        ] {
            assert!(
                is_action(name),
                "{name} changes the page but is not labelled"
            );
        }
        for name in [
            "page_text",
            "page_markdown",
            "page_inspect",
            "page_locate",
            "page_devices",
        ] {
            assert!(!is_action(name), "{name} only reads");
        }
    }

    #[test]
    fn the_locator_grammar_reaches_the_model() {
        // The model has to learn the syntax from somewhere; the schema is it.
        let click = specs()
            .into_iter()
            .find(|s| s.name == "page_click")
            .unwrap();
        let described = click.input_schema["properties"]["locator"]["description"]
            .as_str()
            .unwrap();
        assert!(described.contains("role=button"), "{described}");
        assert!(described.contains(">>"), "{described}");
    }

    #[test]
    fn targets_read_all_three_addressing_modes() {
        let by_locator = target_of(&json!({"locator": "text=Go"}));
        assert_eq!(by_locator.locator.as_deref(), Some("text=Go"));

        let by_ref = target_of(&json!({"ref": "e3"}));
        assert_eq!(by_ref.r#ref.as_deref(), Some("e3"));

        let by_point = target_of(&json!({"x": 4.0, "y": 5.0}));
        assert_eq!((by_point.x, by_point.y), (Some(4.0), Some(5.0)));

        // Nothing given is left for `Target::resolve` to reject with a
        // message, rather than being silently turned into (0, 0).
        let empty = target_of(&json!({}));
        assert!(empty.resolve().is_err());
    }

    #[test]
    fn failures_tell_the_model_whether_retrying_is_worth_it() {
        let transient = err(dive_mcp::BrowserError::NotEnabled {
            locator: "text=Save".into(),
        });
        assert!(transient.contains("not_enabled"), "{transient}");
        assert!(
            !transient.contains("do not retry"),
            "a disabled button may become enabled: {transient}"
        );

        let permanent = err(dive_mcp::BrowserError::InvalidSelector {
            locator: "role=".into(),
            reason: "no role name".into(),
        });
        assert!(permanent.contains("do not retry"), "{permanent}");
    }
}
