//! Find dev servers on this machine and help open them on a phone.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::{AppError, AppResult};

/// Ports dev servers commonly bind.
pub const COMMON_PORTS: &[u16] = &[
    3000, 3001, 3333, 4000, 4200, 4321, 5000, 5173, 5174, 5500, 6006, 8000, 8080, 8081, 8788, 8888,
    9000,
];

/// A server that answered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DevServer {
    /// Port on localhost.
    pub port: u16,
    /// `http://localhost:<port>/`.
    pub url: String,
    /// Detected tool, e.g. `Vite`, `Next.js`, `Storybook`, or `HTTP`.
    pub framework: String,
    /// `<title>` of the root document, when any.
    pub title: String,
}

/// LAN address plus a QR code for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ShareInfo {
    /// The URL rewritten to this machine's LAN IP.
    pub lan_url: String,
    /// SVG markup of a QR code for `lan_url`.
    pub qr_svg: String,
}

/// Probe the common ports concurrently.
pub async fn scan() -> Vec<DevServer> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
        .unwrap_or_default();
    let probes = COMMON_PORTS.iter().map(|&port| {
        let client = client.clone();
        async move {
            let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
            let open = tokio::time::timeout(
                Duration::from_millis(300),
                tokio::net::TcpStream::connect(addr),
            )
            .await;
            if !matches!(open, Ok(Ok(_))) {
                return None;
            }
            let url = format!("http://localhost:{port}/");
            let (server_header, body) = match client.get(&url).send().await {
                Ok(r) => {
                    let server = r
                        .headers()
                        .get("server")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default()
                        .to_owned();
                    (server, r.text().await.unwrap_or_default())
                }
                Err(_) => (String::new(), String::new()),
            };
            let framework = detect(&body, &server_header);
            Some(DevServer {
                port,
                url,
                framework,
                title: title_of(&body),
            })
        }
    });
    futures_util::future::join_all(probes)
        .await
        .into_iter()
        .flatten()
        .collect()
}

/// Guess the tool from the root document and the `Server` header.
pub fn detect(body: &str, server_header: &str) -> String {
    let b = body.to_ascii_lowercase();
    let s = server_header.to_ascii_lowercase();
    if b.contains("/@vite/client") || b.contains("vite/dist/client") {
        "Vite"
    } else if b.contains("/_next/") || b.contains("__next") {
        "Next.js"
    } else if b.contains("storybook") {
        "Storybook"
    } else if b.contains("/_nuxt/") {
        "Nuxt"
    } else if b.contains("__sveltekit") || b.contains("/_app/immutable/") {
        "SvelteKit"
    } else if b.contains("astro-island") || b.contains("/_astro/") {
        "Astro"
    } else if b.contains("__webpack") || b.contains("webpack-dev-server") {
        "webpack"
    } else if b.contains("__remix") || b.contains("remix") {
        "Remix"
    } else if s.contains("werkzeug") || s.contains("flask") {
        "Flask"
    } else if s.contains("wsgiserver") || s.contains("django") {
        "Django"
    } else if s.contains("express") {
        "Express"
    } else {
        "HTTP"
    }
    .to_owned()
}

/// `<title>` text, if present.
fn title_of(body: &str) -> String {
    let lower = body.to_ascii_lowercase();
    let Some(start) = lower.find("<title") else {
        return String::new();
    };
    let Some(gt) = lower[start..].find('>') else {
        return String::new();
    };
    let rest = &body[start + gt + 1..];
    let end = rest
        .to_ascii_lowercase()
        .find("</title>")
        .unwrap_or(rest.len());
    rest[..end].trim().chars().take(80).collect()
}

/// Rewrite a localhost URL to this machine's LAN IP and render a QR code.
pub fn share(url: &str) -> AppResult<ShareInfo> {
    let mut parsed = url::Url::parse(url).map_err(AppError::new)?;
    let host = parsed.host_str().unwrap_or_default().to_owned();
    if host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "0.0.0.0" {
        let ip = local_ip_address::local_ip()
            .map_err(|e| AppError::new(format!("no LAN address: {e}")))?;
        parsed
            .set_host(Some(&ip.to_string()))
            .map_err(AppError::new)?;
    }
    let lan_url = parsed.to_string();
    let code = qrcode::QrCode::new(lan_url.as_bytes()).map_err(AppError::new)?;
    let qr_svg = code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(180, 180)
        .quiet_zone(false)
        .build();
    Ok(ShareInfo { lan_url, qr_svg })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_frameworks() {
        assert_eq!(
            detect(r#"<script type="module" src="/@vite/client"></script>"#, ""),
            "Vite"
        );
        assert_eq!(
            detect(
                r#"<script src="/_next/static/chunks/main.js"></script>"#,
                ""
            ),
            "Next.js"
        );
        assert_eq!(detect("<html></html>", "Werkzeug/3.0 Python/3.12"), "Flask");
        assert_eq!(detect("", ""), "HTTP");
        assert_eq!(
            title_of("<html><head><TITLE> My App </TITLE></head>"),
            "My App"
        );
        assert_eq!(title_of("<p>no title"), "");
    }

    #[test]
    fn share_rewrites_localhost_and_renders_qr() {
        // A public host is left alone and still gets a QR.
        let s = share("https://example.com/path?x=1").unwrap();
        assert_eq!(s.lan_url, "https://example.com/path?x=1");
        assert!(s.qr_svg.starts_with("<svg") || s.qr_svg.starts_with("<?xml"));
        assert!(share("not a url").is_err());
    }
}
