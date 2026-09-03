//! Bug report composer: one Markdown block with everything a developer
//! needs to reproduce what the page just did.

use std::fmt::Write as _;

use crate::buffers::RequestSummary;
use crate::console::{ConsoleEntry, Level};
use dive_core::Tab;

/// Most console lines and failed requests included.
const MAX_ITEMS: usize = 20;

/// Compose the report for `tab`.
pub fn compose(
    tab: &Tab,
    console: &[ConsoleEntry],
    requests: &[RequestSummary],
    screenshot: Option<&std::path::Path>,
) -> String {
    let mut out = String::new();
    let title = if tab.title.is_empty() {
        tab.url.as_str()
    } else {
        tab.title.as_str()
    };
    let _ = write!(out, "## Bug report: {title}\n\n");
    let _ = writeln!(out, "- URL: {}", tab.url);
    let _ = writeln!(
        out,
        "- Captured: {}",
        dive_core::Timestamp::now().to_rfc3339()
    );
    let _ = writeln!(
        out,
        "- Browser: Dive {} on {} ({})",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    if let Some(path) = screenshot {
        let _ = writeln!(out, "- Screenshot: {}", path.display());
    }

    let problems: Vec<&ConsoleEntry> = console
        .iter()
        .filter(|e| matches!(e.level, Level::Error | Level::Warn))
        .collect();
    let _ = writeln!(out, "\n### Console ({} errors/warnings)", problems.len());
    if problems.is_empty() {
        out.push_str("\nNone.\n");
    } else {
        out.push_str("\n```\n");
        for e in problems.iter().rev().take(MAX_ITEMS).rev() {
            let level = match e.level {
                Level::Error => "error",
                _ => "warn",
            };
            let at = match (&e.url, e.line) {
                (Some(url), Some(line)) => format!(" ({url}:{line})"),
                (Some(url), None) => format!(" ({url})"),
                _ => String::new(),
            };
            let _ = writeln!(out, "[{level}] {}{at}", e.text.trim());
        }
        out.push_str("```\n");
    }

    let failed: Vec<&RequestSummary> = requests
        .iter()
        .filter(|r| r.error.is_some() || r.status.is_some_and(|s| s >= 400))
        .collect();
    let _ = writeln!(
        out,
        "\n### Network ({} failed of {} requests)",
        failed.len(),
        requests.len()
    );
    if failed.is_empty() {
        out.push_str("\nNone.\n");
    } else {
        out.push_str("\n| Method | URL | Result |\n|---|---|---|\n");
        for r in failed.iter().rev().take(MAX_ITEMS).rev() {
            let result = r.error.clone().unwrap_or_else(|| {
                r.status
                    .map_or_else(|| "pending".to_owned(), |s| format!("HTTP {s}"))
            });
            let _ = writeln!(
                out,
                "| {} | {} | {} |",
                r.method,
                r.url.replace('|', "%7C"),
                result
            );
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use dive_core::TabId;

    fn entry(level: Level, text: &str) -> ConsoleEntry {
        ConsoleEntry {
            tab_id: TabId::new(),
            level,
            text: text.into(),
            source: "console".into(),
            url: Some("https://a.dev/app.js".into()),
            line: Some(12),
            column: None,
            timestamp: 1.0,
        }
    }

    fn req(url: &str, status: Option<u16>, error: Option<&str>) -> RequestSummary {
        RequestSummary {
            id: url.into(),
            url: url.into(),
            method: "GET".into(),
            resource_type: "Fetch".into(),
            status,
            mime_type: String::new(),
            encoded_length: None,
            error: error.map(str::to_owned),
            headers: std::collections::BTreeMap::new(),
            post_data: None,
            response_body: None,
            response_headers: std::collections::BTreeMap::new(),
            started_at: 0.0,
            wall_time: 0.0,
            finished_at: None,
        }
    }

    #[test]
    fn lists_only_problems() {
        let mut tab = Tab::new(dive_core::WorkspaceId::new(), "https://a.dev/", 0);
        tab.title = "App".into();
        let md = compose(
            &tab,
            &[entry(Level::Info, "hello"), entry(Level::Error, "boom")],
            &[
                req("https://a.dev/ok", Some(200), None),
                req("https://a.dev/api", Some(500), None),
                req("https://a.dev/x", None, Some("net::ERR_FAILED")),
            ],
            Some(std::path::Path::new("/tmp/shot.png")),
        );
        assert!(md.starts_with("## Bug report: App\n"));
        assert!(md.contains("[error] boom (https://a.dev/app.js:12)"));
        assert!(!md.contains("hello"));
        assert!(md.contains("(2 failed of 3 requests)"));
        assert!(md.contains("| GET | https://a.dev/x | net::ERR_FAILED |"));
        assert!(md.contains("Screenshot: /tmp/shot.png"));
    }

    #[test]
    fn empty_sections_say_none() {
        let tab = Tab::new(dive_core::WorkspaceId::new(), "https://a.dev/", 0);
        let md = compose(&tab, &[], &[], None);
        assert!(md.contains("### Console (0 errors/warnings)\n\nNone."));
        assert!(md.contains("### Network (0 failed of 0 requests)\n\nNone."));
    }
}
