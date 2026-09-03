//! Many MCP clients at once: every call answers, none time out, and the
//! latency distribution stays flat. Runs over real loopback HTTP against
//! the fake browser, so it measures the server and transport, not CEF.

use std::sync::Arc;
use std::time::{Duration, Instant};

use dive_mcp::{Browser, Config, serve};
use serde_json::{Value, json};

use crate::fixtures::TestFakeBrowser;

const CLIENTS: usize = 32;
const CALLS_PER_CLIENT: usize = 10;
/// Generous for a loopback call into a fake browser; a lock convoy or a
/// per-call allocation storm shows up as an order of magnitude more.
const P95_BUDGET: Duration = Duration::from_millis(250);

/// The JSON-RPC payload of a streamable-HTTP response, whether it came back
/// as plain JSON or as one SSE `data:` frame.
fn rpc_payload(body: &str) -> Value {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        return v;
    }
    body.lines()
        // SSE permits the single space after `data:` to be omitted.
        .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
        // rmcp begins with an empty retry frame; keep scanning for JSON.
        .find_map(|data| serde_json::from_str(data).ok())
        .unwrap_or(Value::Null)
}

async fn initialize(client: &reqwest::Client, url: &str) -> Option<String> {
    let body = json!({
        "jsonrpc": "2.0", "id": 0, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                   "clientInfo": {"name": "dive-integration", "version": "0.1.0"}}
    });
    let resp = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("Origin", "http://localhost:5173")
        .body(body.to_string())
        .send()
        .await
        .ok()?;
    let sid = resp
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("<missing>")
        .to_owned();
    let text = resp.text().await.ok()?;
    let payload = rpc_payload(&text);
    assert!(
        status.is_success() && payload.get("result").is_some(),
        "initialize failed: status={status}, content-type={content_type}, body={text:?}, payload={payload}"
    );
    sid
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn thirty_two_clients_call_tools_at_once_without_errors_or_tail_latency() {
    let fake = Arc::new(TestFakeBrowser::default());
    let tab = fake
        .open_tab("https://concurrency.dev".into())
        .await
        .expect("fake tab")
        .id;
    let handle = serve(fake, Config::default(), "127.0.0.1:0".parse().unwrap())
        .await
        .expect("bind MCP server");
    let url = handle.url();
    let client = reqwest::Client::new();

    if client.post(&url).body("{}").send().await.is_err() {
        eprintln!("loopback TCP is blocked in this sandbox; skipping the HTTP load test");
        handle.shutdown();
        return;
    }

    let mut workers = Vec::new();
    for c in 0..CLIENTS {
        let client = client.clone();
        let url = url.clone();
        let tab = tab.clone();
        workers.push(tokio::spawn(async move {
            let sid = initialize(&client, &url).await;
            let mut latencies = Vec::with_capacity(CALLS_PER_CLIENT);
            for i in 0..CALLS_PER_CLIENT {
                let body = json!({
                    "jsonrpc": "2.0", "id": i + 1, "method": "tools/call",
                    "params": {"name": "page_state", "arguments": {"tab_id": tab}}
                });
                let mut req = client
                    .post(&url)
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json, text/event-stream")
                    .header("Origin", "http://localhost:5173")
                    .timeout(Duration::from_secs(10))
                    .body(body.to_string());
                if let Some(sid) = &sid {
                    req = req.header("Mcp-Session-Id", sid);
                }
                let started = Instant::now();
                let resp = req
                    .send()
                    .await
                    .unwrap_or_else(|e| panic!("client {c} call {i}: {e}"));
                assert_eq!(
                    resp.status(),
                    reqwest::StatusCode::OK,
                    "client {c} call {i}"
                );
                let payload = rpc_payload(&resp.text().await.expect("body"));
                latencies.push(started.elapsed());
                assert!(
                    payload.get("error").is_none() && payload["result"]["isError"] != true,
                    "client {c} call {i} failed: {payload}"
                );
                let text = payload["result"]["content"][0]["text"]
                    .as_str()
                    .unwrap_or_default();
                assert!(
                    text.contains("RootWebArea"),
                    "unexpected page_state: {text}"
                );
            }
            latencies
        }));
    }

    let mut all: Vec<Duration> = Vec::with_capacity(CLIENTS * CALLS_PER_CLIENT);
    for w in workers {
        all.extend(w.await.expect("client task panicked"));
    }
    handle.shutdown();

    assert_eq!(all.len(), CLIENTS * CALLS_PER_CLIENT);
    all.sort();
    let p50 = all[all.len() / 2];
    let p95 = all[all.len() * 95 / 100];
    eprintln!(
        "mcp concurrency: {} calls, p50 {p50:?}, p95 {p95:?}",
        all.len()
    );
    assert!(
        p95 < P95_BUDGET,
        "p95 {p95:?} exceeds {P95_BUDGET:?} (p50 {p50:?})"
    );
}
