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
                    Violation {
                        id: r["id"].as_str().unwrap_or_default().to_owned(),
                        impact: r["impact"].as_str().unwrap_or("minor").to_owned(),
                        help: r["help"].as_str().unwrap_or_default().to_owned(),
                        help_url: r["helpUrl"].as_str().unwrap_or_default().to_owned(),
                        targets: nodes
                            .iter()
                            .take(20)
                            .filter_map(|n| {
                                n["target"].as_array()?.first()?.as_str().map(str::to_owned)
                            })
                            .collect(),
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
                {"id": "color-contrast", "impact": "serious", "help": "Contrast", "helpUrl": "u2", "nodes": [{"target": ["p.a"]}, {"target": ["p.b"]}]}
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
        assert_eq!((r.passes, r.incomplete), (40, 2));
        assert_eq!(parse_report(&json!({})), A11yReport::default());
    }
}
