//! The tools the sidecar agent may call: the same surface as the MCP server,
//! executed through the `Browser` implementation. Every call is reported to
//! the chrome so the Trace tab shows what the agent did.

use base64::Engine as _;
use dive_agent::{ToolResult, ToolSpec, ToolUse};
use dive_core::TabId;
use dive_mcp::{
    AppearanceParams, Browser, DialogParams, ResizeParams, SelectParams, Target, WaitForParams,
};
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
    let tab = json!({"type": "string", "description": "Only when working on another tab: its id from tabs_list. Leave it out for the current tab."});
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
            "page_hover",
            "Move the pointer over an element without clicking: hover menus, tooltips, :hover styles. Same locator, ref or x/y as page_click.".into(),
            obj(json!({"tab_id": tab, "locator": locator, "ref": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}}), &[]),
        ),
        spec(
            "page_select",
            "Choose an option in a <select> dropdown by value or visible label; clicking a native dropdown opens a menu that cannot be seen.".into(),
            obj(json!({"tab_id": tab, "locator": locator, "ref": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}, "value": {"type": "string"}, "label": {"type": "string"}}), &[]),
        ),
        spec(
            "page_fill_form",
            "Fill several fields in one call: fields is a list of {locator, value}, filled in order. Handles text fields, dropdowns and checkboxes; for a checkbox pass \"true\" or \"false\". Prefer this over repeated page_type -- one round trip for the whole form.".into(),
            obj(json!({"tab_id": tab, "fields": {"type": "array", "items": {"type": "object", "properties": {"locator": locator, "value": {"type": "string"}}, "required": ["locator", "value"], "additionalProperties": false}}, "submit": {"type": "boolean", "description": "Press Enter in the last field once the form is filled."}}), &["fields"]),
        ),
        spec(
            "page_upload",
            "Attach files to an <input type=\"file\">, as the picker would. paths are absolute paths on this machine. A picker opened by a click cannot be driven, so go through the input.".into(),
            obj(json!({"tab_id": tab, "locator": locator, "paths": {"type": "array", "items": {"type": "string"}}}), &["paths"]),
        ),
        spec(
            "page_drag",
            "Drag one element onto another with the pointer held down: reorder a list, move a card, set a slider. Drives pointer events, which is what drag libraries listen for.".into(),
            obj(json!({"tab_id": tab, "from": locator, "to": locator}), &["from", "to"]),
        ),
        spec(
            "page_pdf",
            "Render the page to a PDF on disk and return the path. This is the print output rather than a screenshot -- text stays selectable and the page is laid out for paper -- so it is what an invoice, a report or a receipt should be captured with. Takes filename, landscape, paper (a3, a4, a5, letter, legal, tabloid), background and headers.".into(),
            obj(json!({"tab_id": tab, "filename": {"type": "string"}, "landscape": {"type": "boolean"}, "headers": {"type": "boolean"}, "paper": {"type": "string"}, "background": {"type": "boolean"}}), &[]),
        ),
        spec(
            "downloads",
            "The files downloaded so far, newest first, each with the path it landed at. Give wait_ms straight after clicking something that saves a file and it waits for the download to finish first.".into(),
            obj(json!({"limit": {"type": "integer"}, "wait_ms": {"type": "integer"}}), &[]),
        ),
        spec(
            "page_expect",
            "Check several things about the page at once; every check that does not hold is reported, not just the first. A check is one of: visible, hidden, text, no_text, value {locator, equals}, count {locator, equals|at_least|at_most}, url_includes, title_includes. Give timeout_ms to keep re-checking until they hold. A failure says what was actually there.".into(),
            obj(json!({"tab_id": tab, "checks": {"type": "array", "items": {"type": "object", "properties": {"visible": locator, "hidden": locator, "text": {"type": "string"}, "no_text": {"type": "string"}, "value": {"type": "object", "properties": {"locator": locator, "equals": {"type": "string"}}, "required": ["locator", "equals"]}, "count": {"type": "object", "properties": {"locator": locator, "equals": {"type": "integer"}, "at_least": {"type": "integer"}, "at_most": {"type": "integer"}}, "required": ["locator"]}, "url_includes": {"type": "string"}, "title_includes": {"type": "string"}}, "additionalProperties": false}}, "timeout_ms": {"type": "integer"}}), &["checks"]),
        ),
        spec(
            "page_mouse",
            "Play a pointer gesture at viewport coordinates: steps is a list of {action, x, y} where action is move, down, up, click or wheel. The whole gesture is one call. Use page_click for anything a locator can name; this is for what it cannot -- canvases, maps, drawings, sliders with no accessible value.".into(),
            obj(json!({"tab_id": tab, "steps": {"type": "array", "items": {"type": "object", "properties": {"action": {"type": "string", "enum": ["move", "down", "up", "click", "wheel"]}, "x": {"type": "number"}, "y": {"type": "number"}, "button": {"type": "string", "enum": ["left", "right", "middle"]}, "delta_x": {"type": "number"}, "delta_y": {"type": "number"}, "delay_ms": {"type": "integer"}}, "required": ["action"], "additionalProperties": false}}}), &["steps"]),
        ),
        spec(
            "page_storage",
            "Everything this site keeps on this machine in one call: cookies, localStorage and sessionStorage. What it returns is what page_storage_set takes, so a signed-in session can be read once and restored later without logging in again.".into(),
            obj(json!({"tab_id": tab, "include": {"type": "array", "items": {"type": "string", "enum": ["cookies", "local", "session"]}}}), &[]),
        ),
        spec(
            "page_storage_set",
            "Add or replace cookies, localStorage and sessionStorage for this page. The page reads them on its next load, so reload afterwards.".into(),
            obj(json!({"tab_id": tab, "cookies": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "value": {"type": "string"}, "domain": {"type": "string"}, "path": {"type": "string"}, "expires": {"type": "number"}, "http_only": {"type": "boolean"}, "secure": {"type": "boolean"}, "same_site": {"type": "string"}}, "required": ["name", "value"]}}, "local": {"type": "object", "additionalProperties": {"type": "string"}}, "session": {"type": "object", "additionalProperties": {"type": "string"}}}), &[]),
        ),
        spec(
            "page_storage_clear",
            "Throw away this page's cookies, localStorage and sessionStorage, or the subset named in clear. Use it to check a first visit or a signed-out state.".into(),
            obj(json!({"tab_id": tab, "clear": {"type": "array", "items": {"type": "string", "enum": ["cookies", "local", "session"]}}}), &[]),
        ),
        spec(
            "tab_history",
            "Go back, go forward or reload the tab; then page_wait_for load true.".into(),
            obj(json!({"tab_id": tab, "action": {"type": "string", "enum": ["back", "forward", "reload"]}}), &["action"]),
        ),
        spec(
            "page_dialog",
            "Answer the JavaScript dialog the page has open (alert, confirm, prompt or a leave-page question); page_inspect shows it under dialog. accept true presses OK or Leave, false Cancel or Stay; text is what a prompt receives.".into(),
            obj(json!({"tab_id": tab, "accept": {"type": "boolean"}, "text": {"type": "string"}}), &[]),
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
            | "page_dialog"
            | "page_hover"
            | "page_select"
            | "page_fill_form"
            | "page_upload"
            | "page_drag"
            | "page_mouse"
            | "page_pdf"
            | "page_storage_set"
            | "page_storage_clear"
            | "tab_history"
            | "tab_navigate"
            | "tab_activate"
            | "tab_close"
            | "rules_set"
    )
}

/// The `tab_id` argument, or `None` when it is absent or blank. Small models
/// send `"tab_id": ""` for "the current tab"; that must not fail the call.
fn tab_argument(input: &Value) -> Option<&str> {
    input["tab_id"]
        .as_str()
        .map(str::trim)
        .filter(|id| !id.is_empty())
}

/// Which tab a call means. A real id wins; anything else falls back to the
/// tab the agent is working on, because a string that is not an id at all is
/// the model echoing the schema ("`any_tab_id_from_tabs_list`"), not a choice.
fn resolve_tab(argument: Option<&str>, current: Option<TabId>) -> Result<TabId, String> {
    match (argument.map(str::parse::<TabId>), current) {
        (Some(Ok(id)), _) => Ok(id),
        (Some(Err(_)) | None, Some(current)) => Ok(current),
        (Some(Err(_)), None) => Err(format!(
            "bad tab id {}: pass an id from tabs_list, or leave tab_id out for the current tab",
            argument.unwrap_or_default()
        )),
        (None, None) => Err("no current tab".to_owned()),
    }
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

/// Refuse a model-chosen URL with a scheme the agent may not open. Page
/// content can steer the model, so `file:`, `data:`, the internal scheme and
/// the rest stop here as well as in the browser; a bare host or search term
/// is left for the browser to normalize.
fn web_url(url: String) -> Result<String, String> {
    if let Ok(parsed) = url::Url::parse(url.trim()) {
        crate::mcp::check_web_url(&parsed).map_err(err)?;
    }
    Ok(url)
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
    let tab = || resolve_tab(tab_argument(input), default_tab);
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
        "page_hover" => text(
            browser
                .page_hover(tab()?, target_of(input))
                .await
                .map_err(err)?,
        ),
        "page_fill_form" => text(
            browser
                .page_fill_form(
                    tab()?,
                    serde_json::from_value(json!({
                        "fields": input["fields"].clone(),
                        "submit": input["submit"].clone(),
                    }))
                    .map_err(|e| format!("fields must be a list of {{locator, value}}: {e}"))?,
                )
                .await
                .map_err(err)?,
        ),
        "page_upload" => text(
            browser
                .page_upload(
                    tab()?,
                    dive_mcp::UploadParams {
                        tab_id: None,
                        locator: input["locator"].as_str().map(str::to_owned),
                        paths: input["paths"]
                            .as_array()
                            .map(|a| {
                                a.iter()
                                    .filter_map(|v| v.as_str().map(str::to_owned))
                                    .collect()
                            })
                            .unwrap_or_default(),
                    },
                )
                .await
                .map_err(err)?,
        ),
        "page_drag" => text(
            browser
                .page_drag(
                    tab()?,
                    dive_mcp::DragParams {
                        tab_id: None,
                        from: input["from"].as_str().map(str::to_owned),
                        to: input["to"].as_str().map(str::to_owned),
                    },
                )
                .await
                .map_err(err)?,
        ),
        "page_pdf" => text(
            browser
                .page_pdf(
                    tab()?,
                    serde_json::from_value(json!({
                        "filename": input["filename"].clone(),
                        "landscape": input["landscape"].clone(),
                        "headers": input["headers"].clone(),
                        "paper": input["paper"].clone(),
                        "background": input["background"].clone(),
                    }))
                    .map_err(|e| format!("the PDF options are not the right shape: {e}"))?,
                )
                .await
                .map_err(err)?,
        ),
        "downloads" => text(
            browser
                .downloads(
                    serde_json::from_value(json!({
                        "limit": input["limit"].clone(),
                        "wait_ms": input["wait_ms"].clone(),
                    }))
                    .map_err(|e| format!("limit and wait_ms must be numbers: {e}"))?,
                )
                .await
                .map_err(err)?,
        ),
        "page_expect" => text(
            browser
                .page_expect(
                    tab()?,
                    serde_json::from_value(json!({
                        "checks": input["checks"].clone(),
                        "timeout_ms": input["timeout_ms"].clone(),
                    }))
                    .map_err(|e| {
                        format!("checks must be a list of single-condition objects: {e}")
                    })?,
                )
                .await
                .map_err(err)?,
        ),
        "page_mouse" => text(
            browser
                .page_mouse(
                    tab()?,
                    serde_json::from_value(json!({"steps": input["steps"].clone()}))
                        .map_err(|e| format!("steps must be a list of {{action, x, y}}: {e}"))?,
                )
                .await
                .map_err(err)?,
        ),
        "page_storage" => text(
            browser
                .page_storage_get(
                    tab()?,
                    serde_json::from_value(json!({"include": input["include"].clone()})).map_err(
                        |e| format!("include must be a list of cookies/local/session: {e}"),
                    )?,
                )
                .await
                .map_err(err)?,
        ),
        "page_storage_set" => text(
            browser
                .page_storage_set(
                    tab()?,
                    serde_json::from_value(json!({
                        "cookies": input["cookies"].clone(),
                        "local": input["local"].clone(),
                        "session": input["session"].clone(),
                    }))
                    .map_err(|e| {
                        format!(
                            "cookies, local and session must be the shape page_storage returns: {e}"
                        )
                    })?,
                )
                .await
                .map_err(err)?,
        ),
        "page_storage_clear" => text(
            browser
                .page_storage_clear(
                    tab()?,
                    serde_json::from_value(json!({"clear": input["clear"].clone()})).map_err(
                        |e| format!("clear must be a list of cookies/local/session: {e}"),
                    )?,
                )
                .await
                .map_err(err)?,
        ),
        "page_select" => text(
            browser
                .page_select(
                    tab()?,
                    SelectParams {
                        tab_id: None,
                        target: target_of(input),
                        value: input["value"].as_str().map(str::to_owned),
                        label: input["label"].as_str().map(str::to_owned),
                    },
                )
                .await
                .map_err(err)?,
        ),
        "tab_history" => text(browser.history(tab()?, s("action")?).await.map_err(err)?),
        "page_dialog" => text(
            browser
                .page_dialog(
                    tab()?,
                    DialogParams {
                        tab_id: None,
                        accept: input["accept"].as_bool(),
                        text: input["text"].as_str().map(str::to_owned),
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
            .navigate(tab()?, web_url(s("url")?)?)
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
    fn a_blank_tab_id_means_the_current_tab() {
        use serde_json::json;
        assert_eq!(super::tab_argument(&json!({"tab_id": ""})), None);
        assert_eq!(super::tab_argument(&json!({"tab_id": "  "})), None);
        assert_eq!(super::tab_argument(&json!({})), None);
        assert_eq!(super::tab_argument(&json!({"tab_id": "abc"})), Some("abc"));
    }

    #[test]
    fn a_string_that_is_not_an_id_means_the_current_tab() {
        let current: dive_core::TabId = "01a08307-7720-7843-a80f-583734dbeecd".parse().unwrap();
        let other: dive_core::TabId = "01a082ec-5bb7-7af3-9d1d-fad7b38a1c71".parse().unwrap();
        assert_eq!(super::resolve_tab(None, Some(current)), Ok(current));
        assert_eq!(
            super::resolve_tab(Some("any_tab_id_from_tabs_list"), Some(current)),
            Ok(current)
        );
        assert_eq!(
            super::resolve_tab(Some(&other.to_string()), Some(current)),
            Ok(other)
        );
        let error = super::resolve_tab(Some("nope"), None).unwrap_err();
        assert!(error.contains("tabs_list"), "{error}");
        assert_eq!(
            super::resolve_tab(None, None).unwrap_err(),
            "no current tab"
        );
    }

    #[test]
    fn the_agent_may_only_navigate_to_web_urls() {
        for ok in [
            "https://example.test/",
            "http://localhost:3000",
            "about:blank",
            "example.test",
            "cats",
        ] {
            assert!(super::web_url(ok.into()).is_ok(), "{ok}");
        }
        for bad in [
            "file:///etc/passwd",
            "data:text/html,<script>1</script>",
            "blob:https://x/1",
            "about:srcdoc",
            "javascript:alert(1)",
            "dive://settings",
        ] {
            let error = super::web_url(bad.into()).expect_err(bad);
            assert!(error.contains("not allowed"), "{bad}: {error}");
        }
    }

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
