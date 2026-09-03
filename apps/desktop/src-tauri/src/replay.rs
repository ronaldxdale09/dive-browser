//! Replay a captured request with edits, using the tab's cookies.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use dive_cdp::CdpSession;
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;

use crate::error::{AppError, AppResult};

const MAX_RESPONSE_BYTES: usize = 256 * 1024;

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
    let (bytes, truncated) = read_capped(response).await?;
    let elapsed_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
    let body = body_text(&bytes, truncated);
    Ok(ReplayResponse {
        status,
        headers,
        body,
        elapsed_ms,
    })
}

/// Read at most the amount the UI can display. Stopping the stream here is
/// what prevents an unexpectedly large or endless response from consuming
/// process memory before it is truncated.
async fn read_capped(response: reqwest::Response) -> AppResult<(Vec<u8>, bool)> {
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::with_capacity(MAX_RESPONSE_BYTES.min(16 * 1024));
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(AppError::new)?;
        let remaining = MAX_RESPONSE_BYTES.saturating_sub(bytes.len());
        if chunk.len() > remaining {
            bytes.extend_from_slice(&chunk[..remaining]);
            return Ok((bytes, true));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((bytes, false))
}

fn body_text(bytes: &[u8], truncated: bool) -> String {
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => Some(text),
        // A byte cap can split the final UTF-8 scalar. Keep the valid prefix,
        // but do not turn genuinely binary data into replacement characters.
        Err(e) if truncated && e.error_len().is_none() => {
            std::str::from_utf8(&bytes[..e.valid_up_to()]).ok()
        }
        Err(_) => None,
    };
    match text {
        Some(text) if truncated => format!("{text}\n… [truncated]"),
        Some(text) => text.to_owned(),
        None if truncated => format!("<at least {} bytes of binary data>", bytes.len()),
        None => format!("<{} bytes of binary data>", bytes.len()),
    }
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

    #[test]
    fn response_text_reports_truncation_without_breaking_utf8() {
        assert_eq!(body_text(b"hello", false), "hello");
        assert!(body_text(b"hello", true).contains("[truncated]"));
        assert!(body_text(&[0xff, 0x00], false).contains("binary data"));
        let split = "hi 😀".as_bytes();
        assert_eq!(
            body_text(&split[..split.len() - 1], true),
            "hi \n… [truncated]"
        );
    }
}
