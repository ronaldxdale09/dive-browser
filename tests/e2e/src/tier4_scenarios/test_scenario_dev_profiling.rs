//! Tier 4: Real-World Application Scenarios — Scenario 3 (Developer Session Profiling & Automation)
//!
//! Simulates a developer session against the real MCP server and CDP session:
//! 1. MCP connection authenticated with a token
//! 2. A tab opened through the fake browser
//! 3. CDP latency profiling verifying sub-5ms in-process handling
//!
//! Engine switches, the startup timeline and recorder spec generation are
//! tested where they live, in `apps/desktop/src-tauri/src`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use dive_cdp::CdpSession;
use dive_mcp::{Browser, Config, serve};

use crate::fixtures::{MockCdpTransport, TestFakeBrowser};

#[tokio::test]
async fn test_scenario_full_developer_session_profiling() {
    // 1. MCP Server Startup & Authentication
    let token = "dev-session-auth-token-42";
    let fake_browser = Arc::new(TestFakeBrowser::default());
    let server_handle = serve(
        fake_browser.clone(),
        Config {
            token: Some(token.to_string()),
            allow_evaluate: true,
        },
        "127.0.0.1:0".parse().unwrap(),
    )
    .await
    .unwrap();

    let client = crate::fixtures::http_client();
    let url = server_handle.url();

    // Verify authorized access
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Origin", "http://localhost:5173")
        .body("{}")
        .send()
        .await;

    match resp {
        Ok(r) => assert_ne!(r.status(), reqwest::StatusCode::UNAUTHORIZED),
        Err(e) => {
            // The rest of this scenario is about the fake browser and the
            // store; the auth check itself cannot be exercised without loopback.
            crate::fixtures::loopback_blocked_or_fail(&e);
        }
    }

    // 2. Automation (the fake browser: this only drives the server)
    let opened_tab = fake_browser
        .open_tab("http://localhost:5173/checkout".to_string())
        .await
        .expect("Tab open should succeed");
    assert_eq!(opened_tab.url, "http://localhost:5173/checkout");

    // 3. CDP In-Process Latency Profiling
    let transport = MockCdpTransport::new();
    let session = CdpSession::new(transport);

    let mut latencies = Vec::new();
    for i in 0..50 {
        let msg = format!(
            r#"{{"id": {}, "result": {{"eval": "1 + 1"}}}}"#,
            10_000_100 + i
        );
        let start = Instant::now();
        let _ = session.handle_incoming(&msg);
        latencies.push(start.elapsed());
    }

    let avg = latencies.iter().sum::<Duration>() / latencies.len() as u32;
    assert!(
        avg < Duration::from_millis(5),
        "CDP round-trip must remain under 5ms (observed: {:?})",
        avg
    );
}
