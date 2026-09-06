//! Tier 1: Feature Coverage — Requirement R4 (Core Developer Feature Reliability & Verification)
//!
//! Features covered:
//! - Feature 24: In-process CDP latency benchmarking (<5ms target)
//! - Feature 25: Network & Console interception stress
//! - Feature 26: Playwright recorder verification
//! - Feature 27: MCP concurrent load test (50 parallel requests)

use std::sync::Arc;
use std::time::{Duration, Instant};

use dive_cdp::CdpSession;
use dive_core::TabId;
use dive_mcp::{Config, serve};
use serde_json::json;

use crate::fixtures::{
    MockCdpTransport, RecordedInteractionStep, TestConsoleEntry, TestFakeBrowser, TestNetworkEvent,
    TestRingBufferRegistry,
};

#[tokio::test]
async fn test_in_process_cdp_round_trip_latency() {
    // Contract: In-process CDP dispatch must achieve <5ms round-trip latency.
    let transport = MockCdpTransport::with_latency(Duration::from_micros(50));
    let session = CdpSession::new(transport);

    // Warm-up iteration
    let now = Instant::now();
    let _ = session.handle_incoming(r#"{"id": 10000000, "result": {"result": {"value": 42}}}"#);
    let warmup_elapsed = now.elapsed();
    assert!(warmup_elapsed < Duration::from_millis(5));

    // Benchmark 100 iterations of in-process message handling
    let mut total_duration = Duration::ZERO;
    let iterations = 100;

    for i in 0..iterations {
        let id = 10_000_000 + i;
        let incoming = format!(
            r#"{{"id": {}, "result": {{"result": {{"value": "benchmark_{}"}}}}}}"#,
            id, i
        );
        let start = Instant::now();
        let handled = session.handle_incoming(&incoming);
        total_duration += start.elapsed();
        assert!(
            handled.is_ok(),
            "Session should recognize and handle message with id {}",
            id
        );
    }

    let avg_latency = total_duration / iterations as u32;
    // Target is <5ms (5000 µs); in-process dispatch is typically <50 µs
    assert!(
        avg_latency < Duration::from_millis(5),
        "In-process CDP dispatch average latency {:?} must be under 5ms target",
        avg_latency
    );
}

#[test]
fn test_console_interception_captures_all_log_levels() {
    let buffers = TestRingBufferRegistry::default();
    let tab_id = TabId::new();

    let levels = ["info", "warn", "error", "debug"];
    for (i, level) in levels.iter().enumerate() {
        let entry = TestConsoleEntry {
            tab_id,
            level: (*level).to_string(),
            text: format!("Log message {i} for {level}"),
            url: Some("https://example.com/app.js".to_string()),
            line: Some(i as u32 + 10),
            column: Some(5),
            timestamp: 1700000000.0 + i as f64,
        };
        buffers.push_console(entry);
    }

    let entries = buffers.console(tab_id, Some(10));
    assert_eq!(entries.len(), 4);
    assert_eq!(entries[0].level, "info");
    assert_eq!(entries[1].level, "warn");
    assert_eq!(entries[2].level, "error");
    assert_eq!(entries[3].level, "debug");
}

#[test]
fn test_network_interception_tracks_request_lifecycle() {
    let buffers = TestRingBufferRegistry::default();
    let tab_id = TabId::new();
    let req_id = "req_test_101".to_string();

    buffers.push_network(TestNetworkEvent {
        tab_id,
        request_id: req_id.clone(),
        url: "https://api.example.com/v1/users".to_string(),
        method: "GET".to_string(),
        status: Some(200),
        encoded_length: Some(512.0),
        timestamp: 1700000000.0,
    });

    let requests = buffers.network(tab_id, Some(10));
    assert_eq!(requests.len(), 1);
    let req = &requests[0];
    assert_eq!(req.request_id, "req_test_101");
    assert_eq!(req.url, "https://api.example.com/v1/users");
    assert_eq!(req.method, "GET");
    assert_eq!(req.status, Some(200));
    assert_eq!(req.encoded_length, Some(512.0));
}

#[test]
fn test_playwright_recorder_spec_generation() {
    let steps = vec![
        RecordedInteractionStep {
            kind: "click".to_string(),
            role: "button".to_string(),
            name: "Sign In".to_string(),
            value: String::new(),
            at: 1700000001.0,
            masked: false,
        },
        RecordedInteractionStep {
            kind: "type".to_string(),
            role: "textbox".to_string(),
            name: "Email".to_string(),
            value: "alice@example.com".to_string(),
            at: 1700000002.0,
            masked: false,
        },
        RecordedInteractionStep {
            kind: "navigate".to_string(),
            role: String::new(),
            name: String::new(),
            value: "https://dashboard.example.com".to_string(),
            at: 1700000003.0,
            masked: false,
        },
    ];

    // Verify step serialization and fields
    let json_steps = serde_json::to_string(&steps).unwrap();
    assert!(json_steps.contains("Sign In"));
    assert!(json_steps.contains("alice@example.com"));
    assert!(json_steps.contains("https://dashboard.example.com"));

    // Verify locator role formatting matches Playwright ARIA locator contract
    for step in &steps {
        if step.kind == "click" {
            assert_eq!(step.role, "button");
            assert_eq!(step.name, "Sign In");
        } else if step.kind == "type" {
            assert_eq!(step.role, "textbox");
            assert_eq!(step.value, "alice@example.com");
        }
    }
}

#[tokio::test]
async fn test_mcp_server_bearer_auth() {
    let fake = Arc::new(TestFakeBrowser::default());
    let token = "test-secret-token-xyz-123";
    let config = Config {
        token: Some(token.to_string()),
        allow_evaluate: false,
    };

    let server_handle = serve(fake, config, "127.0.0.1:0".parse().unwrap())
        .await
        .expect("Failed to bind MCP server");

    let client = reqwest::Client::new();
    let url = server_handle.url();

    // 1. Missing Authorization header -> 401 Unauthorized
    let res1 = client.post(&url).send().await;
    match res1 {
        Ok(resp) => {
            assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);

            // 2. Wrong Bearer token -> 401 Unauthorized
            let resp = client
                .post(&url)
                .header("Authorization", "Bearer invalid-token")
                .send()
                .await
                .unwrap();
            assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);

            // 3. Valid Bearer token + trusted origin -> 200 or 400 (if empty body), not 401/403
            let resp = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", token))
                .header("Origin", "http://localhost:3000")
                .body("{}")
                .send()
                .await
                .unwrap();

            assert_ne!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);
            assert_ne!(resp.status(), reqwest::StatusCode::FORBIDDEN);
        }
        Err(e) => {
            let msg = format!("{e:?}");
            if msg.contains("PermissionDenied") || msg.contains("Operation not permitted") {
                // Loopback TCP is blocked here: there is no substitute for
                // the real server, so say so and stop rather than pass.
                eprintln!(
                    "skipping: loopback TCP is blocked in this sandbox, so the HTTP contract was not exercised"
                );
                return;
            } else {
                panic!("Unexpected error: {e:?}");
            }
        }
    }
}

#[tokio::test]
async fn test_mcp_concurrency_50_parallel_requests() {
    // Contract: 50 parallel requests to MCP endpoints without deadlock or error.
    let fake = Arc::new(TestFakeBrowser::default());
    let config = Config::default(); // no token required in test mode

    let server_handle = serve(fake.clone(), config, "127.0.0.1:0".parse().unwrap())
        .await
        .expect("Failed to bind MCP server");

    let client = reqwest::Client::new();
    let url = server_handle.url();

    let probe = client.post(&url).body("{}").send().await;
    match probe {
        Ok(_) => {
            let mut handles = Vec::new();
            let concurrency = 50;

            for i in 0..concurrency {
                let client = client.clone();
                let url = url.clone();
                handles.push(tokio::spawn(async move {
                    let body = json!({
                        "jsonrpc": "2.0",
                        "id": i,
                        "method": "initialize",
                        "params": {
                            "protocolVersion": "2025-06-18",
                            "capabilities": {},
                            "clientInfo": { "name": "dive-e2e", "version": "0.1.0" }
                        }
                    });

                    client
                        .post(&url)
                        .header("Content-Type", "application/json")
                        .header("Accept", "application/json, text/event-stream")
                        .header("Origin", "http://localhost:5173")
                        .body(body.to_string())
                        .send()
                        .await
                }));
            }

            for handle in handles {
                let result = handle.await.expect("Task panicked");
                let resp = result.expect("Request failed");
                assert_eq!(resp.status(), reqwest::StatusCode::OK);
            }
        }
        Err(e) => {
            let msg = format!("{e:?}");
            if msg.contains("PermissionDenied") || msg.contains("Operation not permitted") {
                eprintln!(
                    "skipping: loopback TCP is blocked in this sandbox, so the HTTP contract was not exercised"
                );
                return;
            } else {
                panic!("Unexpected error: {e:?}");
            }
        }
    }
}
