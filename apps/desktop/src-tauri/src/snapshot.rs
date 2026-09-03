//! Page-state snapshots and diffs: what changed on a page between two
//! moments (a deploy, an action, a reload). Pure diff logic lives here.

use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;

/// What we remember about a page at one moment.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct PageSnapshot {
    /// When it was taken (RFC 3339).
    pub taken_at: String,
    /// Page URL.
    pub url: String,
    /// Page title.
    pub title: String,
    /// Visible text.
    pub text: String,
    /// Compact accessibility tree.
    pub structure: String,
    /// Error-level console lines.
    pub errors: Vec<String>,
    /// `METHOD url -> status` per request.
    pub requests: Vec<String>,
}

/// Human-readable differences between two snapshots.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct PageDiff {
    /// Older snapshot time.
    pub from: String,
    /// Newer snapshot time.
    pub to: String,
    /// Unified diff of visible text (empty when unchanged).
    pub text: String,
    /// Unified diff of the accessibility tree.
    pub structure: String,
    /// Errors present only in the newer snapshot.
    pub new_errors: Vec<String>,
    /// Errors that went away.
    pub fixed_errors: Vec<String>,
    /// Requests present only in the newer snapshot.
    pub new_requests: Vec<String>,
    /// Requests that no longer happen.
    pub gone_requests: Vec<String>,
    /// URL or title changes, if any.
    pub notes: Vec<String>,
}

/// Compare two snapshots.
pub fn diff(older: &PageSnapshot, newer: &PageSnapshot) -> PageDiff {
    let only_in = |a: &[String], b: &[String]| -> Vec<String> {
        b.iter().filter(|x| !a.contains(x)).cloned().collect()
    };
    let mut notes = Vec::new();
    if older.url != newer.url {
        notes.push(format!("url: {} -> {}", older.url, newer.url));
    }
    if older.title != newer.title {
        notes.push(format!("title: {:?} -> {:?}", older.title, newer.title));
    }
    PageDiff {
        from: older.taken_at.clone(),
        to: newer.taken_at.clone(),
        text: unified(&older.text, &newer.text),
        structure: unified(&older.structure, &newer.structure),
        new_errors: only_in(&older.errors, &newer.errors),
        fixed_errors: only_in(&newer.errors, &older.errors),
        new_requests: only_in(&older.requests, &newer.requests),
        gone_requests: only_in(&newer.requests, &older.requests),
        notes,
    }
}

/// Unified diff with 2 lines of context; empty when identical.
pub fn unified(a: &str, b: &str) -> String {
    if a == b {
        return String::new();
    }
    similar::TextDiff::from_lines(a, b)
        .unified_diff()
        .context_radius(2)
        .header("before", "after")
        .to_string()
}

/// Render a diff for an agent or the sidecar.
pub fn summarize(d: &PageDiff) -> String {
    let mut out = format!("changes from {} to {}\n", d.from, d.to);
    for n in &d.notes {
        out.push_str("- ");
        out.push_str(n);
        out.push('\n');
    }
    for (label, items) in [
        ("new errors", &d.new_errors),
        ("fixed errors", &d.fixed_errors),
        ("new requests", &d.new_requests),
        ("gone requests", &d.gone_requests),
    ] {
        if !items.is_empty() {
            let _ = writeln!(out, "{label} ({}):", items.len());
            for i in items.iter().take(20) {
                out.push_str("  ");
                out.push_str(i);
                out.push('\n');
            }
        }
    }
    if !d.text.is_empty() {
        out.push_str("text diff:\n");
        out.push_str(&d.text);
    }
    if !d.structure.is_empty() {
        out.push_str("structure diff:\n");
        out.push_str(&d.structure);
    }
    if d.notes.is_empty()
        && d.text.is_empty()
        && d.structure.is_empty()
        && d.new_errors.is_empty()
        && d.fixed_errors.is_empty()
        && d.new_requests.is_empty()
        && d.gone_requests.is_empty()
    {
        out.push_str("no differences\n");
    }
    out
}

/// JSON form used by MCP.
pub fn to_json(d: &PageDiff) -> serde_json::Value {
    json!({"summary": summarize(d), "diff": d})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(text: &str, errors: &[&str], reqs: &[&str]) -> PageSnapshot {
        PageSnapshot {
            taken_at: "t".into(),
            url: "https://a.dev/".into(),
            title: "A".into(),
            text: text.into(),
            structure: "- RootWebArea".into(),
            errors: errors.iter().map(|s| (*s).to_owned()).collect(),
            requests: reqs.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    #[test]
    fn detects_changes() {
        let a = snap(
            "hello\nworld\n",
            &["TypeError: x"],
            &["GET https://a.dev/api -> 200"],
        );
        let mut b = snap(
            "hello\nthere\n",
            &[],
            &[
                "GET https://a.dev/api -> 500",
                "GET https://a.dev/api -> 200",
            ],
        );
        b.title = "B".into();
        let d = diff(&a, &b);
        assert!(d.text.contains("-world") && d.text.contains("+there"));
        assert_eq!(d.structure, "");
        assert_eq!(d.fixed_errors, vec!["TypeError: x"]);
        assert!(d.new_errors.is_empty());
        assert_eq!(d.new_requests, vec!["GET https://a.dev/api -> 500"]);
        assert_eq!(d.notes, vec!["title: \"A\" -> \"B\""]);
        let s = summarize(&d);
        assert!(s.contains("fixed errors (1)") && s.contains("text diff"));
    }

    #[test]
    fn identical_snapshots_report_nothing() {
        let a = snap("x", &[], &[]);
        assert!(summarize(&diff(&a, &a)).contains("no differences"));
    }
}
