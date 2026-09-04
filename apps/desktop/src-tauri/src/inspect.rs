//! Point at something on the page and find out what it is.
//!
//! Dive could already annotate a *screenshot*: boxes and arrows on a picture.
//! That describes a symptom. This describes the cause — the element, the React
//! component that rendered it, and the source file that component is in — so
//! "this button is the wrong colour" arrives as `<SubmitButton>` at
//! `src/components/Form.tsx:42` instead of a PNG.
//!
//! Style experiments go through here too. Nudging a property applies it
//! inline and records what it replaced, so what reaches an agent is a
//! before/after diff it can turn into a CSS change rather than a screenshot
//! of the result.
//!
//! The page talks back through a CDP binding, and every payload carries a
//! nonce the picker was installed with. Without that check any page could
//! call the binding itself and hand the chrome a fabricated pick pointing at
//! a source file the user never opened.

use std::collections::HashMap;
use std::sync::Mutex;

use dive_cdp::{CdpEvent, CdpSession};
use dive_core::TabId;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::Runtime;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// Name of the binding the picker script calls.
const BINDING: &str = "__diveInspect";
/// A page can call a CDP binding directly, so refuse pathological payloads
/// before asking the JSON parser to allocate for them.
const MAX_BINDING_PAYLOAD: usize = 1024 * 1024;
const MAX_STYLE_PROPERTY_CHARS: usize = 128;
const MAX_STYLE_VALUE_CHARS: usize = 4096;

/// One frame of a component's source location.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SourceFrame {
    /// Component or function name, when known.
    pub function_name: Option<String>,
    /// File as the bundle reports it.
    pub file_name: String,
    /// 1-based line.
    pub line_number: Option<u32>,
    /// 1-based column.
    pub column_number: Option<u32>,
}

/// A style the person changed on the picked element.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct StyleChange {
    /// CSS property.
    pub property: String,
    /// What it was before, computed or inline.
    #[serde(alias = "previousValue")]
    pub previous_value: String,
    /// What it is now.
    pub value: String,
    /// CSS path of the element it applies to.
    pub selector: Option<String>,
    /// Locator for the element, which survives a re-render.
    pub locator: Option<String>,
    /// Component that rendered it, when known.
    #[serde(alias = "componentName")]
    pub component_name: Option<String>,
}

/// What the picker found.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Pick {
    /// Tab it came from.
    pub tab_id: TabId,
    /// Page URL at the time.
    pub page_url: String,
    /// Page title at the time.
    pub page_title: Option<String>,
    /// Lowercased tag name.
    pub tag_name: String,
    /// ARIA role, when it has one.
    pub role: String,
    /// Accessible name.
    pub name: String,
    /// CSS path.
    pub selector: Option<String>,
    /// Locator that addresses it, for handing to an agent.
    pub locator: Option<String>,
    /// First 500 characters of `outerHTML`.
    pub html_preview: String,
    /// A readable dump of the properties worth knowing.
    pub styles: String,
    /// React component, when the page is a development React build.
    pub component_name: Option<String>,
    /// Where that component is defined, as the bundle reports it.
    pub source: Option<SourceFrame>,
    /// The owner chain above it.
    pub stack: Vec<SourceFrame>,
    /// Component names from the element outwards.
    pub owners: Vec<String>,
    /// Where `source` maps to once source maps are applied.
    pub source_resolved: Option<crate::sourcemaps::Original>,
    /// RFC 3339 pick time.
    pub picked_at: String,
}

/// Emitted when the person picks an element or cancels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, Event)]
pub struct InspectEvent {
    /// Tab the picker was running in.
    pub tab_id: TabId,
    /// `picked` or `cancelled`.
    pub kind: String,
    /// The pick, when there is one.
    pub pick: Option<Pick>,
}

/// Per-tab picker state.
#[derive(Default)]
struct TabInspector {
    /// Nonce the trusted picker script embeds in its payloads.
    nonce: Option<String>,
    /// The last element picked in this tab.
    pick: Option<Pick>,
    /// Style experiments on it.
    changes: Vec<StyleChange>,
}

/// Picks and style experiments, per tab.
#[derive(Default)]
pub struct Registry {
    inner: Mutex<HashMap<TabId, TabInspector>>,
}

impl Registry {
    fn with<T>(&self, f: impl FnOnce(&mut HashMap<TabId, TabInspector>) -> T) -> T {
        f(&mut lock(&self.inner))
    }

    /// The nonce for a tab, if a picker has been installed there.
    fn nonce(&self, tab: TabId) -> Option<String> {
        self.with(|m| m.get(&tab).and_then(|t| t.nonce.clone()))
    }

    /// The most recent pick in a tab.
    pub fn pick(&self, tab: TabId) -> Option<Pick> {
        self.with(|m| m.get(&tab).and_then(|t| t.pick.clone()))
    }

    /// Style experiments recorded against the current pick.
    pub fn changes(&self, tab: TabId) -> Vec<StyleChange> {
        self.with(|m| m.get(&tab).map(|t| t.changes.clone()).unwrap_or_default())
    }

    /// Picking or inspecting content and unsaved style edits protect the page.
    pub fn active(&self, tab: TabId) -> bool {
        self.with(|m| {
            m.get(&tab)
                .is_some_and(|t| t.nonce.is_some() || t.pick.is_some() || !t.changes.is_empty())
        })
    }

    /// Forget a closed tab.
    pub fn drop_tab(&self, tab: TabId) {
        self.with(|m| {
            m.remove(&tab);
        });
    }
}

/// Install the picker and start it. Safe to call repeatedly: the script
/// short-circuits when it is already installed, and a fresh nonce
/// invalidates payloads from a previous session in the same document.
pub async fn start(app: &AppHandle<Runtime>, tab: TabId, session: &CdpSession) -> AppResult<()> {
    let nonce = dive_core::TabId::new().to_string().replace('-', "");
    let state = app.state::<AppState>();
    let _pending = state.activity.pending(tab);
    session
        .call("Runtime.addBinding", serde_json::json!({"name": BINDING}))
        .await
        .map_err(AppError::new)?;
    let script = crate::pagescript::build(
        "picker.js",
        &[
            (
                "__NONCE__",
                serde_json::to_string(&nonce).unwrap_or_else(|_| "null".into()),
            ),
            ("__BINDING__", BINDING.to_owned()),
        ],
    );
    session
        .call(
            "Runtime.evaluate",
            serde_json::json!({"expression": script}),
        )
        .await
        .map_err(AppError::new)?;
    // The nonce is recorded only once the script is in place, so a payload
    // arriving from an older install cannot be accepted.
    state.inspector.with(|m| {
        let entry = m.entry(tab).or_default();
        entry.nonce = Some(nonce);
    });
    evaluate(session, "window.__divePicker.start()").await?;
    Ok(())
}

/// Stop the picker without discarding the last pick.
pub async fn cancel(app: &AppHandle<Runtime>, tab: TabId, session: &CdpSession) -> AppResult<()> {
    let state = app.state::<AppState>();
    state.inspector.with(|m| {
        if let Some(entry) = m.get_mut(&tab) {
            entry.nonce = None;
        }
    });
    evaluate(
        session,
        "window.__divePicker && window.__divePicker.cancel()",
    )
    .await?;
    Ok(())
}

/// Apply a style to the picked element and record what it replaced.
pub async fn set_style(
    app: &AppHandle<Runtime>,
    tab: TabId,
    session: &CdpSession,
    property: &str,
    value: &str,
) -> AppResult<Vec<StyleChange>> {
    let property = property.trim();
    if property.is_empty()
        || property.chars().count() > MAX_STYLE_PROPERTY_CHARS
        || !property
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err(AppError::new("invalid CSS property name"));
    }
    if value.chars().count() > MAX_STYLE_VALUE_CHARS {
        return Err(AppError::new(format!(
            "style value is over the {MAX_STYLE_VALUE_CHARS} character limit"
        )));
    }
    // Both reach the page inside a JS string literal; a property name with a
    // quote in it would otherwise close the literal.
    let expression = format!(
        "window.__divePicker && window.__divePicker.setStyle({}, {})",
        json_string(property),
        json_string(value)
    );
    let result = evaluate(session, &expression).await?;
    if let Some(error) = result["error"].as_str() {
        return Err(AppError::new(match error {
            "nothing_picked" => "pick an element first".to_owned(),
            other => other.to_owned(),
        }));
    }
    refresh_changes(app, tab, session).await
}

/// Put the picked element back the way it was found.
pub async fn revert_styles(
    app: &AppHandle<Runtime>,
    tab: TabId,
    session: &CdpSession,
) -> AppResult<Vec<StyleChange>> {
    let result = evaluate(
        session,
        "window.__divePicker && window.__divePicker.revertStyles()",
    )
    .await?;
    if result["error"].as_str() == Some("nothing_picked") {
        return Err(AppError::new("pick an element first"));
    }
    refresh_changes(app, tab, session).await
}

/// Re-read the experiments from the page, which is the authority on them:
/// a reload wipes the inline styles and the list has to follow.
async fn refresh_changes(
    app: &AppHandle<Runtime>,
    tab: TabId,
    session: &CdpSession,
) -> AppResult<Vec<StyleChange>> {
    let report = evaluate(
        session,
        "window.__divePicker && window.__divePicker.report()",
    )
    .await?;
    if report["error"].as_str() == Some("nothing_picked") {
        return Err(AppError::new("the picked element is no longer on the page"));
    }
    let changes: Vec<StyleChange> =
        serde_json::from_value(report["styleChanges"].clone()).unwrap_or_default();
    app.state::<AppState>().inspector.with(|m| {
        m.entry(tab).or_default().changes.clone_from(&changes);
    });
    Ok(changes)
}

/// A `Runtime.evaluate` that surfaces a page exception instead of returning
/// a silent `undefined`.
async fn evaluate(session: &CdpSession, expression: &str) -> AppResult<Value> {
    let result = session
        .call(
            "Runtime.evaluate",
            serde_json::json!({"expression": expression, "returnByValue": true}),
        )
        .await
        .map_err(AppError::new)?;
    if let Some(details) = result.get("exceptionDetails") {
        return Err(AppError::new(
            details["exception"]["description"]
                .as_str()
                .or_else(|| details["text"].as_str())
                .unwrap_or("the inspector script threw"),
        ));
    }
    Ok(result["result"]["value"].clone())
}

/// JSON-encode a string for embedding in JavaScript.
fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

/// Forward picker messages from a tab's CDP session to the chrome.
///
/// Spawned once per session by the CDP feed, and left running: the picker can
/// be started and stopped many times over a tab's life, and the nonce check
/// is what decides whether a message counts.
pub fn watch(app: AppHandle<Runtime>, tab: TabId, session: &CdpSession) {
    let mut events = session.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => {
                    if event.method == "Page.frameNavigated"
                        && event.params["frame"]["parentId"].is_null()
                    {
                        app.state::<AppState>().inspector.drop_tab(tab);
                        continue;
                    }
                    if let Some((kind, payload)) = message(&event) {
                        let state = app.state::<AppState>();
                        let Some(expected) = state.inspector.nonce(tab) else {
                            continue;
                        };
                        if payload["nonce"].as_str() != Some(expected.as_str()) {
                            tracing::debug!("ignored an inspector payload with a stale nonce");
                            continue;
                        }
                        deliver(&app, tab, kind, &payload["payload"]).await;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(tab = %tab, n, "inspector missed CDP events");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// A `Runtime.bindingCalled` for our binding, decoded.
fn message(event: &CdpEvent) -> Option<(String, Value)> {
    if event.method != "Runtime.bindingCalled" || event.params["name"] != BINDING {
        return None;
    }
    let encoded = event.params["payload"].as_str()?;
    if encoded.len() > MAX_BINDING_PAYLOAD {
        return None;
    }
    let payload: Value = serde_json::from_str(encoded).ok()?;
    let kind = payload["kind"].as_str()?.to_owned();
    Some((kind, payload))
}

/// Turn a page payload into a [`Pick`], resolve its source, and emit it.
async fn deliver(app: &AppHandle<Runtime>, tab: TabId, kind: String, payload: &Value) {
    if kind == "cancelled" {
        app.state::<AppState>().inspector.with(|m| {
            if let Some(entry) = m.get_mut(&tab) {
                entry.nonce = None;
            }
        });
        let _ = InspectEvent {
            tab_id: tab,
            kind,
            pick: None,
        }
        .emit(app);
        return;
    }
    let Some(mut pick) = parse_pick(tab, payload) else {
        tracing::warn!("discarded a malformed inspector payload");
        return;
    };
    // A bundle location is not a path anyone can open, so map it back.
    if let Some(frame) = &pick.source {
        let state = app.state::<AppState>();
        let page_url = lock(&state.store)
            .tab(tab)
            .map(|t| t.url)
            .unwrap_or_default();
        pick.source_resolved = state
            .sourcemaps
            .resolve(
                &page_url,
                &frame.file_name,
                frame.line_number.unwrap_or(1),
                frame.column_number.unwrap_or(1),
            )
            .await;
    }
    {
        let state = app.state::<AppState>();
        state.inspector.with(|m| {
            let entry = m.entry(tab).or_default();
            entry.pick = Some(pick.clone());
            entry.changes.clear();
            // A pick ends the picking session; the overlay has already
            // stopped listening in the page.
            entry.nonce = None;
        });
    }
    let _ = InspectEvent {
        tab_id: tab,
        kind,
        pick: Some(pick),
    }
    .emit(app);
}

/// Validate a picker payload.
///
/// Strict on purpose. The picker shares `globalThis` with the page, so a
/// hostile or simply broken page can reach the binding; anything that does
/// not have the shape of a pick is dropped rather than partly trusted.
pub fn parse_pick(tab: TabId, payload: &Value) -> Option<Pick> {
    let text = |key: &str| payload[key].as_str().map(str::to_owned);
    Some(Pick {
        tab_id: tab,
        page_url: text("pageUrl")?,
        page_title: text("pageTitle"),
        tag_name: text("tagName")?,
        role: text("role").unwrap_or_default(),
        name: text("name").unwrap_or_default(),
        selector: text("selector"),
        locator: text("locator"),
        html_preview: text("htmlPreview").unwrap_or_default(),
        styles: text("styles").unwrap_or_default(),
        component_name: text("componentName"),
        source: parse_frame(&payload["source"]),
        stack: payload["stack"]
            .as_array()
            .map(|frames| frames.iter().filter_map(parse_frame).collect())
            .unwrap_or_default(),
        owners: payload["owners"]
            .as_array()
            .map(|names| {
                names
                    .iter()
                    .filter_map(|n| n.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
        source_resolved: None,
        picked_at: text("pickedAt").unwrap_or_else(|| dive_core::Timestamp::now().to_rfc3339()),
    })
}

fn parse_frame(value: &Value) -> Option<SourceFrame> {
    let file_name = value["fileName"].as_str()?.to_owned();
    if file_name.is_empty() {
        return None;
    }
    let number = |key: &str| {
        value[key]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .filter(|n| *n > 0)
    };
    Some(SourceFrame {
        function_name: value["functionName"].as_str().map(str::to_owned),
        file_name,
        line_number: number("lineNumber"),
        column_number: number("columnNumber"),
    })
}

/// Everything an agent needs about the current pick, as a prompt-ready block.
///
/// Written as text rather than JSON because this is pasted into a message to
/// a coding agent, where "`SubmitButton` at Form.tsx:42, padding 8px -> 12px"
/// is the whole point.
pub fn describe(pick: &Pick, changes: &[StyleChange]) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    let _ = writeln!(out, "## Element");
    if let Some(component) = &pick.component_name {
        let _ = writeln!(out, "- component: <{component}>");
    }
    let location = pick
        .source_resolved
        .as_ref()
        .map(|o| format!("{}:{}", o.source, o.line))
        .or_else(|| {
            pick.source.as_ref().map(|f| {
                format!(
                    "{}:{}",
                    f.file_name,
                    f.line_number.map_or_else(|| "?".into(), |l| l.to_string())
                )
            })
        });
    if let Some(location) = location {
        let _ = writeln!(out, "- source: {location}");
    }
    if !pick.owners.is_empty() {
        let _ = writeln!(out, "- rendered inside: {}", pick.owners.join(" < "));
    }
    let _ = writeln!(out, "- tag: <{}>", pick.tag_name);
    if !pick.role.is_empty() {
        let _ = writeln!(out, "- role: {} {:?}", pick.role, pick.name);
    }
    if let Some(locator) = &pick.locator {
        let _ = writeln!(out, "- locator: {locator}");
    }
    let _ = writeln!(out, "- page: {}", pick.page_url);
    let _ = writeln!(out, "\n```html\n{}\n```", pick.html_preview);
    if !changes.is_empty() {
        let _ = writeln!(out, "\n## Style changes to apply");
        for change in changes {
            let _ = writeln!(
                out,
                "- {}: {} -> {}",
                change.property, change.previous_value, change.value
            );
        }
    }
    if !pick.styles.is_empty() {
        let _ = writeln!(out, "\n## Computed styles\n```css\n{}\n```", pick.styles);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tab() -> TabId {
        TabId::new()
    }

    #[test]
    fn a_full_payload_becomes_a_pick() {
        let pick = parse_pick(
            tab(),
            &json!({
                "pageUrl": "http://localhost:5173/settings",
                "pageTitle": "Settings",
                "tagName": "button",
                "role": "button",
                "name": "Save",
                "selector": "#save",
                "locator": "role=button[name=\"Save\"]",
                "htmlPreview": "<button id=\"save\">Save</button>",
                "styles": "padding: 8px",
                "componentName": "SubmitButton",
                "source": {
                    "functionName": "SubmitButton",
                    "fileName": "/src/components/Form.tsx",
                    "lineNumber": 42,
                    "columnNumber": 7,
                },
                "stack": [
                    {"functionName": "SubmitButton", "fileName": "/src/components/Form.tsx", "lineNumber": 42, "columnNumber": 7},
                    {"functionName": "Form", "fileName": "/src/Form.tsx", "lineNumber": 10, "columnNumber": 3},
                ],
                "owners": ["SubmitButton", "Form"],
                "pickedAt": "2026-09-04T00:00:00Z",
            }),
        )
        .expect("a well-formed payload");
        assert_eq!(pick.component_name.as_deref(), Some("SubmitButton"));
        assert_eq!(pick.source.as_ref().unwrap().line_number, Some(42));
        assert_eq!(pick.stack.len(), 2);
        assert_eq!(pick.owners, ["SubmitButton", "Form"]);
        assert_eq!(pick.locator.as_deref(), Some("role=button[name=\"Save\"]"));
    }

    #[test]
    fn a_payload_without_a_url_or_tag_is_dropped() {
        // The picker shares globalThis with the page, so the binding is
        // reachable by the page itself. Anything shaped wrong is discarded
        // rather than partly trusted.
        assert!(parse_pick(tab(), &json!({})).is_none());
        assert!(parse_pick(tab(), &json!({"pageUrl": "http://a.dev"})).is_none());
        assert!(parse_pick(tab(), &json!({"tagName": "div"})).is_none());
        assert!(parse_pick(tab(), &json!({"pageUrl": 5, "tagName": "div"})).is_none());
    }

    #[test]
    fn a_pick_on_a_production_build_still_parses_without_a_source() {
        let pick = parse_pick(
            tab(),
            &json!({
                "pageUrl": "https://app.dev/",
                "tagName": "div",
                "componentName": null,
                "source": null,
                "stack": [],
            }),
        )
        .expect("a DOM-only pick is still a pick");
        assert!(pick.component_name.is_none());
        assert!(pick.source.is_none());
        assert!(pick.stack.is_empty());
    }

    #[test]
    fn frames_without_a_usable_location_are_skipped() {
        assert!(parse_frame(&json!(null)).is_none());
        assert!(parse_frame(&json!({"fileName": ""})).is_none());
        // A zero line number is React saying it does not know.
        let frame = parse_frame(&json!({"fileName": "/a.tsx", "lineNumber": 0})).unwrap();
        assert_eq!(frame.line_number, None);
        let frame = parse_frame(&json!({"fileName": "/a.tsx", "lineNumber": 3})).unwrap();
        assert_eq!(frame.line_number, Some(3));
    }

    #[test]
    fn binding_messages_are_decoded_and_others_ignored() {
        let event = CdpEvent {
            method: "Runtime.bindingCalled".into(),
            params: json!({
                "name": BINDING,
                "payload": "{\"nonce\":\"n1\",\"kind\":\"picked\",\"payload\":{\"tagName\":\"button\"}}",
            }),
        };
        let (kind, payload) = message(&event).expect("our binding");
        assert_eq!(kind, "picked");
        assert_eq!(payload["nonce"], "n1");

        // Another binding, or another event entirely, is not ours.
        let other = CdpEvent {
            method: "Runtime.bindingCalled".into(),
            params: json!({"name": "__somethingElse", "payload": "{}"}),
        };
        assert!(message(&other).is_none());
        assert!(
            message(&CdpEvent {
                method: "Page.loadEventFired".into(),
                params: json!({}),
            })
            .is_none()
        );
        // Unparseable JSON from a page must not panic.
        assert!(
            message(&CdpEvent {
                method: "Runtime.bindingCalled".into(),
                params: json!({"name": BINDING, "payload": "not json"}),
            })
            .is_none()
        );
    }

    #[test]
    fn a_description_leads_with_the_component_and_the_style_diff() {
        let pick = parse_pick(
            tab(),
            &json!({
                "pageUrl": "http://localhost:5173/",
                "tagName": "button",
                "role": "button",
                "name": "Save",
                "locator": "role=button[name=\"Save\"]",
                "htmlPreview": "<button>Save</button>",
                "styles": "padding: 8px",
                "componentName": "SubmitButton",
                "source": {"fileName": "/src/Form.tsx", "lineNumber": 42},
                "owners": ["SubmitButton", "Form"],
            }),
        )
        .unwrap();
        let changes = vec![StyleChange {
            property: "padding".into(),
            previous_value: "8px".into(),
            value: "12px".into(),
            selector: Some("#save".into()),
            locator: Some("role=button[name=\"Save\"]".into()),
            component_name: Some("SubmitButton".into()),
        }];
        let described = describe(&pick, &changes);
        assert!(described.contains("<SubmitButton>"), "{described}");
        assert!(described.contains("/src/Form.tsx:42"), "{described}");
        assert!(described.contains("padding: 8px -> 12px"), "{described}");
        assert!(described.contains("SubmitButton < Form"), "{described}");
        assert!(
            described.contains("role=button"),
            "the locator lets an agent act on it too: {described}"
        );
    }

    #[test]
    fn a_description_omits_sections_it_has_nothing_for() {
        let pick = parse_pick(
            tab(),
            &json!({"pageUrl": "http://a.dev/", "tagName": "div", "htmlPreview": "<div/>"}),
        )
        .unwrap();
        let described = describe(&pick, &[]);
        assert!(!described.contains("component:"));
        assert!(!described.contains("Style changes"));
        assert!(!described.contains("Computed styles"));
        assert!(described.contains("<div>"));
    }

    #[test]
    fn a_resolved_source_wins_over_the_bundle_location() {
        // The bundle path is not something a person can open; the mapped one
        // is, so it is what the description quotes.
        let mut pick = parse_pick(
            tab(),
            &json!({
                "pageUrl": "http://localhost:5173/",
                "tagName": "button",
                "htmlPreview": "<button/>",
                "source": {"fileName": "http://localhost:5173/assets/index-abc.js", "lineNumber": 900},
            }),
        )
        .unwrap();
        pick.source_resolved = Some(crate::sourcemaps::Original {
            source: "src/components/Form.tsx".into(),
            line: 42,
            column: 7,
        });
        let described = describe(&pick, &[]);
        assert!(
            described.contains("src/components/Form.tsx:42"),
            "{described}"
        );
        assert!(!described.contains("index-abc.js"), "{described}");
    }

    #[test]
    fn style_property_names_and_values_are_escaped_into_javascript() {
        // Both reach the page inside a string literal.
        assert_eq!(json_string("color"), "\"color\"");
        assert_eq!(json_string("a\"b"), "\"a\\\"b\"");
        assert!(json_string("</script>").contains("script"));
    }

    #[test]
    fn page_style_changes_decode_from_the_picker_shape() {
        let change: StyleChange = serde_json::from_value(json!({
            "property": "padding",
            "previousValue": "8px",
            "value": "12px",
            "selector": "#save",
            "locator": "role=button[name=\"Save\"]",
            "componentName": "SubmitButton"
        }))
        .unwrap();
        assert_eq!(change.previous_value, "8px");
        assert_eq!(change.component_name.as_deref(), Some("SubmitButton"));
    }

    #[test]
    fn oversized_binding_payloads_are_discarded_before_json_parsing() {
        let event = CdpEvent {
            method: "Runtime.bindingCalled".into(),
            params: json!({"name": BINDING, "payload": "x".repeat(MAX_BINDING_PAYLOAD + 1)}),
        };
        assert!(message(&event).is_none());
    }

    #[test]
    fn a_registry_keeps_picks_per_tab_and_forgets_closed_ones() {
        let registry = Registry::default();
        let (a, b) = (tab(), tab());
        assert!(registry.pick(a).is_none());
        assert!(registry.changes(a).is_empty());
        assert!(registry.nonce(a).is_none());

        registry.with(|m| {
            m.entry(a).or_default().nonce = Some("n1".into());
        });
        assert_eq!(registry.nonce(a).as_deref(), Some("n1"));
        assert!(registry.nonce(b).is_none(), "tabs do not share a nonce");

        registry.drop_tab(a);
        assert!(registry.nonce(a).is_none());
    }
}
