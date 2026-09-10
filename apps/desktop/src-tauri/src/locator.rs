//! Playwright-style locators for a page, evaluated inside it.
//!
//! Dive used to address elements only by `[ref=eN]` handed out by
//! `page_state`. Those refs are CDP backend node ids, so they go stale the
//! moment the page re-renders and an agent that reads the tree and then acts
//! silently clicks the wrong thing after any React update. A locator is
//! resolved against the live DOM at the moment of the action instead, so it
//! survives re-renders and reads the way a person would describe the target:
//! `role=button[name="Save"]`, `text=Continue`, `testid=submit`.
//!
//! The engine is `inject/locator.js` rather than Playwright's own
//! `InjectedScript`. Vendoring that means string-extracting a minified
//! literal out of `playwright-core`'s bundle and re-doing it on every
//! upgrade; this covers the selector syntax people actually write, in a file
//! we can read and test. The grammar is quoted once, as
//! `dive_mcp::LOCATOR_GRAMMAR`, so the tool schemas and this implementation
//! cannot describe different syntaxes; `src/lib/injected.test.ts` exercises
//! the engine against a DOM.
//!
//! The script is idempotent and re-evaluated before every operation, so
//! there is nothing to install, clean up, or re-register after a navigation.
//!
use dive_cdp::CdpSession;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;

use crate::pagescript;

/// Cap on elements walked per step, so a pathological page cannot hang a call.
const MAX_CANDIDATES: usize = 8000;

/// Why a locator did not produce an actionable element.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// The selector could not be parsed.
    Invalid {
        /// The selector as given.
        locator: String,
        /// What the engine objected to.
        reason: String,
    },
    /// Nothing in the document matched.
    NotFound {
        /// The selector as given.
        locator: String,
    },
    /// Matched, but the element is not rendered.
    NotVisible {
        /// The selector as given.
        locator: String,
    },
    /// Matched and visible, but disabled.
    NotEnabled {
        /// The selector as given.
        locator: String,
    },
    /// Matched, but not a text field or `contenteditable`.
    NotEditable {
        /// The selector as given.
        locator: String,
    },
    /// The page or the CDP session went away mid-call.
    Engine(String),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid { locator, reason } => {
                write!(f, "locator {locator:?} is not valid: {reason}")
            }
            Self::NotFound { locator } => write!(
                f,
                "nothing matches locator {locator:?}; call page_inspect to see what is on the page"
            ),
            Self::NotVisible { locator } => write!(
                f,
                "locator {locator:?} matches an element that is not visible"
            ),
            Self::NotEnabled { locator } => {
                write!(f, "locator {locator:?} matches a disabled element")
            }
            Self::NotEditable { locator } => write!(
                f,
                "locator {locator:?} matches an element that cannot accept text"
            ),
            Self::Engine(e) => write!(f, "{e}"),
        }
    }
}

/// A resolved, actionable element.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Found {
    /// Centre of the element in CSS pixels, viewport-relative.
    pub x: f64,
    /// Centre of the element in CSS pixels, viewport-relative.
    pub y: f64,
    /// Width in CSS pixels.
    pub width: f64,
    /// Height in CSS pixels.
    pub height: f64,
    /// ARIA role, when the element has one.
    pub role: String,
    /// Accessible name.
    pub name: String,
    /// Lowercased tag name.
    pub tag: String,
    /// How many elements the locator matched; more than one means the first won.
    pub count: u32,
}

impl Found {
    /// The shortest honest name for the match, for saying what was acted on.
    #[must_use]
    pub fn describe(&self) -> String {
        if self.name.is_empty() {
            self.tag.clone()
        } else {
            format!("{} {:?}", self.role, self.name)
        }
    }
}

/// The page's viewport in CSS pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
pub struct Viewport {
    /// `window.innerWidth`.
    pub width: f64,
    /// `window.innerHeight`.
    pub height: f64,
}

/// Build the injected engine from `inject/locator.js` and the role, name and
/// actionability fragments it shares with the recorder and the picker.
fn script() -> String {
    pagescript::build(
        "locator.js",
        &[("__MAX_CANDIDATES__", MAX_CANDIDATES.to_string())],
    )
}

/// Evaluate an expression and hand back its `returnByValue` result.
async fn eval(session: &CdpSession, expression: String) -> Result<Value, Failure> {
    let result = session
        .call(
            "Runtime.evaluate",
            json!({"expression": expression, "returnByValue": true, "awaitPromise": true}),
        )
        .await
        .map_err(|e| Failure::Engine(e.to_string()))?;
    if let Some(details) = result.get("exceptionDetails") {
        return Err(Failure::Engine(
            details["exception"]["description"]
                .as_str()
                .or_else(|| details["text"].as_str())
                .unwrap_or("the page threw while resolving the locator")
                .to_owned(),
        ));
    }
    Ok(result["result"]["value"].clone())
}

/// Call one method on the installed engine with JSON-encoded arguments.
async fn invoke(
    session: &CdpSession,
    method: &str,
    args: &[Value],
    locator: &str,
) -> Result<Value, Failure> {
    let args = args
        .iter()
        .map(|a| serde_json::to_string(a).unwrap_or_else(|_| "null".into()))
        .collect::<Vec<_>>()
        .join(", ");
    // Install and invoke in one Runtime.evaluate. A navigation can replace the
    // document between two CDP calls; doing this atomically prevents a short
    // `window.__diveLocator is undefined` race while page_wait_for polls a
    // just-navigated tab.
    let source = script();
    let value = eval(
        session,
        format!("(() => {{\n{source}\nreturn window.__diveLocator.{method}({args});\n}})()"),
    )
    .await?;
    if value.is_null() {
        return Err(Failure::Engine(
            "the locator engine did not answer; the page may have navigated".into(),
        ));
    }
    if let Some(kind) = value["error"].as_str() {
        let locator = locator.to_owned();
        return Err(match kind {
            "invalid" => Failure::Invalid {
                locator,
                reason: value["reason"].as_str().unwrap_or("unparseable").to_owned(),
            },
            "not_found" => Failure::NotFound { locator },
            "not_visible" => Failure::NotVisible { locator },
            "not_enabled" => Failure::NotEnabled { locator },
            "not_editable" => Failure::NotEditable { locator },
            other => Failure::Engine(format!("locator engine reported {other}")),
        });
    }
    Ok(value)
}

fn found(value: &Value) -> Result<Found, Failure> {
    serde_json::from_value(value.clone())
        .map_err(|e| Failure::Engine(format!("locator engine returned an unreadable match: {e}")))
}

/// Resolve `locator` to a click point, scrolling it into view.
pub async fn point(session: &CdpSession, locator: &str) -> Result<Found, Failure> {
    found(&invoke(session, "point", &[json!(locator)], locator).await?)
}

/// Resolve `locator`, focus it, and report where it is. Fails unless the
/// element can actually accept text.
pub async fn focus(session: &CdpSession, locator: &str) -> Result<Found, Failure> {
    found(&invoke(session, "focus", &[json!(locator)], locator).await?)
}

/// Resolve and focus any actionable control, including non-editable buttons
/// and links used as keyboard targets.
pub async fn focus_any(session: &CdpSession, locator: &str) -> Result<Found, Failure> {
    found(&invoke(session, "focusAny", &[json!(locator)], locator).await?)
}

/// Resolve `locator` and remember the node as `window.__diveHeld`, so a
/// follow-up expression can read from the same element.
pub async fn hold(session: &CdpSession, locator: &str) -> Result<Found, Failure> {
    found(&invoke(session, "hold", &[json!(locator)], locator).await?)
}

/// How many elements `locator` matches right now. Zero is not an error.
pub async fn count(session: &CdpSession, locator: &str) -> Result<u32, Failure> {
    let value = invoke(session, "matches", &[json!(locator)], locator).await?;
    Ok(u32::try_from(value["count"].as_u64().unwrap_or(0)).unwrap_or(u32::MAX))
}

/// Describe up to `limit` matches, for reporting an ambiguous locator back.
pub async fn all(session: &CdpSession, locator: &str, limit: u32) -> Result<Vec<Found>, Failure> {
    let value = invoke(session, "all", &[json!(locator), json!(limit)], locator).await?;
    serde_json::from_value(value["matches"].clone())
        .map_err(|e| Failure::Engine(format!("locator engine returned unreadable matches: {e}")))
}

/// Every interactive element on the page, each with the locator that
/// addresses it alone.
pub async fn elements(session: &CdpSession, limit: u32) -> Result<Value, Failure> {
    invoke(session, "elements", &[json!(limit)], "").await
}

/// The page itself: URL, title, readiness, visible text, viewport, scroll.
pub async fn page(session: &CdpSession, text_limit: usize) -> Result<Value, Failure> {
    invoke(session, "page", &[json!(text_limit)], "").await
}

/// The React component that rendered whatever `locator` matches.
///
/// Composed from the same React traversal the element picker uses, so an
/// agent asking about a locator gets the answer the person sees when they
/// point at the element themselves.
pub async fn component(session: &CdpSession, locator: &str) -> Result<Value, Failure> {
    hold(session, locator).await?;
    component_held(session, locator).await
}

/// Choose an option on the held element, which has to be a `<select>`.
/// `value` wins over `label`; the result says what was chosen, or which
/// options exist when nothing matched.
pub async fn select_held(
    session: &CdpSession,
    value: Option<&str>,
    label: Option<&str>,
) -> Result<Value, Failure> {
    let expression = format!(
        r"(() => {{
  const el = window.__diveHeld;
  if (!el || el.tagName !== 'SELECT') return {{ error: 'not_select', tag: el ? el.tagName.toLowerCase() : null }};
  const want = {value};
  const wantLabel = {label};
  const options = Array.from(el.options);
  const norm = (s) => s.trim().toLowerCase();
  let option = null;
  if (want !== null) option = options.find((o) => o.value === want) || null;
  else if (wantLabel !== null) option = options.find((o) => norm(o.label) === norm(wantLabel) || norm(o.text) === norm(wantLabel)) || null;
  if (!option) return {{ error: 'no_option', options: options.slice(0, 50).map((o) => ({{ value: o.value, label: o.label, disabled: o.disabled }})) }};
  if (option.disabled) return {{ error: 'disabled', value: option.value, label: option.label }};
  el.focus();
  const before = el.value;
  el.value = option.value;
  const changed = el.value !== before;
  if (changed) {{
    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  }}
  return {{ value: option.value, label: option.label, changed }};
}})()",
        value = json!(value),
        label = json!(label),
    );
    eval(session, expression).await
}

/// What kind of control the held element is, so a form filler knows whether
/// a value means text, an option or a checked state.
pub async fn kind_held(session: &CdpSession) -> Result<Value, Failure> {
    eval(
        session,
        r"(() => {
  const el = window.__diveHeld;
  if (!el) return { kind: 'none' };
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (tag === 'select') return { kind: 'select', tag, type };
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
    return { kind: 'checked', tag, type, checked: Boolean(el.checked) };
  }
  if (tag === 'input' && type === 'file') return { kind: 'file', tag, type };
  return { kind: 'text', tag, type };
})()"
            .to_owned(),
    )
    .await
}

/// Set the held checkbox or radio to `want`, firing the events a page listens
/// for. Reports whether anything actually changed.
pub async fn set_checked_held(session: &CdpSession, want: bool) -> Result<Value, Failure> {
    eval(
        session,
        format!(
            r"(() => {{
  const el = window.__diveHeld;
  if (!el) return {{ error: 'not_found' }};
  const want = {want};
  if (el.checked === want) return {{ checked: want, changed: false }};
  // A click rather than a property set: a radio group and every framework
  // that listens for the click keep their own state that way.
  el.click();
  if (el.checked !== want) {{
    el.checked = want;
    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  }}
  return {{ checked: Boolean(el.checked), changed: true }};
}})()",
            want = json!(want)
        ),
    )
    .await
}

/// Remember the element under a viewport point as `window.__diveHeld`.
pub async fn component_hold_at(session: &CdpSession, x: f64, y: f64) -> Result<(), Failure> {
    let held = eval(
        session,
        format!(
            "window.__diveHeld = document.elementFromPoint({x}, {y}); Boolean(window.__diveHeld)"
        ),
    )
    .await?;
    if held.as_bool() == Some(true) {
        Ok(())
    } else {
        Err(Failure::NotFound {
            locator: format!("point({x}, {y})"),
        })
    }
}

/// The React component underneath a viewport point.
pub async fn component_at(session: &CdpSession, x: f64, y: f64) -> Result<Value, Failure> {
    eval(
        session,
        format!(
            "window.__diveHeld = document.elementFromPoint({x}, {y}); Boolean(window.__diveHeld)"
        ),
    )
    .await?;
    component_held(session, &format!("point({x}, {y})")).await
}

async fn component_held(session: &CdpSession, locator: &str) -> Result<Value, Failure> {
    let value = eval(session, crate::pagescript::build("component.js", &[])).await?;
    if value["error"].as_str() == Some("not_found") {
        return Err(Failure::NotFound {
            locator: locator.to_owned(),
        });
    }
    Ok(value)
}

/// Whether visible page text contains `needle`, without transferring the
/// whole document through CDP on every wait poll.
pub async fn contains_text(session: &CdpSession, needle: &str) -> Result<bool, Failure> {
    let needle = serde_json::to_string(&needle.to_lowercase())
        .map_err(|e| Failure::Engine(format!("could not encode wait text: {e}")))?;
    let value = eval(
        session,
        format!(
            "Boolean((document.body ? (document.body.innerText || document.body.textContent || '') : '').toLowerCase().includes({needle}))"
        ),
    )
    .await?;
    Ok(value.as_bool().unwrap_or(false))
}

/// The page's current viewport, for bounds-checking a coordinate click.
pub async fn viewport(session: &CdpSession) -> Result<Viewport, Failure> {
    let value = eval(
        session,
        "({ width: window.innerWidth, height: window.innerHeight })".into(),
    )
    .await?;
    serde_json::from_value(value)
        .map_err(|e| Failure::Engine(format!("could not read the viewport size: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_composes_the_shared_helpers_and_self_guards() {
        let s = script();
        assert!(
            s.contains("window.__diveLocator && window.__diveLocator.version === 1"),
            "re-evaluating the script on an already-installed page must be a no-op"
        );
        // The role/name and actionability rules come from the shared
        // fragments so the recorder and the locator engine cannot drift.
        assert!(s.contains("const roleOf ="), "role helper missing");
        assert!(s.contains("const nameOf ="), "name helper missing");
        assert!(
            s.contains("const isEditable ="),
            "editability helper missing"
        );
        assert!(
            s.contains(&MAX_CANDIDATES.to_string()),
            "cap not substituted"
        );
    }

    #[test]
    fn locator_install_and_invocation_share_one_expression() {
        let source = script();
        let expression =
            format!("(() => {{\n{source}\nreturn window.__diveLocator.page(0);\n}})()");
        assert!(expression.contains("window.__diveLocator ="));
        assert!(expression.contains("return window.__diveLocator.page(0)"));
    }

    #[test]
    fn script_has_balanced_braces() {
        let mut depth = 0i32;
        let script = script();
        for c in script.chars() {
            match c {
                '{' => depth += 1,
                '}' => depth -= 1,
                _ => {}
            }
            assert!(depth >= 0, "closing brace without an opener");
        }
        assert_eq!(depth, 0, "unbalanced braces in the composed script");
    }

    #[test]
    fn failures_name_the_locator_and_suggest_a_next_step() {
        let f = Failure::NotFound {
            locator: "role=button[name=\"Save\"]".into(),
        };
        let message = f.to_string();
        assert!(message.contains("role=button"), "{message}");
        assert!(
            message.contains("page_inspect"),
            "a not-found failure should point at the tool that lists what is on the page: {message}"
        );
        assert!(
            Failure::NotEditable {
                locator: "css=div".into()
            }
            .to_string()
            .contains("cannot accept text")
        );
    }

    #[test]
    fn the_documented_grammar_matches_what_the_script_implements() {
        let s = script();
        for engine in [
            "role",
            "text",
            "testid",
            "label",
            "placeholder",
            "alt",
            "title",
            "css",
            "nth",
            "visible",
        ] {
            assert!(
                dive_mcp::LOCATOR_GRAMMAR.contains(engine),
                "{engine}= is implemented but missing from LOCATOR_GRAMMAR, \
                 so no caller would know to use it"
            );
            assert!(
                s.contains(&format!("\"{engine}\"")),
                "{engine} not in ENGINES"
            );
        }
    }
}
