//! The streamable-HTTP transport on loopback, with token and origin checks.

use std::net::SocketAddr;
use std::sync::Arc;

use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use tokio_util::sync::CancellationToken;

use crate::browser::Browser;
use crate::server::{Config, DiveServer};

/// A running server.
pub struct Handle {
    /// Where it listens.
    pub addr: SocketAddr,
    cancel: CancellationToken,
}

impl Handle {
    /// The URL to give an MCP client.
    pub fn url(&self) -> String {
        format!("http://{}/mcp", self.addr)
    }

    /// Stop serving.
    pub fn shutdown(&self) {
        self.cancel.cancel();
    }
}

/// Headers only a browser sends. A local MCP client -- a CLI, an editor, a
/// script -- sends none of them, so their presence means a web page is the
/// one asking, whatever origin it claims.
///
/// Every value of `Origin` counts, including `null` and a loopback host on
/// some other port: `null` is what a sandboxed iframe or a `data:` page
/// sends, and a dev server on `localhost:3000` is just as much a web page as
/// one on the internet. Allowing either would let any page the person opens
/// drive the browser, with only the token standing in the way.
const BROWSER_HEADERS: &[&str] = &[
    "origin",
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-dest",
];

/// Whether the request came from a web page rather than a local client.
fn from_a_browser(headers: &axum::http::HeaderMap) -> bool {
    BROWSER_HEADERS
        .iter()
        .any(|name| headers.contains_key(*name))
}

/// Whether the `Host` header names this machine.
///
/// DNS rebinding points a name the attacker controls at 127.0.0.1, so the
/// request arrives here with that name in `Host`. A missing header is left to
/// the other checks: HTTP/1.0 clients may omit it, and a browser never does.
fn host_is_loopback(headers: &axum::http::HeaderMap) -> bool {
    let Some(host) = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
    else {
        return true;
    };
    let Ok(parsed) = url::Url::parse(&format!("http://{host}/")) else {
        return false;
    };
    match parsed.host() {
        Some(url::Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// Compare two secrets in time that depends only on their lengths.
///
/// An early return on the first differing byte tells a caller who can time
/// the answer how much of its guess was right, and a guess can then be
/// grown one byte at a time. The token's length is not secret: it is always
/// the same.
pub(crate) fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Reject requests that do not carry the bearer token, that come from a web
/// page, or that were addressed to a name other than this machine's.
async fn guard(
    axum::extract::State(token): axum::extract::State<Option<Arc<str>>>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::http::{StatusCode, header};
    use axum::response::IntoResponse as _;
    let headers = request.headers();
    if from_a_browser(headers) {
        return (
            StatusCode::FORBIDDEN,
            "requests from web pages are not allowed",
        )
            .into_response();
    }
    if !host_is_loopback(headers) {
        return (StatusCode::FORBIDDEN, "host not allowed").into_response();
    }
    if let Some(expected) = token.as_deref() {
        let presented = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or_default();
        if !constant_time_eq(presented.as_bytes(), expected.as_bytes()) {
            return (StatusCode::UNAUTHORIZED, "missing or invalid bearer token").into_response();
        }
    }
    next.run(request).await
}

/// Bind `addr` (use port 0 for an ephemeral port) and serve until shut down.
pub async fn serve<B: Browser>(
    browser: Arc<B>,
    config: Config,
    addr: SocketAddr,
) -> std::io::Result<Handle> {
    let cancel = CancellationToken::new();
    let http = StreamableHttpServerConfig::default().with_cancellation_token(cancel.clone());
    let token: Option<Arc<str>> = config.token.as_deref().map(Arc::from);
    let service: StreamableHttpService<DiveServer<B>, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(DiveServer::new(Arc::clone(&browser), config.clone())),
            Arc::default(),
            http,
        );
    let router = axum::Router::new()
        .nest_service("/mcp", service)
        .layer(axum::middleware::from_fn_with_state(token, guard));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let addr = listener.local_addr()?;
    let ct = cancel.clone();
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router)
            .with_graceful_shutdown(async move { ct.cancelled_owned().await })
            .await
        {
            tracing::warn!("mcp server stopped: {e}");
        }
    });
    tracing::info!(%addr, "mcp server listening");
    Ok(Handle { addr, cancel })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderMap, HeaderValue};

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, HeaderValue::from_static(value));
        }
        map
    }

    #[test]
    fn any_origin_at_all_is_a_web_page() {
        for origin in [
            "https://evil.example",
            "null",
            "http://localhost:3000",
            "http://127.0.0.1:7391",
            "http://[::1]:8080",
        ] {
            let map = {
                let mut map = HeaderMap::new();
                map.insert("origin", HeaderValue::from_str(origin).unwrap());
                map
            };
            assert!(from_a_browser(&map), "{origin} was let through");
        }
        assert!(from_a_browser(&headers(&[("sec-fetch-mode", "no-cors")])));
        assert!(!from_a_browser(&headers(&[("authorization", "Bearer x")])));
    }

    #[test]
    fn only_loopback_names_may_address_the_server() {
        for ok in [
            "127.0.0.1:7391",
            "localhost:7391",
            "[::1]:7391",
            "127.0.0.1",
        ] {
            assert!(host_is_loopback(&headers(&[("host", ok)])), "{ok}");
        }
        for bad in [
            "evil.example:7391",
            "localhost.evil.example:7391",
            "192.168.1.4:7391",
            "0.0.0.0:7391",
        ] {
            assert!(!host_is_loopback(&headers(&[("host", bad)])), "{bad}");
        }
        assert!(host_is_loopback(&HeaderMap::new()));
    }

    #[test]
    fn tokens_compare_whole() {
        assert!(constant_time_eq(b"s3cret", b"s3cret"));
        assert!(!constant_time_eq(b"s3cret", b"s3creT"));
        assert!(!constant_time_eq(b"s3cret", b"s3cre"));
        assert!(!constant_time_eq(b"", b"s3cret"));
        assert!(constant_time_eq(b"", b""));
    }
}
