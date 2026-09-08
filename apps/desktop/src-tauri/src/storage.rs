//! Storage inspector: cookies plus local/session storage for a tab, read over CDP.

use dive_cdp::CdpSession;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;

use crate::error::{AppError, AppResult};

/// One cookie.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Cookie {
    /// Name.
    pub name: String,
    /// Value.
    pub value: String,
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

/// Everything the Storage panel shows.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct StorageSnapshot {
    /// Cookies visible to the page's URL.
    pub cookies: Vec<Cookie>,
    /// `localStorage` entries as `[key, value]`.
    pub local: Vec<[String; 2]>,
    /// `sessionStorage` entries as `[key, value]`.
    pub session: Vec<[String; 2]>,
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
) -> AppResult<Vec<[String; 2]>> {
    if origin.is_empty() || origin == "null" {
        return Ok(Vec::new());
    }
    let result = session
        .call(
            "DOMStorage.getDOMStorageItems",
            json!({"storageId": {"securityOrigin": origin, "isLocalStorage": is_local}}),
        )
        .await
        .map_err(AppError::new)?;
    Ok(parse_items(&result))
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
                .map(|c| Cookie {
                    name: c["name"].as_str().unwrap_or_default().to_owned(),
                    value: c["value"].as_str().unwrap_or_default().to_owned(),
                    domain: c["domain"].as_str().unwrap_or_default().to_owned(),
                    path: c["path"].as_str().unwrap_or_default().to_owned(),
                    expires: c["expires"].as_f64().unwrap_or(-1.0),
                    http_only: c["httpOnly"].as_bool().unwrap_or(false),
                    secure: c["secure"].as_bool().unwrap_or(false),
                    same_site: c["sameSite"].as_str().map(str::to_owned),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `DOMStorage.getDOMStorageItems` result to `[key, value]` rows.
pub fn parse_items(result: &Value) -> Vec<[String; 2]> {
    result["entries"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|e| {
                    let k = e.get(0)?.as_str()?;
                    let v = e.get(1)?.as_str().unwrap_or_default();
                    Some([k.to_owned(), v.to_owned()])
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
        assert_eq!(
            items,
            vec![
                ["a".to_owned(), "1".to_owned()],
                ["b".to_owned(), "2".to_owned()]
            ]
        );
        assert!(parse_items(&json!({})).is_empty());
    }
}
