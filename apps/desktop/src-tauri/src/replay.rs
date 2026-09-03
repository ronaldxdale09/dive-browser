//! Replay a captured request with edits, using the tab's cookies.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use dive_cdp::CdpSession;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;

use crate::error::{AppError, AppResult};

/// What to send. Starts as the captured request; the user may edit it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ReplayRequest {
    /// HTTP method.
    pub method: String,
    /// Absolute URL.
    pub url: String,
    /// Headers to send (hop-by-hop ones are dropped).
    pub headers: BTreeMap<String, String>,
    /// Body text, if any.
    pub body: Option<String>,
    /// Attach the tab's cookies for this URL.
    pub with_cookies: bool,
    /// Host of the captured request; cookies are only ever sent there.
    pub captured_host: String,
}

/// What came back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ReplayResponse {
    /// HTTP status.
    pub status: u16,
    /// Response headers.
    pub headers: BTreeMap<String, String>,
    /// Body text, truncated to 256 kB; binary bodies are described.
    pub body: String,
    /// Round-trip time.
    pub elapsed_ms: u32,
}

/// Whether cookies may accompany `req`: only when it still targets the host it was captured from.
pub fn cookies_allowed(req: &ReplayRequest) -> bool {
    req.with_cookies
        && url::Url::parse(&req.url)
            .ok()
            .and_then(|u| {
                u.host_str()
                    .map(|h| h.eq_ignore_ascii_case(&req.captured_host))
            })
            .unwrap_or(false)
}

/// Headers the client sets itself or that must not be replayed.
const DROP: &[&str] = &[
    "host",
    "content-length",
    "connection",
    "cookie",
    "accept-encoding",
    "transfer-encoding",
    "upgrade",
    "keep-alive",
    "proxy-connection",
];

/// Build a `Cookie` header from the browser's cookies for `url`.
pub async fn cookie_header(session: &CdpSession, url: &str) -> Option<String> {
    let result = session
        .call("Network.getCookies", json!({"urls": [url]}))
        .await
        .ok()?;
    let pairs: Vec<String> = result["cookies"]
        .as_array()?
        .iter()
        .filter_map(|c| Some(format!("{}={}", c["name"].as_str()?, c["value"].as_str()?)))
        .collect();
    (!pairs.is_empty()).then(|| pairs.join("; "))
}

/// Send the request and collect the response.
pub async fn send(req: &ReplayRequest, cookie: Option<String>) -> AppResult<ReplayResponse> {
    let method = reqwest::Method::from_bytes(req.method.as_bytes()).map_err(AppError::new)?;
    let url = url::Url::parse(&req.url).map_err(AppError::new)?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::new("only http and https can be replayed"));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(AppError::new)?;
    let mut builder = client.request(method, url);
    for (k, v) in &req.headers {
        if !DROP.contains(&k.to_ascii_lowercase().as_str()) {
            builder = builder.header(k, v);
        }
    }
    if let Some(c) = cookie {
        builder = builder.header("cookie", c);
    }
    if let Some(body) = &req.body {
        builder = builder.body(body.clone());
    }
    let started = Instant::now();
    let response = builder.send().await.map_err(AppError::new)?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("<binary>").to_owned()))
        .collect();
    let bytes = response.bytes().await.map_err(AppError::new)?;
    let elapsed_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
    let body = match std::str::from_utf8(&bytes) {
        Ok(text) => text.chars().take(256 * 1024).collect(),
        Err(_) => format!("<{} bytes of binary data>", bytes.len()),
    };
    Ok(ReplayResponse {
        status,
        headers,
        body,
        elapsed_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_non_http_and_bad_methods() {
        let mut r = ReplayRequest {
            method: "GET".into(),
            url: "file:///etc/passwd".into(),
            headers: BTreeMap::new(),
            body: None,
            with_cookies: false,
            captured_host: String::new(),
        };
        assert!(send(&r, None).await.is_err());
        r.url = "https://example.com".into();
        r.method = "NOT A METHOD".into();
        assert!(send(&r, None).await.is_err());
    }

    #[test]
    fn cookies_only_go_to_the_captured_host() {
        let r = ReplayRequest {
            method: "GET".into(),
            url: "https://api.a.dev/x".into(),
            headers: BTreeMap::new(),
            body: None,
            with_cookies: true,
            captured_host: "api.a.dev".into(),
        };
        assert!(cookies_allowed(&r));
        let mut moved = r.clone();
        moved.url = "http://169.254.169.254/latest".into();
        assert!(!cookies_allowed(&moved));
        let mut off = r;
        off.with_cookies = false;
        assert!(!cookies_allowed(&off));
    }

    #[test]
    fn drop_list_covers_hop_by_hop() {
        for h in ["Host", "Cookie", "Content-Length"] {
            assert!(DROP.contains(&h.to_ascii_lowercase().as_str()));
        }
    }
}
