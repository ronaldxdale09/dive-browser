//! Tier 1: Feature Coverage — Requirement R4 (Core Developer Feature Reliability & Verification)
//!
//! Features covered:
//! - Feature 24: In-process CDP latency benchmarking (<5ms target)
//! - Feature 27: MCP concurrent load test (50 parallel requests)

use std::sync::Arc;
use std::time::{Duration, Instant};

use dive_cdp::CdpSession;
use dive_mcp::{Config, serve};
use serde_json::json;

use crate::fixtures::{MockCdpTransport, TestFakeBrowser};

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

            // 3. A native client with a valid bearer token reaches the MCP
            // handler. Web-page Origin headers are deliberately rejected.
            let resp = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", token))
                .body("{}")
                .send()
                .await
                .unwrap();

            assert_ne!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);
            assert_ne!(resp.status(), reqwest::StatusCode::FORBIDDEN);
        }
        Err(e) => {
            crate::fixtures::loopback_blocked_or_fail(&e);
            return;
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
            crate::fixtures::loopback_blocked_or_fail(&e);
            return;
        }
    }
}
