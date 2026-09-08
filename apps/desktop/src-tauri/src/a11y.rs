//! Accessibility audit: run axe-core inside the page and return violations.
//! The chrome ships the axe source (bundled by Vite) so the host stays small.

use dive_cdp::CdpSession;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;

use crate::error::{AppError, AppResult};

/// One failing rule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Violation {
    /// Rule id, e.g. `color-contrast`.
    pub id: String,
    /// `minor` | `moderate` | `serious` | `critical`.
    pub impact: String,
    /// Short description.
    pub help: String,
    /// Link to the rule documentation.
    pub help_url: String,
    /// CSS selectors of offending nodes (first 20).
    pub targets: Vec<String>,
    /// axe's explanation for each of `targets`, in the same order; empty
    /// strings where it gave none.
    pub notes: Vec<String>,
    /// Total offending nodes.
    pub count: u32,
}

/// Audit result.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct A11yReport {
    /// Failing rules, most severe first.
    pub violations: Vec<Violation>,
    /// Number of rules that passed.
    pub passes: u32,
    /// Number of rules needing manual review.
    pub incomplete: u32,
}

/// Inject `axe_source` if needed and run the audit.
pub async fn run(session: &CdpSession, axe_source: &str) -> AppResult<A11yReport> {
    let script = format!(
        "(async () => {{ if (!window.axe) {{ {axe_source} }} \
         const r = await window.axe.run(document, {{resultTypes: ['violations','passes','incomplete']}}); \
         return JSON.stringify({{violations: r.violations, passes: r.passes.length, incomplete: r.incomplete.length}}); }})()"
    );
    let result = session
        .call(
            "Runtime.evaluate",
            json!({"expression": script, "awaitPromise": true, "returnByValue": true}),
        )
        .await
        .map_err(AppError::new)?;
    if let Some(details) = result.get("exceptionDetails") {
        return Err(AppError::new(
            details["exception"]["description"]
                .as_str()
                .unwrap_or("axe failed"),
        ));
    }
    let raw = result["result"]["value"].as_str().unwrap_or("{}");
    Ok(parse_report(&serde_json::from_str(raw).unwrap_or_default()))
}

/// Scroll the first element matching `selector` into view and flash an
/// outline around it, so a finding can be located on the page. `false`
/// means nothing matched (the page changed since the audit).
pub async fn reveal(session: &CdpSession, selector: &str) -> AppResult<bool> {
    let result = session
        .call(
            "Runtime.evaluate",
            json!({"expression": reveal_script(selector), "returnByValue": true}),
        )
        .await
        .map_err(AppError::new)?;
    if let Some(details) = result.get("exceptionDetails") {
        return Err(AppError::new(
            details["exception"]["description"]
                .as_str()
                .unwrap_or("could not reach the element"),
        ));
    }
    Ok(result["result"]["value"].as_bool().unwrap_or(false))
}

/// The page-side script for [`reveal`]. The selector travels as a JSON
/// string literal so quotes and backslashes inside it cannot break out.
pub fn reveal_script(selector: &str) -> String {
    let literal = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".into());
    format!(
        "(() => {{ const el = document.querySelector({literal}); if (!el) return false;          el.scrollIntoView({{block: 'center', inline: 'center'}});          const r = el.getBoundingClientRect(); const box = document.createElement('div');          box.setAttribute('data-dive-reveal', '');          box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;' +            'border:2px solid #ff8a3d;border-radius:4px;box-shadow:0 0 0 4px rgba(255,138,61,.35);transition:opacity .4s ease;' +            `left:${{r.left - 4}}px;top:${{r.top - 4}}px;width:${{Math.max(r.width, 4) + 8}}px;height:${{Math.max(r.height, 4) + 8}}px`;          document.querySelectorAll('[data-dive-reveal]').forEach((n) => n.remove());          document.documentElement.appendChild(box);          setTimeout(() => {{ box.style.opacity = '0'; }}, 1400); setTimeout(() => box.remove(), 1900);          return true; }})()"
    )
}

/// Map axe's JSON to the report.
pub fn parse_report(v: &Value) -> A11yReport {
    let rank = |impact: &str| match impact {
        "critical" => 0,
        "serious" => 1,
        "moderate" => 2,
        _ => 3,
    };
    let mut violations: Vec<Violation> = v["violations"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|r| {
                    let nodes = r["nodes"].as_array().cloned().unwrap_or_default();
                    let shown: Vec<(String, String)> = nodes
                        .iter()
                        .take(20)
                        .filter_map(|n| {
                            let target = n["target"].as_array()?.first()?.as_str()?.to_owned();
                            let note = n["failureSummary"]
                                .as_str()
                                .unwrap_or_default()
                                .trim()
                                .to_owned();
                            Some((target, note))
                        })
                        .collect();
                    Violation {
                        id: r["id"].as_str().unwrap_or_default().to_owned(),
                        impact: r["impact"].as_str().unwrap_or("minor").to_owned(),
                        help: r["help"].as_str().unwrap_or_default().to_owned(),
                        help_url: r["helpUrl"].as_str().unwrap_or_default().to_owned(),
                        targets: shown.iter().map(|(t, _)| t.clone()).collect(),
                        notes: shown.iter().map(|(_, n)| n.clone()).collect(),
                        count: u32::try_from(nodes.len()).unwrap_or(u32::MAX),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    violations.sort_by_key(|x| rank(&x.impact));
    A11yReport {
        violations,
        passes: u32::try_from(v["passes"].as_u64().unwrap_or(0)).unwrap_or(u32::MAX),
        incomplete: u32::try_from(v["incomplete"].as_u64().unwrap_or(0)).unwrap_or(u32::MAX),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_and_sorts_violations() {
        let v = json!({
            "violations": [
                {"id": "region", "impact": "moderate", "help": "Landmarks", "helpUrl": "u1", "nodes": [{"target": ["body"]}]},
                {"id": "color-contrast", "impact": "serious", "help": "Contrast", "helpUrl": "u2", "nodes": [{"target": ["p.a"], "failureSummary": "Fix any of the following:\n  Element has insufficient color contrast of 1.5"}, {"target": ["p.b"]}]}
            ],
            "passes": 40, "incomplete": 2
        });
        let r = parse_report(&v);
        assert_eq!(
            r.violations
                .iter()
                .map(|x| x.id.as_str())
                .collect::<Vec<_>>(),
            ["color-contrast", "region"]
        );
        assert_eq!(r.violations[0].count, 2);
        assert_eq!(r.violations[0].targets, ["p.a", "p.b"]);
        assert_eq!(
            r.violations[0].notes,
            [
                "Fix any of the following:\n  Element has insufficient color contrast of 1.5",
                ""
            ]
        );
        assert_eq!((r.passes, r.incomplete), (40, 2));
        assert_eq!(parse_report(&json!({})), A11yReport::default());
    }
}

#[cfg(test)]
mod reveal_tests {
    use super::reveal_script;

    #[test]
    fn the_selector_is_quoted_as_a_string_literal() {
        let script = reveal_script("a[href=\"x\"] > span");
        assert!(script.contains("document.querySelector(\"a[href=\\\"x\\\"] > span\")"));
        assert!(script.contains("scrollIntoView"));
    }
}
