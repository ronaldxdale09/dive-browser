//! Tier 2: Boundary & Corner Cases — Requirement R4 (Developer Features Stress & Boundary)

use std::sync::Arc;

use dive_cdp::CdpSession;
use dive_core::TabId;
use dive_mcp::{Config, serve};

use crate::fixtures::{
    MockCdpTransport, RecordedInteractionStep, TestConsoleEntry, TestFakeBrowser, TestNetworkEvent,
    TestRingBufferRegistry,
};

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

    let client = reqwest::Client::new();
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
        let mut req = client.post(&url).header("Origin", "http://localhost:3000");
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
                let msg = format!("{e:?}");
                if msg.contains("PermissionDenied") || msg.contains("Operation not permitted") {
                    eprintln!(
                        "skipping: loopback TCP is blocked in this sandbox, so the HTTP contract was not exercised"
                    );
                    return;
                } else {
                    panic!("unexpected error: {e:?}");
                }
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

    let client = reqwest::Client::new();
    let url = server_handle.url();

    let untrusted_origins = [
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
                let msg = format!("{e:?}");
                if msg.contains("PermissionDenied") || msg.contains("Operation not permitted") {
                    eprintln!(
                        "skipping: loopback TCP is blocked in this sandbox, so the HTTP contract was not exercised"
                    );
                    return;
                } else {
                    panic!("unexpected error: {e:?}");
                }
            }
        }
    }
}

#[test]
fn test_console_ring_buffer_overflow() {
    let buffers = TestRingBufferRegistry::default();
    let tab_id = TabId::new();

    // Flood 2,000 console entries into a 500-capacity ring buffer
    for i in 0..2000 {
        buffers.push_console(TestConsoleEntry {
            tab_id,
            level: "info".to_string(),
            text: format!("flood message {i}"),
            url: None,
            line: None,
            column: None,
            timestamp: i as f64,
        });
    }

    // Buffer should cap at 500 entries (SPEC_CONSOLE_CAP)
    let entries = buffers.console(tab_id, None);
    assert_eq!(entries.len(), 500);

    // Oldest messages should have been evicted; newest message 1999 must be present
    assert_eq!(entries.last().unwrap().text, "flood message 1999");
    assert_eq!(entries.first().unwrap().text, "flood message 1500");
}

#[test]
fn test_network_ring_buffer_overflow() {
    let buffers = TestRingBufferRegistry::default();
    let tab_id = TabId::new();

    // Flood 2,000 network requests into a 1,000-capacity ring buffer
    for i in 0..2000 {
        buffers.push_network(TestNetworkEvent {
            tab_id,
            request_id: format!("req_{i}"),
            url: format!("https://api.test/resource/{i}"),
            method: "GET".to_string(),
            status: Some(200),
            encoded_length: Some(128.0),
            timestamp: i as f64,
        });
    }

    // Buffer should cap at 1000 requests (SPEC_NETWORK_CAP)
    let requests = buffers.network(tab_id, None);
    assert_eq!(requests.len(), 1000);
    assert_eq!(requests.last().unwrap().request_id, "req_1999");
    assert_eq!(requests.first().unwrap().request_id, "req_1000");
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

#[test]
fn test_recorder_special_characters_and_empty() {
    let edge_steps = vec![
        RecordedInteractionStep {
            kind: "type".to_string(),
            role: "textbox".to_string(),
            name: "Comment".to_string(),
            value: "Special: <script>alert('xss')</script> 🚀 💖 \n\t \"quoted\"".to_string(),
            at: 1700000000.0,
            masked: false,
        },
        RecordedInteractionStep {
            kind: "click".to_string(),
            role: String::new(),
            name: String::new(),
            value: String::new(),
            at: 1700000001.0,
            masked: false,
        },
    ];

    let json = serde_json::to_string(&edge_steps).expect("Edge steps should serialize safely");
    assert!(json.contains("alert"));
    assert!(json.contains("🚀"));

    let deserialized: Vec<RecordedInteractionStep> = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized[0].value, edge_steps[0].value);
}
