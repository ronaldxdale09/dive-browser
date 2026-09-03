//! Desktop-side implementation of the MCP `Browser` trait plus server startup.

use std::sync::Arc;

use async_trait::async_trait;
use dive_core::TabId;
use dive_mcp::{Browser, BrowserError, TabInfo};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::Runtime;
use crate::commands::{activate_tab, capture_tab, normalize_url, open_tab};
use crate::state::{AppState, lock};

/// Bridges MCP tools to the app state and the CEF engine.
pub struct AppBrowser {
    app: AppHandle<Runtime>,
}

impl AppBrowser {
    /// Wrap the app handle.
    pub fn new(app: AppHandle<Runtime>) -> Self {
        Self { app }
    }

    fn state(&self) -> tauri::State<'_, AppState> {
        self.app.state::<AppState>()
    }

    fn session(&self, tab: TabId) -> Result<dive_cdp::CdpSession, BrowserError> {
        let state = self.state();
        let host = lock(&state.host);
        let host = host
            .as_ref()
            .ok_or_else(|| BrowserError::Other("engine not ready".into()))?;
        host.cdp(tab)
            .ok_or_else(|| BrowserError::TabNotFound(tab.to_string()))
    }

    /// Make sure a view (and therefore a CDP session) exists for `tab`.
    fn ensure_view(&self, tab: TabId) -> Result<(), BrowserError> {
        let state = self.state();
        let has = lock(&state.host).as_ref().is_some_and(|h| h.has(tab));
        if has {
            return Ok(());
        }
        activate_tab(&self.app, &state, tab).map_err(|e| BrowserError::Other(e.message))
    }
}

impl AppBrowser {
    /// Capture text, structure, errors and requests of `tab` right now.
    pub async fn take_snapshot(
        &self,
        tab: TabId,
    ) -> Result<crate::snapshot::PageSnapshot, BrowserError> {
        self.ensure_view(tab)?;
        let text = self.page_text(tab).await?;
        let structure = self.page_state(tab).await?;
        let state = self.state();
        let row = lock(&state.store).tab(tab).map_err(other)?;
        let errors = state
            .buffers
            .console_tail(tab, 200)
            .into_iter()
            .filter(|e| e.level == crate::console::Level::Error)
            .map(|e| {
                e.text
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .chars()
                    .take(200)
                    .collect()
            })
            .collect();
        let requests = state
            .buffers
            .requests(tab, 300)
            .into_iter()
            .map(|r| {
                format!(
                    "{} {} -> {}",
                    r.method,
                    r.url,
                    r.error.clone().unwrap_or_else(|| r
                        .status
                        .map_or_else(|| "pending".into(), |s| s.to_string()))
                )
            })
            .collect();
        Ok(crate::snapshot::PageSnapshot {
            taken_at: dive_core::Timestamp::now().to_rfc3339(),
            url: row.url,
            title: row.title,
            text,
            structure,
            errors,
            requests,
        })
    }

    /// Backend node for a `ref` from the last `page_state` call.
    fn node_for(&self, tab: TabId, reference: &str) -> Result<i64, BrowserError> {
        self.state()
            .buffers
            .resolve_ref(tab, reference)
            .ok_or_else(|| {
                BrowserError::Other(format!("unknown ref {reference}; call page_state first"))
            })
    }
}

/// Centre of a node's content box in CSS pixels, scrolling it into view first.
async fn center_of(session: &dive_cdp::CdpSession, node: i64) -> Result<(f64, f64), BrowserError> {
    let _ = session
        .call("DOM.scrollIntoViewIfNeeded", json!({"backendNodeId": node}))
        .await;
    let model = session
        .call("DOM.getBoxModel", json!({"backendNodeId": node}))
        .await
        .map_err(other)?;
    let quad = model["model"]["content"]
        .as_array()
        .ok_or_else(|| other("node has no box"))?;
    let xs: Vec<f64> = quad.iter().step_by(2).filter_map(Value::as_f64).collect();
    let ys: Vec<f64> = quad
        .iter()
        .skip(1)
        .step_by(2)
        .filter_map(Value::as_f64)
        .collect();
    if xs.len() < 4 || ys.len() < 4 {
        return Err(other("node has no box"));
    }
    Ok((xs.iter().sum::<f64>() / 4.0, ys.iter().sum::<f64>() / 4.0))
}

/// CDP modifier bit for the platform's select-all chord (Meta on macOS, Ctrl elsewhere).
const SELECT_ALL_MODIFIER: u8 = if cfg!(target_os = "macos") { 4 } else { 2 };

fn other(e: impl std::fmt::Display) -> BrowserError {
    BrowserError::Other(e.to_string())
}

#[async_trait]
impl Browser for AppBrowser {
    async fn tabs(&self) -> Result<Vec<TabInfo>, BrowserError> {
        let state = self.state();
        let active = lock(&state.host)
            .as_ref()
            .and_then(crate::engine::TabHost::active);
        let workspace =
            (*lock(&state.active_workspace)).ok_or_else(|| other("no active workspace"))?;
        let tabs = lock(&state.store)
            .tabs_for_workspace(workspace)
            .map_err(other)?;
        Ok(tabs
            .into_iter()
            .filter(|t| t.state != dive_core::TabState::Discarded)
            .map(|t| TabInfo {
                id: t.id.to_string(),
                url: t.url,
                title: t.title,
                active: Some(t.id) == active,
            })
            .collect())
    }

    async fn open_tab(&self, url: String) -> Result<TabInfo, BrowserError> {
        let state = self.state();
        let workspace =
            (*lock(&state.active_workspace)).ok_or_else(|| other("no active workspace"))?;
        let tab = open_tab(&self.app, &state, workspace, &url).map_err(|e| other(e.message))?;
        Ok(TabInfo {
            id: tab.id.to_string(),
            url: tab.url,
            title: tab.title,
            active: true,
        })
    }

    async fn navigate(&self, tab: TabId, url: String) -> Result<(), BrowserError> {
        let url = normalize_url(&url).map_err(|e| other(e.message))?;
        let state = self.state();
        let host = lock(&state.host);
        host.as_ref()
            .ok_or_else(|| other("engine not ready"))?
            .navigate(tab, url)
            .map_err(|_| BrowserError::TabNotFound(tab.to_string()))
    }

    async fn page_text(&self, tab: TabId) -> Result<String, BrowserError> {
        self.ensure_view(tab)?;
        let session = self.session(tab)?;
        let result = session
            .call(
                "Runtime.evaluate",
                json!({"expression": "document.body ? document.body.innerText : ''", "returnByValue": true}),
            )
            .await
            .map_err(other)?;
        Ok(result["result"]["value"]
            .as_str()
            .unwrap_or_default()
            .to_owned())
    }

    async fn screenshot(&self, tab: TabId, full_page: bool) -> Result<Vec<u8>, BrowserError> {
        self.ensure_view(tab)?;
        let state = self.state();
        let path = capture_tab(&state, tab, full_page)
            .await
            .map_err(|e| other(e.message))?;
        std::fs::read(path).map_err(other)
    }

    async fn page_state(&self, tab: TabId) -> Result<String, BrowserError> {
        self.ensure_view(tab)?;
        let session = self.session(tab)?;
        let tree = session
            .call("Accessibility.getFullAXTree", json!({}))
            .await
            .map_err(other)?;
        let nodes = crate::ax::flatten(&tree);
        let refs = nodes
            .iter()
            .filter_map(|n| Some((n.reference.clone()?, n.backend_node_id?)))
            .collect();
        self.state().buffers.set_refs(tab, refs);
        Ok(crate::ax::render(&nodes, 1500))
    }

    async fn page_click(&self, tab: TabId, reference: String) -> Result<(), BrowserError> {
        let session = self.session(tab)?;
        let node = self.node_for(tab, &reference)?;
        let (x, y) = center_of(&session, node).await?;
        for kind in ["mouseMoved", "mousePressed", "mouseReleased"] {
            let button = if kind == "mouseMoved" { "none" } else { "left" };
            session
                .call(
                    "Input.dispatchMouseEvent",
                    json!({"type": kind, "x": x, "y": y, "button": button, "clickCount": 1}),
                )
                .await
                .map_err(other)?;
        }
        Ok(())
    }

    async fn page_type(
        &self,
        tab: TabId,
        reference: String,
        text: String,
        submit: bool,
    ) -> Result<(), BrowserError> {
        let session = self.session(tab)?;
        let node = self.node_for(tab, &reference)?;
        session
            .call("DOM.focus", json!({"backendNodeId": node}))
            .await
            .map_err(other)?;
        // Select existing content so the inserted text replaces it.
        let select_all = json!({"type": "keyDown", "key": "a", "code": "KeyA", "modifiers": SELECT_ALL_MODIFIER, "commands": ["selectAll"]});
        session
            .call("Input.dispatchKeyEvent", select_all)
            .await
            .map_err(other)?;
        session
            .call("Input.insertText", json!({"text": text}))
            .await
            .map_err(other)?;
        if submit {
            for (kind, key_text) in [("keyDown", "\r"), ("keyUp", "")] {
                session
                    .call(
                        "Input.dispatchKeyEvent",
                        json!({"type": kind, "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "text": key_text}),
                    )
                    .await
                    .map_err(other)?;
            }
        }
        Ok(())
    }

    async fn api_spec(&self, tab: TabId) -> Result<Value, BrowserError> {
        let state = self.state();
        let page_url = lock(&state.store).tab(tab).map_err(other)?.url;
        Ok(crate::openapi::from_requests(
            &page_url,
            &state.buffers.requests(tab, 1000),
        ))
    }

    async fn page_snapshot(&self, tab: TabId) -> Result<String, BrowserError> {
        let snap = self.take_snapshot(tab).await?;
        let taken = snap.taken_at.clone();
        self.state().buffers.push_snapshot(tab, snap);
        Ok(format!("snapshot taken at {taken}"))
    }

    async fn page_diff(&self, tab: TabId) -> Result<Value, BrowserError> {
        let snap = self.take_snapshot(tab).await?;
        let state = self.state();
        state.buffers.push_snapshot(tab, snap);
        let (older, newer) = state
            .buffers
            .last_two_snapshots(tab)
            .ok_or_else(|| other("take a snapshot first, then diff after the change"))?;
        Ok(crate::snapshot::to_json(&crate::snapshot::diff(
            &older, &newer,
        )))
    }

    async fn console_tail(&self, tab: TabId, limit: usize) -> Result<Value, BrowserError> {
        serde_json::to_value(self.state().buffers.console_tail(tab, limit)).map_err(other)
    }

    async fn requests(&self, tab: TabId, limit: usize) -> Result<Value, BrowserError> {
        serde_json::to_value(self.state().buffers.requests(tab, limit)).map_err(other)
    }

    async fn evaluate(&self, tab: TabId, expression: String) -> Result<Value, BrowserError> {
        self.ensure_view(tab)?;
        let session = self.session(tab)?;
        let result = session
            .call(
                "Runtime.evaluate",
                json!({"expression": expression, "returnByValue": true, "awaitPromise": true}),
            )
            .await
            .map_err(other)?;
        if let Some(details) = result.get("exceptionDetails") {
            return Err(other(
                details["exception"]["description"]
                    .as_str()
                    .unwrap_or("evaluation threw"),
            ));
        }
        Ok(result["result"]["value"].clone())
    }
}

/// Start the MCP server unless `DIVE_MCP_PORT=0`. Default port 7391.
pub fn start(app: AppHandle<Runtime>) {
    let port: u16 = std::env::var("DIVE_MCP_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(7391);
    if port == 0 {
        tracing::info!("mcp server disabled");
        return;
    }
    let token = match load_or_create_token() {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("mcp server disabled: cannot create token file: {e}");
            return;
        }
    };
    let config = dive_mcp::Config {
        allow_evaluate: std::env::var_os("DIVE_MCP_ALLOW_EVAL").is_some(),
        token: Some(token),
    };
    let browser = Arc::new(AppBrowser::new(app));
    tauri::async_runtime::spawn(async move {
        match dive_mcp::serve(browser, config, ([127, 0, 0, 1], port).into()).await {
            Ok(handle) => {
                tracing::info!(
                    url = handle.url(),
                    "mcp: add with `claude mcp add --transport http dive {} --header \"Authorization: Bearer $(cat '{}')\"`",
                    handle.url(),
                    token_path().display()
                );
                // Keep the handle alive for the life of the process.
                std::mem::forget(handle);
            }
            Err(e) => tracing::warn!("mcp server failed to start on port {port}: {e}"),
        }
    });
}

/// Where the bearer token lives; readable only by the user.
pub fn token_path() -> std::path::PathBuf {
    crate::state::data_root().join("mcp-token")
}

/// Read the token, creating a fresh random one on first run.
fn load_or_create_token() -> std::io::Result<String> {
    let path = token_path();
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let t = existing.trim();
        if t.len() >= 32 {
            return Ok(t.to_owned());
        }
    }
    let token = dive_core::TabId::new().to_string().replace('-', "")
        + &dive_core::TabId::new().to_string().replace('-', "");
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)?;
        f.write_all(token.as_bytes())?;
    }
    #[cfg(not(unix))]
    std::fs::write(&path, &token)?;
    Ok(token)
}
