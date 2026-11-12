//! Tier 2: Boundary & Corner Cases — Requirement R4 (Developer Features Stress & Boundary)

use std::sync::Arc;

use dive_cdp::CdpSession;
use dive_mcp::{Config, serve};

use crate::fixtures::{MockCdpTransport, TestFakeBrowser};

#[tokio::test]
async fn test_mcp_invalid_bearer_token_variations() {
    let fake = Arc::new(TestFakeBrowser::default());
    let token = "valid-secret-999";
    let config = Config {
        token: Some(token.to_string()),
        allow_evaluate: false,
    };

    let server_handle = serve(fake, config, "127.0.0.1:0".parse().unwrap())
        .await
        .expect("Failed to bind MCP server");

    let client = crate::fixtures::http_client();
    let url = server_handle.url();

    let invalid_headers = [
        "",                        // Missing auth header
        "Bearer ",                 // Empty bearer token
        "Bearer wrong-token-123",  // Incorrect token
        "Basic dXNlcjpwYXNz",      // Basic auth instead of Bearer
        "Bearer null",             // Null literal
        "Token valid-secret-999",  // Wrong scheme
        "bearer valid-secret-999", // Lowercase scheme
    ];

    for auth in invalid_headers {
        let mut req = client.post(&url);
        if !auth.is_empty() {
            req = req.header("Authorization", auth);
        }
        let send_res = req.send().await;
        match send_res {
            Ok(resp) => {
                assert_eq!(
                    resp.status(),
                    reqwest::StatusCode::UNAUTHORIZED,
                    "Auth header {:?} must be rejected with 401 Unauthorized",
                    auth
                );
            }
            Err(e) => {
                crate::fixtures::loopback_blocked_or_fail(&e);
                return;
            }
        }
    }
}

#[tokio::test]
async fn test_mcp_untrusted_origin_rejection() {
    let fake = Arc::new(TestFakeBrowser::default());
    let token = "test-token";
    let config = Config {
        token: Some(token.to_string()),
        allow_evaluate: false,
    };

    let server_handle = serve(fake, config, "127.0.0.1:0".parse().unwrap())
        .await
        .expect("Failed to bind MCP server");

    let client = crate::fixtures::http_client();
    let url = server_handle.url();

    let untrusted_origins = [
        // A localhost web page is still a web page, even with a valid token.
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:3000",
        "http://malicious-site.com",
        "https://evil.org",
        "http://192.168.1.100:8080",
        "https://phishing.local",
    ];

    for origin in untrusted_origins {
        let send_res = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Origin", origin)
            .send()
            .await;

        match send_res {
            Ok(resp) => {
                assert_eq!(
                    resp.status(),
                    reqwest::StatusCode::FORBIDDEN,
                    "Untrusted origin {:?} must be rejected with 403 Forbidden",
                    origin
                );
            }
            Err(e) => {
                crate::fixtures::loopback_blocked_or_fail(&e);
                return;
            }
        }
    }
}

#[test]
fn test_malformed_and_oversized_cdp_payload() {
    let transport = MockCdpTransport::new();
    let session = CdpSession::new(transport);

    // Malformed JSON should not panic or corrupt session
    let broken_json = r#"{"id": 10000001, "result": { unclosed_bracket"#;
    let handled = session.handle_incoming(broken_json);
    assert!(handled.is_err(), "Broken JSON should be safely ignored");

    // Oversized (1MB) string payload handled safely
    let large_string = "A".repeat(1024 * 1024);
    let large_json = format!(
        r#"{{"id": 10000002, "result": {{"result": {{"value": "{}"}}}}}}"#,
        large_string
    );
    let handled_large = session.handle_incoming(&large_json);
    assert!(
        handled_large.is_ok(),
        "Large CDP message should be handled cleanly"
    );
}
