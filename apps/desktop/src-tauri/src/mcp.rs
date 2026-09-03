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
    let config = dive_mcp::Config {
        allow_evaluate: std::env::var_os("DIVE_MCP_ALLOW_EVAL").is_some(),
    };
    let browser = Arc::new(AppBrowser { app });
    tauri::async_runtime::spawn(async move {
        match dive_mcp::serve(browser, config, ([127, 0, 0, 1], port).into()).await {
            Ok(handle) => {
                tracing::info!(
                    url = handle.url(),
                    "mcp: add with `claude mcp add --transport http dive {}`",
                    handle.url()
                );
                // Keep the handle alive for the life of the process.
                std::mem::forget(handle);
            }
            Err(e) => tracing::warn!("mcp server failed to start on port {port}: {e}"),
        }
    });
}
