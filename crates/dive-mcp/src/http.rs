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

/// `null` (non-browser client) or a loopback host, compared on the parsed
/// host rather than a string prefix so `localhost.evil.com` is rejected.
fn origin_is_local(origin: &str) -> bool {
    if origin == "null" {
        return true;
    }
    url::Url::parse(origin)
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| h == "localhost" || h == "127.0.0.1" || h == "[::1]")
        })
        .unwrap_or(false)
}

/// Reject requests that do not carry the bearer token, or that come from a
/// browser origin (DNS rebinding sends an `Origin` header; local MCP clients do not).
async fn guard(
    axum::extract::State(token): axum::extract::State<Option<Arc<str>>>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::http::{StatusCode, header};
    use axum::response::IntoResponse as _;
    let headers = request.headers();
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok())
        && !origin_is_local(origin)
    {
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    if let Some(expected) = token.as_deref() {
        let presented = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "));
        if presented != Some(expected) {
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
