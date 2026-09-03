//! Page metadata for the Meta/SEO panel: title, description, canonical,
//! Open Graph and Twitter tags, parsed from the document head.

use std::collections::BTreeMap;

use dive_cdp::CdpSession;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;

use crate::error::{AppError, AppResult};

/// Parsed head metadata.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct MetaSnapshot {
    /// `<title>`.
    pub title: String,
    /// `<meta name="description">`.
    pub description: Option<String>,
    /// `<link rel="canonical">`.
    pub canonical: Option<String>,
    /// `<html lang>`.
    pub lang: Option<String>,
    /// `<meta name="viewport">`.
    pub viewport: Option<String>,
    /// `<meta name="robots">`.
    pub robots: Option<String>,
    /// `og:*` properties without the prefix.
    pub og: BTreeMap<String, String>,
    /// `twitter:*` names without the prefix.
    pub twitter: BTreeMap<String, String>,
    /// Icon hrefs from `<link rel*="icon">`.
    pub icons: Vec<String>,
}

/// Read the head of a tab and parse it.
pub async fn snapshot(session: &CdpSession) -> AppResult<MetaSnapshot> {
    let result = session
        .call(
            "Runtime.evaluate",
            json!({
                "expression": "JSON.stringify({head: document.head ? document.head.outerHTML : '', lang: document.documentElement.lang || ''})",
                "returnByValue": true
            }),
        )
        .await
        .map_err(AppError::new)?;
    let raw = result["result"]["value"].as_str().unwrap_or("{}");
    let v: serde_json::Value = serde_json::from_str(raw).unwrap_or_default();
    let mut snap = parse_head(v["head"].as_str().unwrap_or_default());
    snap.lang = v["lang"]
        .as_str()
        .filter(|l| !l.is_empty())
        .map(str::to_owned);
    Ok(snap)
}

/// Parse `<head>` HTML. Tolerant scanner, not a full HTML parser: it walks
/// `<title>`, `<meta>` and `<link>` tags and reads their attributes.
pub fn parse_head(html: &str) -> MetaSnapshot {
    let mut snap = MetaSnapshot::default();
    let lower = html.to_ascii_lowercase();
    if let Some(start) = lower.find("<title")
        && let Some(gt) = lower[start..].find('>')
        && let Some(end) = lower[start + gt..].find("</title>")
    {
        snap.title = decode(html[start + gt + 1..start + gt + end].trim());
    }
    for tag in tags(html) {
        let attrs = attributes(tag);
        let get = |k: &str| attrs.get(k).cloned();
        let name = tag[1..].trim_start().to_ascii_lowercase();
        if name.starts_with("meta") {
            let content = get("content").unwrap_or_default();
            if let Some(prop) = get("property").or_else(|| get("name")) {
                let key = prop.to_ascii_lowercase();
                if let Some(rest) = key.strip_prefix("og:") {
                    snap.og.entry(rest.to_owned()).or_insert(content);
                } else if let Some(rest) = key.strip_prefix("twitter:") {
                    snap.twitter.entry(rest.to_owned()).or_insert(content);
                } else {
                    let slot = match key.as_str() {
                        "description" => &mut snap.description,
                        "viewport" => &mut snap.viewport,
                        "robots" => &mut snap.robots,
                        _ => continue,
                    };
                    slot.get_or_insert(content);
                }
            }
        } else if name.starts_with("link") {
            let rel = get("rel").unwrap_or_default().to_ascii_lowercase();
            let Some(href) = get("href") else { continue };
            if rel.split_whitespace().any(|r| r == "canonical") {
                snap.canonical.get_or_insert(href);
            } else if rel.contains("icon") {
                snap.icons.push(href);
            }
        }
    }
    snap
}

/// Every `<...>` tag slice, skipping comments, doctype and closing tags.
fn tags(html: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(i) = rest.find('<') {
        rest = &rest[i..];
        if rest.starts_with("<!--") {
            match rest.find("-->") {
                Some(e) => rest = &rest[e + 3..],
                None => break,
            }
            continue;
        }
        let Some(end) = rest.find('>') else { break };
        let tag = &rest[..=end];
        if !tag.starts_with("</") && !tag.starts_with("<!") {
            out.push(tag);
        }
        rest = &rest[end + 1..];
    }
    out
}

/// Attribute map of one tag: keys lowercased, values entity-decoded.
fn attributes(tag: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let body = tag
        .trim_start_matches('<')
        .trim_end_matches('>')
        .trim_end_matches('/');
    let after_name = body.find(char::is_whitespace).map_or("", |i| &body[i..]);
    let mut s = after_name.trim_start();
    while !s.is_empty() {
        let name_end = s
            .find(|c: char| c.is_whitespace() || c == '=')
            .unwrap_or(s.len());
        let name = s[..name_end].to_ascii_lowercase();
        let after = s[name_end..].trim_start();
        if let Some(after_eq) = after.strip_prefix('=') {
            let after_eq = after_eq.trim_start();
            let (value, rest) = if let Some(q @ ('"' | '\'')) = after_eq.chars().next() {
                let inner = &after_eq[1..];
                let end = inner.find(q).unwrap_or(inner.len());
                (inner[..end].to_owned(), inner.get(end + 1..).unwrap_or(""))
            } else {
                let end = after_eq.find(char::is_whitespace).unwrap_or(after_eq.len());
                (after_eq[..end].to_owned(), &after_eq[end..])
            };
            if !name.is_empty() {
                out.insert(name, decode(&value));
            }
            s = rest.trim_start();
        } else {
            if !name.is_empty() {
                out.insert(name, String::new());
            }
            s = after;
            if name_end == 0 {
                s = &s[1..];
            }
        }
    }
    out
}

/// The handful of entities that show up in metadata.
fn decode(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_head() {
        let html = r#"<head>
            <meta charset="utf-8">
            <title> Dive &amp; Co </title>
            <meta name="description" content="A browser for people who build the web">
            <meta property="og:title" content="Dive">
            <meta property="og:image" content="https://a.dev/og.png">
            <meta name="twitter:card" content="summary_large_image">
            <meta name=viewport content="width=device-width, initial-scale=1">
            <!-- <meta name="robots" content="noindex"> -->
            <link rel="canonical" href="https://a.dev/">
            <link rel="shortcut icon" href="/favicon.ico">
            <link rel='apple-touch-icon' href='/apple.png' />
        </head>"#;
        let m = parse_head(html);
        assert_eq!(m.title, "Dive & Co");
        assert_eq!(
            m.description.as_deref(),
            Some("A browser for people who build the web")
        );
        assert_eq!(m.og["title"], "Dive");
        assert_eq!(m.og["image"], "https://a.dev/og.png");
        assert_eq!(m.twitter["card"], "summary_large_image");
        assert_eq!(
            m.viewport.as_deref(),
            Some("width=device-width, initial-scale=1")
        );
        assert_eq!(m.robots, None, "commented-out tag must be ignored");
        assert_eq!(m.canonical.as_deref(), Some("https://a.dev/"));
        assert_eq!(m.icons, vec!["/favicon.ico", "/apple.png"]);
    }

    #[test]
    fn first_value_wins_and_empty_head_is_fine() {
        let m = parse_head(
            r#"<meta name="description" content="one"><meta name="description" content="two">"#,
        );
        assert_eq!(m.description.as_deref(), Some("one"));
        assert_eq!(parse_head(""), MetaSnapshot::default());
    }
}
