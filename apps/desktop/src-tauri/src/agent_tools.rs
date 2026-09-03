//! The tools the sidecar agent may call: the same surface as the MCP server,
//! executed through the `Browser` implementation. Every call is reported to
//! the chrome so the Trace tab shows what the agent did.

use base64::Engine as _;
use dive_agent::{ToolResult, ToolSpec, ToolUse};
use dive_core::TabId;
use dive_mcp::Browser;
use serde_json::{Value, json};

/// Tools offered to the model. Kept small and described for a developer's
/// page: read cheaply first, act only when asked.
pub fn specs() -> Vec<ToolSpec> {
    let tab = json!({"type": "string", "description": "Tab id from tabs_list; omit for the current tab."});
    let obj = |props: Value, required: &[&str]| json!({"type": "object", "properties": props, "required": required, "additionalProperties": false});
    vec![
        ToolSpec { name: "tabs_list".into(), description: "List open tabs with ids, URLs and titles.".into(), input_schema: obj(json!({}), &[]) },
        ToolSpec { name: "page_text".into(), description: "Visible text of the page. Cheapest way to read it.".into(), input_schema: obj(json!({"tab_id": tab}), &[]) },
        ToolSpec { name: "page_state".into(), description: "Accessibility tree with [ref=eN] ids on interactive elements. Call before clicking or typing.".into(), input_schema: obj(json!({"tab_id": tab}), &[]) },
        ToolSpec { name: "page_screenshot".into(), description: "Screenshot of the viewport. Use only when layout matters.".into(), input_schema: obj(json!({"tab_id": tab}), &[]) },
        ToolSpec { name: "page_click".into(), description: "Click the element behind a ref from page_state.".into(), input_schema: obj(json!({"tab_id": tab, "ref": {"type": "string"}}), &["ref"]) },
        ToolSpec { name: "page_type".into(), description: "Replace the text of a field behind a ref; submit presses Enter.".into(), input_schema: obj(json!({"tab_id": tab, "ref": {"type": "string"}, "text": {"type": "string"}, "submit": {"type": "boolean"}}), &["ref", "text"]) },
        ToolSpec { name: "tab_navigate".into(), description: "Navigate the tab to a URL.".into(), input_schema: obj(json!({"tab_id": tab, "url": {"type": "string"}}), &["url"]) },
        ToolSpec { name: "console_tail".into(), description: "Recent console output: logs, warnings, exceptions, failed loads.".into(), input_schema: obj(json!({"tab_id": tab, "limit": {"type": "integer"}}), &[]) },
        ToolSpec { name: "page_snapshot".into(), description: "Remember the page state now so page_diff can report what changed later.".into(), input_schema: obj(json!({"tab_id": tab}), &[]) },
        ToolSpec { name: "page_diff".into(), description: "What changed since the last page_snapshot: text, structure, errors, requests.".into(), input_schema: obj(json!({"tab_id": tab}), &[]) },
        ToolSpec { name: "network_list".into(), description: "Recent requests with method, status, type, size and errors.".into(), input_schema: obj(json!({"tab_id": tab, "limit": {"type": "integer"}}), &[]) },
    ]
}

/// Tools that change the page or leave it; the UI labels these as actions.
pub fn is_action(name: &str) -> bool {
    matches!(name, "page_click" | "page_type" | "tab_navigate")
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
    match call.name.as_str() {
        "tabs_list" => text(
            serde_json::to_value(browser.tabs().await.map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?,
        ),
        "page_text" => Ok(Value::String(
            browser.page_text(tab()?).await.map_err(|e| e.to_string())?,
        )),
        "page_state" => Ok(Value::String(
            browser
                .page_state(tab()?)
                .await
                .map_err(|e| e.to_string())?,
        )),
        "page_screenshot" => {
            let png = browser
                .screenshot(tab()?, false)
                .await
                .map_err(|e| e.to_string())?;
            Ok(
                json!([{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": base64::engine::general_purpose::STANDARD.encode(png)}}]),
            )
        }
        "page_click" => browser
            .page_click(tab()?, s("ref")?)
            .await
            .map(|()| Value::String("clicked".into()))
            .map_err(|e| e.to_string()),
        "page_type" => browser
            .page_type(
                tab()?,
                s("ref")?,
                s("text")?,
                input["submit"].as_bool().unwrap_or(false),
            )
            .await
            .map(|()| Value::String("typed".into()))
            .map_err(|e| e.to_string()),
        "tab_navigate" => browser
            .navigate(tab()?, s("url")?)
            .await
            .map(|()| Value::String("navigating".into()))
            .map_err(|e| e.to_string()),
        "page_snapshot" => Ok(Value::String(
            browser
                .page_snapshot(tab()?)
                .await
                .map_err(|e| e.to_string())?,
        )),
        "page_diff" => Ok(Value::String(
            browser.page_diff(tab()?).await.map_err(|e| e.to_string())?["summary"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        )),
        "console_tail" => text(
            browser
                .console_tail(tab()?, limit())
                .await
                .map_err(|e| e.to_string())?,
        ),
        "network_list" => text(
            browser
                .requests(tab()?, limit())
                .await
                .map_err(|e| e.to_string())?,
        ),
        other => Err(format!("unknown tool {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_are_well_formed() {
        let specs = specs();
        assert!(specs.iter().any(|s| s.name == "page_state"));
        for s in &specs {
            assert_eq!(s.input_schema["type"], "object");
            assert_eq!(s.input_schema["additionalProperties"], false);
        }
        assert!(is_action("page_click") && !is_action("page_text"));
    }
}
