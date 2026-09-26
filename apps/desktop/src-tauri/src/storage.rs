//! Storage inspector: cookies plus local/session storage for a tab, read over CDP.

use dive_cdp::CdpSession;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;

use crate::error::{AppError, AppResult};

/// Bytes of a value the panel is sent. A page can keep megabytes under one
/// key -- a serialised store, a cached response -- and sending all of it to
/// show one truncated line froze the dock. The rest is a copy away (see
/// [`value`]).
pub const VALUE_SHOWN: usize = 2048;

/// `value` cut to [`VALUE_SHOWN`] bytes on a character boundary, and how
/// long it was.
fn shown(value: &str) -> (String, u32) {
    let size = u32::try_from(value.len()).unwrap_or(u32::MAX);
    if value.len() <= VALUE_SHOWN {
        return (value.to_owned(), size);
    }
    let mut cut = VALUE_SHOWN;
    while !value.is_char_boundary(cut) {
        cut -= 1;
    }
    (value[..cut].to_owned(), size)
}

/// One cookie.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Cookie {
    /// Name.
    pub name: String,
    /// Value, cut to [`VALUE_SHOWN`] bytes.
    pub value: String,
    /// Length of the whole value in bytes.
    pub size: u32,
    /// Domain.
    pub domain: String,
    /// Path.
    pub path: String,
    /// Expiry as seconds since the epoch; `-1` for session cookies.
    pub expires: f64,
    /// `HttpOnly` flag.
    pub http_only: bool,
    /// `Secure` flag.
    pub secure: bool,
    /// `SameSite` value, if any.
    pub same_site: Option<String>,
}

/// One `localStorage` or `sessionStorage` entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct StorageItem {
    /// Key.
    pub key: String,
    /// Value, cut to [`VALUE_SHOWN`] bytes.
    pub value: String,
    /// Length of the whole value in bytes.
    pub size: u32,
}

/// Everything the Storage panel shows.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct StorageSnapshot {
    /// Cookies visible to the page's URL.
    pub cookies: Vec<Cookie>,
    /// `localStorage` entries.
    pub local: Vec<StorageItem>,
    /// `sessionStorage` entries.
    pub session: Vec<StorageItem>,
}

/// Read cookies and both storages for `url`.
pub async fn snapshot(session: &CdpSession, url: &str) -> AppResult<StorageSnapshot> {
    let origin = url::Url::parse(url)
        .ok()
        .map(|u| u.origin().ascii_serialization())
        .unwrap_or_default();
    let cookies = session
        .call("Network.getCookies", json!({"urls": [url]}))
        .await
        .map_err(AppError::new)?;
    let local = storage_items(session, &origin, true)
        .await
        .unwrap_or_default();
    let sess = storage_items(session, &origin, false)
        .await
        .unwrap_or_default();
    Ok(StorageSnapshot {
        cookies: parse_cookies(&cookies),
        local,
        session: sess,
    })
}

async fn storage_items(
    session: &CdpSession,
    origin: &str,
    is_local: bool,
) -> AppResult<Vec<StorageItem>> {
    Ok(parse_items(&raw_items(session, origin, is_local).await?))
}

async fn raw_items(session: &CdpSession, origin: &str, is_local: bool) -> AppResult<Value> {
    if origin.is_empty() || origin == "null" {
        return Ok(Value::Null);
    }
    session
        .call(
            "DOMStorage.getDOMStorageItems",
            json!({"storageId": {"securityOrigin": origin, "isLocalStorage": is_local}}),
        )
        .await
        .map_err(AppError::new)
}

fn origin_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .map(|u| u.origin().ascii_serialization())
        .unwrap_or_default()
}

/// One value in full: a cookie by name, domain and path, or a web-storage
/// key. `None` when it has gone since the panel read it.
pub async fn value(
    session: &CdpSession,
    url: &str,
    section: &str,
    key: &str,
    domain: Option<&str>,
    path: Option<&str>,
) -> AppResult<Option<String>> {
    match section {
        "cookies" => {
            let result = session
                .call("Network.getCookies", json!({"urls": [url]}))
                .await
                .map_err(AppError::new)?;
            Ok(result["cookies"].as_array().and_then(|list| {
                list.iter()
                    .find(|c| {
                        c["name"].as_str() == Some(key)
                            && domain.is_none_or(|d| c["domain"].as_str() == Some(d))
                            && path.is_none_or(|p| c["path"].as_str() == Some(p))
                    })
                    .and_then(|c| c["value"].as_str().map(str::to_owned))
            }))
        }
        "local" | "session" => {
            let raw = raw_items(session, &origin_of(url), section == "local").await?;
            Ok(raw["entries"].as_array().and_then(|list| {
                list.iter()
                    .find(|e| e.get(0).and_then(Value::as_str) == Some(key))
                    .map(|e| {
                        e.get(1)
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned()
                    })
            }))
        }
        other => Err(AppError::new(format!("unknown storage section: {other}"))),
    }
}

/// Remove one entry: a cookie by name, domain and path, or a web-storage
/// key for the page's origin. The page sees the change at once.
pub async fn delete(
    session: &CdpSession,
    url: &str,
    section: &str,
    key: &str,
    domain: Option<&str>,
    path: Option<&str>,
) -> AppResult<()> {
    match section {
        "cookies" => {
            let mut params = json!({"name": key});
            if let Some(domain) = domain {
                params["domain"] = json!(domain);
            }
            if let Some(path) = path {
                params["path"] = json!(path);
            }
            if domain.is_none() {
                params["url"] = json!(url);
            }
            session
                .call("Network.deleteCookies", params)
                .await
                .map_err(AppError::new)?;
        }
        "local" | "session" => {
            let origin = url::Url::parse(url)
                .ok()
                .map(|u| u.origin().ascii_serialization())
                .unwrap_or_default();
            if origin.is_empty() || origin == "null" {
                return Err(AppError::new("this page has no storage of its own"));
            }
            session
                .call(
                    "DOMStorage.removeDOMStorageItem",
                    json!({"storageId": {"securityOrigin": origin, "isLocalStorage": section == "local"}, "key": key}),
                )
                .await
                .map_err(AppError::new)?;
        }
        other => return Err(AppError::new(format!("unknown storage section: {other}"))),
    }
    Ok(())
}

/// `Network.getCookies` result to rows.
pub fn parse_cookies(result: &Value) -> Vec<Cookie> {
    result["cookies"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|c| {
                    let (value, size) = shown(c["value"].as_str().unwrap_or_default());
                    Cookie {
                        name: c["name"].as_str().unwrap_or_default().to_owned(),
                        value,
                        size,
                        domain: c["domain"].as_str().unwrap_or_default().to_owned(),
                        path: c["path"].as_str().unwrap_or_default().to_owned(),
                        expires: c["expires"].as_f64().unwrap_or(-1.0),
                        http_only: c["httpOnly"].as_bool().unwrap_or(false),
                        secure: c["secure"].as_bool().unwrap_or(false),
                        same_site: c["sameSite"].as_str().map(str::to_owned),
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `DOMStorage.getDOMStorageItems` result to rows.
pub fn parse_items(result: &Value) -> Vec<StorageItem> {
    result["entries"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|e| {
                    let key = e.get(0)?.as_str()?.to_owned();
                    let (value, size) = shown(e.get(1)?.as_str().unwrap_or_default());
                    Some(StorageItem { key, value, size })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cookies_and_items() {
        let cookies = parse_cookies(&json!({"cookies": [
            {"name": "sid", "value": "abc", "domain": ".a.dev", "path": "/", "expires": -1, "httpOnly": true, "secure": true, "sameSite": "Lax"},
            {"name": "x", "value": "1", "domain": "a.dev", "path": "/p", "expires": 1.7e9}
        ]}));
        assert_eq!(cookies.len(), 2);
        assert_eq!(cookies[0].same_site.as_deref(), Some("Lax"));
        assert!(cookies[0].http_only && cookies[0].secure);
        assert_eq!(cookies[1].same_site, None);

        let items = parse_items(&json!({"entries": [["a", "1"], ["b", "2"], ["bad"]]}));
        let keys: Vec<_> = items
            .iter()
            .map(|i| (i.key.as_str(), i.value.as_str(), i.size))
            .collect();
        assert_eq!(keys, [("a", "1", 1), ("b", "2", 1)]);
        assert!(parse_items(&json!({})).is_empty());
    }

    #[test]
    fn large_values_are_cut_short_and_say_how_long_they_were() {
        let big = "é".repeat(VALUE_SHOWN);
        let items = parse_items(&json!({"entries": [["blob", big]]}));
        assert!(items[0].value.len() <= VALUE_SHOWN);
        assert!(big.starts_with(&items[0].value));
        assert_eq!(items[0].size as usize, big.len());
        let cookies = parse_cookies(
            &json!({"cookies": [{"name": "c", "value": "v".repeat(VALUE_SHOWN + 1)}]}),
        );
        assert_eq!(cookies[0].value.len(), VALUE_SHOWN);
        assert_eq!(cookies[0].size as usize, VALUE_SHOWN + 1);
    }
}
