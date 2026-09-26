//! What the search engine thinks you are typing.
//!
//! The address bar has always answered from what Dive already knows -- open
//! tabs, bookmarks, history -- which is nothing at all for a half-remembered
//! phrase you have never visited. These are the engine's own completions.
//!
//! Every keystroke in the address bar would otherwise go to a search engine,
//! so this is a preference (`search_suggestions`), it is off in a private
//! session whatever the preference says, and the request carries no cookies,
//! no referrer and no history -- just the letters typed.

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::Value;

use crate::error::{AppError, AppResult};

/// Completions asked for and returned, at most.
const LIMIT: usize = 8;
/// The longest query worth asking about.
const MAX_QUERY: usize = 200;
/// A suggestion the engine sends that is longer than this is not a suggestion.
const MAX_SUGGESTION: usize = 200;
/// Past this the answer is no longer useful to someone still typing.
const TIMEOUT: Duration = Duration::from_millis(2500);

/// Where each engine answers completions, as a template.
///
/// Every one of these returns the `OpenSearch` shape: `["typed", ["first",
/// "second", ...]]`. `Kagi` has no public completion endpoint and `Startpage`'s
/// needs a session, so both fall back to `DuckDuckGo`'s, which answers without
/// one -- a search engine's suggestions, not the searcher's identity.
const ENDPOINTS: &[(&str, &str)] = &[
    (
        "duckduckgo",
        "https://duckduckgo.com/ac/?type=list&q={query}",
    ),
    (
        "google",
        // Without `oe` Google answers in a legacy charset picked from the
        // query's language, which reads as mojibake once decoded as UTF-8.
        "https://suggestqueries.google.com/complete/search?client=firefox&oe=utf-8&q={query}",
    ),
    ("bing", "https://api.bing.com/osjson.aspx?query={query}"),
    ("brave", "https://search.brave.com/api/suggest?q={query}"),
];

/// The endpoint for an engine key, or `None` when nothing sensible fits --
/// a custom engine, whose completion endpoint Dive cannot guess.
fn endpoint_for(engine: &str) -> Option<&'static str> {
    if engine == "custom" {
        return None;
    }
    ENDPOINTS
        .iter()
        .find(|(key, _)| *key == engine)
        .or_else(|| ENDPOINTS.first())
        .map(|(_, template)| *template)
}

/// The one client every completion request goes through.
///
/// A client owns its connection pool, so building one per request opened a
/// fresh TLS connection to the engine for every keystroke; shared, the
/// connection from the last letter is still open for the next. It still keeps
/// no cookie store, so sharing it carries nothing from one query to the next.
fn client() -> AppResult<&'static reqwest::Client> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let built = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(AppError::new)?;
    Ok(CLIENT.get_or_init(|| built))
}

/// The completions in an `OpenSearch` reply, cleaned up.
///
/// Engines differ in what they put in the second element -- plain strings for
/// most, objects with a `phrase` for `Brave` -- and any of them can send more,
/// longer, or emptier suggestions than are worth showing.
pub fn parse(body: &str, typed: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    let list = match &value {
        Value::Array(items) => items.get(1).cloned().unwrap_or(Value::Null),
        // Brave answers with a bare array of objects.
        _ => Value::Null,
    };
    let items = match list {
        Value::Array(items) => items,
        _ => match value {
            Value::Array(items) => items,
            _ => return Vec::new(),
        },
    };
    let mut out = Vec::new();
    for item in items {
        let text = match item {
            Value::String(text) => text,
            Value::Object(ref map) => map
                .get("phrase")
                .or_else(|| map.get("q"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            _ => continue,
        };
        let text = text.trim();
        if text.is_empty() || text.len() > MAX_SUGGESTION {
            continue;
        }
        // The engine repeating what was typed adds nothing: that row is
        // already the first thing the address bar offers.
        if text.eq_ignore_ascii_case(typed.trim()) {
            continue;
        }
        let text = text.to_owned();
        if !out.contains(&text) {
            out.push(text);
        }
        if out.len() >= LIMIT {
            break;
        }
    }
    out
}

/// Ask the engine what this query might be. An engine that is slow, down or
/// unparseable yields nothing rather than an error the address bar would
/// have to show.
pub async fn suggest(engine: &str, query: &str) -> AppResult<Vec<String>> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > MAX_QUERY {
        return Ok(Vec::new());
    }
    let Some(template) = endpoint_for(engine) else {
        return Ok(Vec::new());
    };
    let url = template.replace(
        "{query}",
        &url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>(),
    );
    let response = match client()?.get(&url).send().await {
        Ok(response) => response,
        Err(error) => {
            tracing::debug!(%engine, "suggestions unavailable: {error}");
            return Ok(Vec::new());
        }
    };
    if !response.status().is_success() {
        return Ok(Vec::new());
    }
    let body = response.text().await.unwrap_or_default();
    Ok(parse(&body, query))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_opensearch_shape_every_engine_answers_with() {
        let body = r#"["weat", ["weather", "weather tomorrow", "weather radar"]]"#;
        assert_eq!(
            parse(body, "weat"),
            vec!["weather", "weather tomorrow", "weather radar"]
        );
    }

    #[test]
    fn reads_the_objects_brave_answers_with() {
        let body = r#"[{"phrase":"rust book"},{"phrase":"rust lang"}]"#;
        assert_eq!(parse(body, "rust"), vec!["rust book", "rust lang"]);
    }

    #[test]
    fn drops_what_was_typed_duplicates_and_nonsense() {
        let body = r#"["rust", ["rust", "rust", "  ", "rust book", 7, null]]"#;
        assert_eq!(parse(body, "rust"), vec!["rust book"]);
        assert!(parse("not json", "rust").is_empty());
        assert!(parse("{}", "rust").is_empty());
    }

    #[test]
    fn keeps_the_list_short() {
        let many: Vec<String> = (0..50).map(|n| format!("query {n}")).collect();
        let body = serde_json::to_string(&("q", &many)).unwrap();
        assert_eq!(parse(&body, "q").len(), LIMIT);
    }

    #[test]
    fn an_unknown_engine_falls_back_and_a_custom_one_asks_nobody() {
        assert!(endpoint_for("custom").is_none());
        assert_eq!(endpoint_for("kagi"), endpoint_for("duckduckgo"));
        assert!(endpoint_for("google").unwrap().contains("suggestqueries"));
        assert!(endpoint_for("google").unwrap().contains("oe=utf-8"));
    }

    #[test]
    fn every_request_shares_one_client() {
        assert!(std::ptr::eq(client().unwrap(), client().unwrap()));
    }

    #[tokio::test]
    async fn an_empty_or_oversized_query_asks_nobody() {
        assert!(suggest("duckduckgo", "   ").await.unwrap().is_empty());
        let long = "x".repeat(MAX_QUERY + 1);
        assert!(suggest("duckduckgo", &long).await.unwrap().is_empty());
        assert!(suggest("custom", "weather").await.unwrap().is_empty());
    }
}
