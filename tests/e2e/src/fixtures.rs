//! Shared fixtures, fakes, and test helpers for Dive Browser E2E tests.
//!
//! Opaque-box fixtures exercising public contracts defined in PROJECT.md:
//! - SQLite Store (`dive_core::Store`)
//! - In-process CDP (`dive_cdp::CdpSession`)
//! - MCP Server (`dive_mcp::serve`)
//! - Crash Recovery & Backoff specification
//! - Ring Buffers & Playwright Recorder contracts

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use dive_cdp::{CdpError, Transport};
use dive_core::model::{
    Container, ContainerId, Tab, TabId, TabState, TabTier, Timestamp, Workspace, WorkspaceId,
};
use dive_core::store::Store;
use dive_mcp::{
    AppearanceParams, Browser, BrowserError, ResizeParams, TabInfo, Target, WaitForParams,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

// ==============================================================================
// CDP Mock Transport
// ==============================================================================

/// Mock CDP transport for recording and simulating DevTools messages.
pub struct MockCdpTransport {
    pub sent_messages: Arc<Mutex<Vec<String>>>,
    pub _latency: Duration,
    pub drop_messages: Arc<AtomicBool>,
}

impl MockCdpTransport {
    pub fn new() -> Self {
        Self {
            sent_messages: Arc::new(Mutex::new(Vec::new())),
            _latency: Duration::from_micros(200),
            drop_messages: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn with_latency(latency: Duration) -> Self {
        Self {
            sent_messages: Arc::new(Mutex::new(Vec::new())),
            _latency: latency,
            drop_messages: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl Default for MockCdpTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl Transport for MockCdpTransport {
    fn send(&self, message: &str) -> Result<(), CdpError> {
        if self.drop_messages.load(Ordering::SeqCst) {
            return Err(CdpError::Closed);
        }
        self.sent_messages.lock().unwrap().push(message.to_string());
        Ok(())
    }
}

// ==============================================================================
// Database & Workspace Fixtures
// ==============================================================================

/// Create an in-memory SQLite store with a default container and workspace.
pub fn create_test_store() -> (Store, ContainerId, WorkspaceId) {
    let store = Store::in_memory().expect("failed to open in-memory test store");
    let container = Container::new("default-test-container");
    let container_id = container.id;
    store
        .upsert_container(&container)
        .expect("failed to upsert test container");

    let profile = dive_core::Profile::new("Default Test Profile", container_id, 0);
    store
        .upsert_profile(&profile)
        .expect("failed to upsert test profile");
    let workspace = Workspace::new("Default Test Workspace", container_id, profile.id, 0);
    let workspace_id = workspace.id;
    store
        .upsert_workspace(&workspace)
        .expect("failed to upsert test workspace");

    (store, container_id, workspace_id)
}

/// Create a set of sample tabs for testing discarding and memory saving.
pub fn create_sample_tabs(
    store: &Store,
    workspace_id: WorkspaceId,
    count: usize,
    tier: TabTier,
    state: TabState,
    idle_duration: time::Duration,
) -> Vec<Tab> {
    let now = Timestamp::now();
    let mut tabs = Vec::with_capacity(count);

    for i in 0..count {
        let mut tab = Tab::new(
            workspace_id,
            format!("https://example.com/page-{}", i),
            i as i32,
        );
        tab.tier = tier;
        tab.state = state;
        tab.title = format!("Page {}", i);
        tab.last_active_at = now - idle_duration;
        store.upsert_tab(&tab).expect("failed to upsert sample tab");
        tabs.push(tab);
    }

    tabs
}

/// Check if a URL belongs to a localhost/loopback dev server session (R2 safe discard rule).
pub fn is_localhost_or_devserver(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://localhost")
        || lower.starts_with("https://localhost")
        || lower.starts_with("http://127.0.0.1")
        || lower.starts_with("https://127.0.0.1")
        || lower.starts_with("http://[::1]")
        || lower.starts_with("https://[::1]")
        || lower.starts_with("http://0.0.0.0")
        || lower.starts_with("http://127.")
}

// ==============================================================================
// Startup Timeline Contract Model (PROJECT.md § M1)
// ==============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StartupTimelineModel {
    pub process_start_ms: f64,
    pub state_init_ms: f64,
    pub window_created_ms: f64,
    pub setup_complete_ms: f64,
    pub chrome_paint_ms: Option<f64>,
}

impl StartupTimelineModel {
    pub fn is_monotonically_ordered(&self) -> bool {
        let mut prev = self.process_start_ms;
        if self.state_init_ms < prev {
            return false;
        }
        prev = self.state_init_ms;
        if self.window_created_ms < prev {
            return false;
        }
        prev = self.window_created_ms;
        if self.setup_complete_ms < prev {
            return false;
        }
        if let Some(paint) = self.chrome_paint_ms
            && paint < self.setup_complete_ms
        {
            return false;
        }
        true
    }
}

// ==============================================================================
// Crash Isolation & Recovery Contract Models (PROJECT.md § M3)
// ==============================================================================

pub const SPEC_MAX_CRASH_ATTEMPTS: u32 = 3;
pub const SPEC_CRASH_WINDOW: Duration = Duration::from_secs(30);
pub const SPEC_CRASH_BASE_DELAY: Duration = Duration::from_millis(250);

/// Specta event emitted on tab crash.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TabCrashedEvent {
    pub tab_id: TabId,
    pub attempt: u32,
    pub recovering: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CrashAttempts {
    pub count: u32,
    pub started: Option<Instant>,
}

pub struct CrashRecoveryPlan {
    pub delay: Duration,
    pub attempt: u32,
    pub next: CrashAttempts,
}

/// Backoff decision algorithm conforming to PROJECT.md § M3 contract.
pub fn plan_crash_recovery(state: CrashAttempts, now: Instant) -> Option<CrashRecoveryPlan> {
    let fresh = state
        .started
        .is_none_or(|started| now.duration_since(started) >= SPEC_CRASH_WINDOW);
    let count = if fresh { 0 } else { state.count };
    if count >= SPEC_MAX_CRASH_ATTEMPTS {
        return None;
    }
    Some(CrashRecoveryPlan {
        delay: SPEC_CRASH_BASE_DELAY * 2_u32.pow(count),
        attempt: count + 1,
        next: CrashAttempts {
            count: count + 1,
            started: Some(if fresh {
                now
            } else {
                state.started.unwrap_or(now)
            }),
        },
    })
}

// ==============================================================================
// Buffer Ring Contracts (PROJECT.md § M4)
// ==============================================================================

pub const SPEC_CONSOLE_CAP: usize = 500;
pub const SPEC_NETWORK_CAP: usize = 1000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TestConsoleEntry {
    pub tab_id: TabId,
    pub level: String,
    pub text: String,
    pub url: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub timestamp: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TestNetworkEvent {
    pub tab_id: TabId,
    pub request_id: String,
    pub url: String,
    pub method: String,
    pub status: Option<u16>,
    pub encoded_length: Option<f64>,
    pub timestamp: f64,
}

#[derive(Default)]
pub struct TestRingBufferRegistry {
    pub console_buffers: Mutex<HashMap<TabId, VecDeque<TestConsoleEntry>>>,
    pub network_buffers: Mutex<HashMap<TabId, VecDeque<TestNetworkEvent>>>,
    pub recording_tabs: Mutex<HashMap<TabId, bool>>,
}

impl TestRingBufferRegistry {
    pub fn push_console(&self, entry: TestConsoleEntry) {
        let mut map = self.console_buffers.lock().unwrap();
        let buf = map
            .entry(entry.tab_id)
            .or_insert_with(|| VecDeque::with_capacity(SPEC_CONSOLE_CAP));
        if buf.len() >= SPEC_CONSOLE_CAP {
            buf.pop_front();
        }
        buf.push_back(entry);
    }

    pub fn console(&self, tab_id: TabId, limit: Option<usize>) -> Vec<TestConsoleEntry> {
        let map = self.console_buffers.lock().unwrap();
        let Some(buf) = map.get(&tab_id) else {
            return Vec::new();
        };
        let count = limit.unwrap_or(SPEC_CONSOLE_CAP).min(buf.len());
        buf.iter()
            .rev()
            .take(count)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    }

    pub fn push_network(&self, event: TestNetworkEvent) {
        let mut map = self.network_buffers.lock().unwrap();
        let buf = map
            .entry(event.tab_id)
            .or_insert_with(|| VecDeque::with_capacity(SPEC_NETWORK_CAP));
        if buf.len() >= SPEC_NETWORK_CAP {
            buf.pop_front();
        }
        buf.push_back(event);
    }

    pub fn network(&self, tab_id: TabId, limit: Option<usize>) -> Vec<TestNetworkEvent> {
        let map = self.network_buffers.lock().unwrap();
        let Some(buf) = map.get(&tab_id) else {
            return Vec::new();
        };
        let count = limit.unwrap_or(SPEC_NETWORK_CAP).min(buf.len());
        buf.iter()
            .rev()
            .take(count)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    }

    pub fn drop_tab(&self, tab_id: TabId) {
        self.console_buffers.lock().unwrap().remove(&tab_id);
        self.network_buffers.lock().unwrap().remove(&tab_id);
        self.recording_tabs.lock().unwrap().remove(&tab_id);
    }

    pub fn set_recording(&self, tab_id: TabId, recording: bool) {
        self.recording_tabs
            .lock()
            .unwrap()
            .insert(tab_id, recording);
    }

    pub fn is_recording(&self, tab_id: TabId) -> bool {
        self.recording_tabs
            .lock()
            .unwrap()
            .get(&tab_id)
            .copied()
            .unwrap_or(false)
    }
}

// ==============================================================================
// Playwright Step Recording Contract (PROJECT.md § M4)
// ==============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordedInteractionStep {
    pub kind: String,
    pub role: String,
    pub name: String,
    pub value: String,
    pub at: f64,
    pub masked: bool,
}

// ==============================================================================
// MCP Fake Browser
// ==============================================================================

#[derive(Default)]
pub struct TestFakeBrowser {
    pub tabs: Mutex<Vec<TabInfo>>,
    pub navigated: Mutex<Vec<(TabId, String)>>,
}

impl TestFakeBrowser {
    pub fn with_initial_tabs(tabs: Vec<TabInfo>) -> Self {
        Self {
            tabs: Mutex::new(tabs),
            navigated: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl Browser for TestFakeBrowser {
    async fn tabs(&self) -> Result<Vec<TabInfo>, BrowserError> {
        Ok(self.tabs.lock().unwrap().clone())
    }

    async fn open_tab(&self, url: String) -> Result<TabInfo, BrowserError> {
        let t = TabInfo {
            id: TabId::new().to_string(),
            url,
            title: String::new(),
            active: true,
        };
        self.tabs.lock().unwrap().push(t.clone());
        Ok(t)
    }

    async fn navigate(&self, tab: TabId, url: String) -> Result<(), BrowserError> {
        self.navigated.lock().unwrap().push((tab, url));
        Ok(())
    }

    async fn activate(&self, tab: TabId) -> Result<(), BrowserError> {
        let mut tabs = self.tabs.lock().unwrap();
        for t in tabs.iter_mut() {
            t.active = t.id == tab.to_string();
        }
        Ok(())
    }

    async fn close(&self, tab: TabId) -> Result<(), BrowserError> {
        let mut tabs = self.tabs.lock().unwrap();
        let before = tabs.len();
        tabs.retain(|t| t.id != tab.to_string());
        if tabs.len() == before {
            return Err(BrowserError::TabNotFound(tab.to_string()));
        }
        Ok(())
    }

    async fn page_text(&self, _tab: TabId) -> Result<String, BrowserError> {
        Ok("hello from test page".to_string())
    }

    async fn page_markdown(&self, _tab: TabId) -> Result<String, BrowserError> {
        Ok("# hello from test page".to_string())
    }

    async fn screenshot(&self, _tab: TabId, _full: bool) -> Result<Vec<u8>, BrowserError> {
        Ok(vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A])
    }

    async fn evaluate(&self, _tab: TabId, expr: String) -> Result<serde_json::Value, BrowserError> {
        Ok(json!({ "expr": expr }))
    }

    async fn console_tail(
        &self,
        _tab: TabId,
        limit: usize,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(json!([{ "text": "log entry", "limit": limit }]))
    }

    async fn requests(&self, _tab: TabId, limit: usize) -> Result<serde_json::Value, BrowserError> {
        Ok(json!([{ "url": "https://a.dev", "limit": limit }]))
    }

    async fn request_body(
        &self,
        _tab: TabId,
        request_id: String,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(json!({ "request_id": request_id, "body": "{}" }))
    }

    async fn page_state(&self, _tab: TabId) -> Result<String, BrowserError> {
        Ok("- RootWebArea \"page\"\n".to_string())
    }

    async fn page_inspect(&self, _tab: TabId) -> Result<serde_json::Value, BrowserError> {
        Ok(json!({ "url": "https://a.dev", "elements": [] }))
    }

    async fn page_click(
        &self,
        _tab: TabId,
        _target: Target,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(json!({ "clicked": true }))
    }

    async fn page_type(
        &self,
        _tab: TabId,
        _target: Target,
        text: String,
        clear: bool,
        submit: bool,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(json!({ "typed": text, "clear": clear, "submit": submit }))
    }

    async fn page_press(
        &self,
        _tab: TabId,
        _target: Target,
        _key: String,
        _modifiers: Vec<String>,
    ) -> Result<(), BrowserError> {
        Ok(())
    }

    async fn page_scroll(
        &self,
        _tab: TabId,
        _target: Target,
        delta_x: f64,
        delta_y: f64,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(json!({ "delta_x": delta_x, "delta_y": delta_y }))
    }

    async fn page_wait_for(
        &self,
        _tab: TabId,
        _params: WaitForParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(json!({ "matched": true }))
    }

    async fn page_locate(
        &self,
        _tab: TabId,
        locator: String,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(json!({ "locator": locator, "matches": [] }))
    }

    async fn page_resize(
        &self,
        _tab: TabId,
        params: ResizeParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(json!({ "preset": params.preset, "reset": params.reset }))
    }

    async fn page_devices(&self) -> Result<serde_json::Value, BrowserError> {
        Ok(json!([{ "id": "iphone-15" }]))
    }

    async fn page_appearance(
        &self,
        _tab: TabId,
        params: AppearanceParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(json!({ "color_scheme": params.color_scheme }))
    }

    async fn page_throttle(
        &self,
        _tab: TabId,
        profile: String,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(json!({ "profile": profile }))
    }

    async fn page_component(
        &self,
        _tab: TabId,
        _target: Target,
    ) -> Result<serde_json::Value, BrowserError> {
        Ok(json!({ "component_name": "SubmitButton" }))
    }

    async fn dev_servers(&self) -> Result<serde_json::Value, BrowserError> {
        Ok(json!([{ "port": 5173 }]))
    }

    async fn api_spec(&self, _tab: TabId) -> Result<serde_json::Value, BrowserError> {
        Ok(json!({ "openapi": "3.1.0" }))
    }

    async fn page_report(&self, _tab: TabId) -> Result<String, BrowserError> {
        Ok("## Bug report".to_string())
    }

    async fn rules(&self) -> Result<serde_json::Value, BrowserError> {
        Ok(json!([]))
    }

    async fn set_rules(&self, _rules: serde_json::Value) -> Result<(), BrowserError> {
        Ok(())
    }

    async fn page_snapshot(&self, _tab: TabId) -> Result<String, BrowserError> {
        Ok("snapshot".to_string())
    }

    async fn page_diff(&self, _tab: TabId) -> Result<serde_json::Value, BrowserError> {
        Ok(json!({ "summary": "no differences" }))
    }
}

/// Validate MCP request Authorization and Origin headers per PROJECT.md § M4 contract.
pub fn check_mcp_auth_and_origin(
    expected_token: Option<&str>,
    auth_header: Option<&str>,
    origin_header: Option<&str>,
) -> Result<(), u16> {
    if let Some(origin) = origin_header
        && !origin.is_empty()
    {
        let is_local = if let Ok(parsed) = url::Url::parse(origin) {
            parsed.host_str().is_some_and(|h| {
                h == "localhost" || h == "127.0.0.1" || h == "[::1]" || h == "0.0.0.0"
            })
        } else {
            false
        };
        if !is_local {
            return Err(403); // Forbidden
        }
    }

    if let Some(token) = expected_token {
        let Some(header) = auth_header else {
            return Err(401); // Unauthorized
        };
        let Some(bearer_val) = header.strip_prefix("Bearer ") else {
            return Err(401);
        };
        if bearer_val != token {
            return Err(401);
        }
    }

    Ok(())
}
