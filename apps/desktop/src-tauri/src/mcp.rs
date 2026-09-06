//! Desktop-side implementation of the MCP `Browser` trait plus server startup.

use std::sync::Arc;

use async_trait::async_trait;
use dive_cdp::CdpSession;
use dive_core::TabId;
use dive_mcp::{
    Addressed, AppearanceParams, Browser, BrowserError, ResizeParams, TabInfo, Target,
    WaitForParams,
};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::Runtime;
use crate::commands::{activate_tab, normalize_url_with, open_tab};
use crate::engine::MainThread;
use crate::state::{AppState, lock};
use crate::{automation, locator};

/// Bridges MCP tools to the app state and the CEF engine.
/// Largest response body handed to an agent in one call.
const BODY_TOOL_CAP: usize = 4096;
/// Interactive elements listed by `page_inspect`.
const INSPECT_ELEMENT_CAP: u32 = 200;
/// Console lines and requests summarised by `page_inspect`. Kept small: the
/// point of the bundle is to be worth reading, and `console_tail` and
/// `network_list` are there for the full history.
const INSPECT_DIAGNOSTIC_CAP: usize = 20;
/// Matches described by `page_locate` before it stops.
const LOCATE_CAP: u32 = 20;
/// Longest a single `page_evaluate` result may be.
const EVALUATE_CAP: usize = 64_000;
/// Longest expression accepted by `page_evaluate`.
const EVALUATE_EXPRESSION_CAP: usize = 64_000;
/// Largest visible-text response. The composite inspector is intentionally
/// much smaller, while this dedicated tool can still read a long document.
const PAGE_TEXT_CAP: usize = 256 * 1024;
/// Largest text insertion accepted in one action.
const TYPE_TEXT_CAP: usize = 256 * 1024;
/// Largest string condition accepted by `page_wait_for`.
const WAIT_TEXT_CAP: usize = 8 * 1024;
/// Largest wheel delta accepted in one action.
const MAX_SCROLL_DELTA: f64 = 100_000.0;
/// One compositor frame before reading the offset produced by wheel input.
const SCROLL_SETTLE_MS: u64 = 50;
/// Largest image handed back through MCP or the sidecar.
const SCREENSHOT_TOOL_CAP: usize = 16 * 1024 * 1024;
/// How often `page_wait_for` re-checks its conditions.
const WAIT_POLL_MS: u64 = 100;
/// Longest a hop to the main thread may wait for its answer.
const MAIN_THREAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

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

    /// Run `f` on the main thread and wait for its answer.
    ///
    /// Creating or showing a native view has to happen on the main thread,
    /// and `activate_tab` holds the host lock while it does so. Called from
    /// the MCP server's own thread, that pairing deadlocks the moment the
    /// chrome sends a command that wants the same lock. Hopping over first
    /// puts the call on the thread the chrome's commands already use.
    ///
    /// The wait is bounded: a main thread stuck in a modal or a native
    /// dialog must not hang every MCP call forever.
    async fn on_main<T: Send + 'static>(
        &self,
        f: impl FnOnce(&AppHandle<Runtime>) -> T + Send + 'static,
    ) -> Result<T, BrowserError> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let app = self.app.clone();
        self.app
            .run_on_main_thread(move || {
                let _ = tx.send(f(&app));
            })
            .map_err(other)?;
        match tokio::time::timeout(MAIN_THREAD_TIMEOUT, rx).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(_)) => Err(other("the main thread dropped the request")),
            Err(_) => Err(other(format!(
                "the browser's main thread did not answer within {}s; it may be blocked by a dialog",
                MAIN_THREAD_TIMEOUT.as_secs()
            ))),
        }
    }

    /// The URL an MCP client or the agent may open or navigate to.
    ///
    /// The omnibox path (`normalize_url_with`) also accepts `file:`, `data:`,
    /// `blob:` and the internal scheme, which is right for a person typing
    /// and wrong for a remote client: a page can steer the agent, and the
    /// agent must not be able to read local files or open built-in pages.
    fn web_url(&self, url: &str) -> Result<url::Url, BrowserError> {
        let state = self.state();
        let url = normalize_url_with(url, state.prefs.snapshot(&state).search_template())
            .map_err(|e| BrowserError::BadRequest(e.message))?;
        check_web_url(&url)?;
        Ok(url)
    }

    /// Make sure a view (and therefore a CDP session) exists for `tab`.
    async fn ensure_view(&self, tab: TabId) -> Result<(), BrowserError> {
        let has = lock(&self.state().host)
            .as_ref()
            .is_some_and(|h| h.has(tab));
        if has {
            return Ok(());
        }
        self.on_main(move |app| {
            let state = app.state::<AppState>();
            let main = MainThread::here().ok_or_else(|| other("not on the main thread"))?;
            activate_tab(&main, app, &state, tab).map_err(|e| BrowserError::Other(e.message))
        })
        .await?
    }
}

impl AppBrowser {
    /// Capture text, structure, errors and requests of `tab` right now.
    pub async fn take_snapshot(
        &self,
        tab: TabId,
    ) -> Result<crate::snapshot::PageSnapshot, BrowserError> {
        self.ensure_view(tab).await?;
        let text = crate::snapshot::cap(&self.page_text(tab).await?, crate::snapshot::MAX_TEXT);
        let structure =
            crate::snapshot::cap(&self.page_state(tab).await?, crate::snapshot::MAX_STRUCTURE);
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
            .map(|t| t.backend_node_id)
            .ok_or_else(|| {
                BrowserError::Other(format!("unknown ref {reference}; call page_state first"))
            })
    }
}

impl From<locator::Failure> for BrowserError {
    fn from(f: locator::Failure) -> Self {
        match f {
            locator::Failure::Invalid { locator, reason } => {
                Self::InvalidSelector { locator, reason }
            }
            locator::Failure::NotFound { locator } => Self::TargetNotFound { locator },
            locator::Failure::NotVisible { locator } => Self::NotVisible { locator },
            locator::Failure::NotEnabled { locator } => Self::NotEnabled { locator },
            locator::Failure::NotEditable { locator } => Self::NotEditable { locator },
            locator::Failure::Engine(e) => Self::Other(e),
        }
    }
}

impl AppBrowser {
    /// A live CDP session for `tab`, creating the view if it has been
    /// discarded.
    async fn session_for(&self, tab: TabId) -> Result<CdpSession, BrowserError> {
        self.ensure_view(tab).await?;
        self.session(tab)
    }

    /// A session that can accept real input. CEF stops acknowledging `Input`
    /// events while a native child view is hidden, so a user-like action must
    /// bring its target tab forward first.
    async fn action_session_for(&self, tab: TabId) -> Result<CdpSession, BrowserError> {
        self.ensure_view(tab).await?;
        if !self.on_screen(tab) {
            self.activate(tab).await?;
        }
        self.session(tab)
    }

    /// Whether the person is looking at this tab. Used to decide whether an
    /// agent action is worth animating.
    fn on_screen(&self, tab: TabId) -> bool {
        lock(&self.state().host)
            .as_ref()
            .and_then(crate::engine::TabHost::active)
            == Some(tab)
    }

    /// Record an action on the tab's timeline around `work`, so
    /// `page_inspect` can report what has already been tried.
    async fn tracked<T>(
        &self,
        tab: TabId,
        action: &str,
        target: Option<String>,
        work: impl std::future::Future<Output = Result<T, BrowserError>>,
    ) -> Result<T, BrowserError> {
        let id = self.state().buffers.begin_action(tab, action, target);
        let outcome = work.await;
        let error = outcome.as_ref().err().map(ToString::to_string);
        self.state().buffers.end_action(tab, &id, error);
        outcome
    }

    /// Where to act, and what to call it in the cursor label.
    ///
    /// A locator is resolved now, against the page as it currently is; a
    /// `ref` is looked up in the last `page_state` and may already be stale;
    /// a coordinate is bounds-checked, because a click outside the viewport
    /// silently hits nothing.
    async fn point_for(
        &self,
        tab: TabId,
        session: &CdpSession,
        target: &Target,
    ) -> Result<(f64, f64, String), BrowserError> {
        match target.resolve()? {
            Addressed::Locator(selector) => {
                let found = locator::point(session, &selector).await?;
                let label = if found.name.is_empty() {
                    found.tag.clone()
                } else {
                    format!("{} {:?}", found.role, found.name)
                };
                Ok((found.x, found.y, label))
            }
            Addressed::Ref(reference) => {
                let node = self.node_for(tab, &reference)?;
                let (x, y) = center_of(session, node).await?;
                Ok((x, y, reference))
            }
            Addressed::Point { x, y } => {
                let viewport = locator::viewport(session).await?;
                if x < 0.0 || y < 0.0 || x > viewport.width || y > viewport.height {
                    return Err(BrowserError::OutsideViewport {
                        x,
                        y,
                        width: viewport.width,
                        height: viewport.height,
                    });
                }
                Ok((x, y, format!("({x}, {y})")))
            }
        }
    }

    /// Focus a field named by `target`, or leave focus where it is when the
    /// target is empty.
    async fn focus_for(
        &self,
        tab: TabId,
        session: &CdpSession,
        target: &Target,
        editable: bool,
    ) -> Result<Option<String>, BrowserError> {
        if target.locator.is_none() && target.r#ref.is_none() && target.x.is_none() {
            return Ok(None);
        }
        match target.resolve()? {
            Addressed::Locator(selector) => {
                let found = if editable {
                    locator::focus(session, &selector).await?
                } else {
                    locator::focus_any(session, &selector).await?
                };
                Ok(Some(format!("{} {:?}", found.role, found.name)))
            }
            Addressed::Ref(reference) => {
                let node = self.node_for(tab, &reference)?;
                session
                    .call("DOM.focus", json!({"backendNodeId": node}))
                    .await
                    .map_err(other)?;
                Ok(Some(reference))
            }
            Addressed::Point { .. } => Err(BrowserError::BadRequest(
                "focusing needs a locator or a ref, not coordinates".into(),
            )),
        }
    }

    /// Map a bundle location back to its original file through source maps.
    ///
    /// React's `_debugSource` points into the served bundle, which is not a
    /// path anybody can open. Only scripts from the page's own host are
    /// fetched, the same restriction the console panel's stack frames use.
    async fn resolve_source(&self, tab: TabId, frame: &Value) -> Value {
        let (Some(url), Some(line)) = (
            frame["fileName"].as_str(),
            frame["lineNumber"]
                .as_u64()
                .and_then(|l| u32::try_from(l).ok()),
        ) else {
            return Value::Null;
        };
        let state = self.state();
        let Ok(page_url) = lock(&state.store).tab(tab).map(|t| t.url) else {
            return Value::Null;
        };
        let column = frame["columnNumber"]
            .as_u64()
            .and_then(|c| u32::try_from(c).ok())
            .unwrap_or(1);
        state
            .sourcemaps
            .resolve(&page_url, url, line, column)
            .await
            .and_then(|original| serde_json::to_value(original).ok())
            .unwrap_or(Value::Null)
    }

    /// Apply a device to a tab and reload, which is the cheapest way to make
    /// the new metrics take effect on layout.
    async fn emulate_device(
        &self,
        tab: TabId,
        device: Option<crate::emulate::Device>,
    ) -> Result<bool, BrowserError> {
        let session = self.session_for(tab).await?;
        crate::emulate::apply(&session, crate::emulate::device_calls(device.as_ref()))
            .await
            .map_err(|e| BrowserError::BadRequest(e.message))?;
        // Metrics apply live; a user agent only takes effect on the next
        // document. Reloading for a rotation would throw away the page's
        // state for nothing.
        let previous = self.state().buffers.device(tab);
        let reload = browsing_identity(previous.as_ref()) != browsing_identity(device.as_ref());
        self.state().buffers.set_device(tab, device);
        if reload {
            session.call0("Page.reload").await.map_err(other)?;
        }
        Ok(reload)
    }
}

/// Identity signals that affect the response a site returns. An exact-size
/// desktop viewport has an empty override and is equivalent to no emulation.
fn browsing_identity(device: Option<&crate::emulate::Device>) -> (&str, bool) {
    device.map_or(("", false), |device| {
        (device.user_agent.as_str(), device.mobile)
    })
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

/// Drop everything but the newest `keep` items, in place.
///
/// The tail is the useful end: the most recent errors are the ones that
/// describe the state the page is in now.
fn keep_last<T>(items: &mut Vec<T>, keep: usize) {
    if items.len() > keep {
        items.drain(..items.len() - keep);
    }
}

fn other(e: impl std::fmt::Display) -> BrowserError {
    BrowserError::Other(e.to_string())
}

/// Reject anything but `http`, `https` and `about:blank` for a URL that a
/// remote client or the model chose.
pub(crate) fn check_web_url(url: &url::Url) -> Result<(), BrowserError> {
    match url.scheme() {
        "http" | "https" => Ok(()),
        "about" if url.path() == "blank" => Ok(()),
        scheme => Err(BrowserError::BadRequest(format!(
            "{scheme}: URLs are not allowed here; use http, https or about:blank"
        ))),
    }
}

#[allow(clippy::too_many_lines)] // Browser adapter methods stay together so the MCP surface is auditable.
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
        let url = self.web_url(&url)?.to_string();
        // Creating the native view has to happen on the main thread; from
        // the server's thread CEF takes the process down.
        let tab = self
            .on_main(move |app| {
                let state = app.state::<AppState>();
                let workspace =
                    (*lock(&state.active_workspace)).ok_or_else(|| other("no active workspace"))?;
                let main = MainThread::here().ok_or_else(|| other("not on the main thread"))?;
                open_tab(&main, app, &state, workspace, &url).map_err(|e| other(e.message))
            })
            .await??;
        Ok(TabInfo {
            id: tab.id.to_string(),
            url: tab.url,
            title: tab.title,
            active: true,
        })
    }

    async fn navigate(&self, tab: TabId, url: String) -> Result<(), BrowserError> {
        let url = self.web_url(&url)?;
        self.tracked(tab, "tab_navigate", Some(url.to_string()), async {
            let state = self.state();
            let host = lock(&state.host);
            host.as_ref()
                .ok_or_else(|| other("engine not ready"))?
                .navigate(tab, url)
                .map_err(|_| BrowserError::TabNotFound(tab.to_string()))
        })
        .await
    }

    async fn activate(&self, tab: TabId) -> Result<(), BrowserError> {
        self.on_main(move |app| {
            let state = app.state::<AppState>();
            let main = MainThread::here().ok_or_else(|| other("not on the main thread"))?;
            activate_tab(&main, app, &state, tab).map_err(|e| other(e.message))
        })
        .await?
    }

    async fn close(&self, tab: TabId) -> Result<(), BrowserError> {
        self.on_main(move |app| {
            let state = app.state::<AppState>();
            let main = MainThread::here().ok_or_else(|| other("not on the main thread"))?;
            crate::commands::close_tab(&main, app, &state, tab).map_err(|e| other(e.message))
        })
        .await?
    }

    async fn page_text(&self, tab: TabId) -> Result<String, BrowserError> {
        self.ensure_view(tab).await?;
        let session = self.session(tab)?;
        let result = session
            .call(
                "Runtime.evaluate",
                json!({
                    "expression": format!(
                        "(() => {{ const text = document.body ? (document.body.innerText || document.body.textContent || '') : ''; return {{ text: text.slice(0, {PAGE_TEXT_CAP}), truncated: text.length > {PAGE_TEXT_CAP} }}; }})()"
                    ),
                    "returnByValue": true
                }),
            )
            .await
            .map_err(other)?;
        let value = &result["result"]["value"];
        let mut text = value["text"].as_str().unwrap_or_default().to_owned();
        if value["truncated"].as_bool() == Some(true) {
            text.push_str("\n…(truncated)");
        }
        Ok(text)
    }

    async fn page_markdown(&self, tab: TabId) -> Result<String, BrowserError> {
        self.ensure_view(tab).await?;
        let session = self.session(tab)?;
        let script = crate::pagescript::build(
            "markdown.js",
            &[("__MARKDOWN_CAP__", PAGE_TEXT_CAP.to_string())],
        );
        let result = session
            .call(
                "Runtime.evaluate",
                json!({ "expression": script, "returnByValue": true }),
            )
            .await
            .map_err(other)?;
        let value = &result["result"]["value"];
        let mut markdown = value["markdown"].as_str().unwrap_or_default().to_owned();
        if value["truncated"].as_bool() == Some(true) {
            markdown.push_str("\n…(truncated)");
        }
        Ok(markdown)
    }

    async fn screenshot(&self, tab: TabId, full_page: bool) -> Result<Vec<u8>, BrowserError> {
        let session = self.session_for(tab).await?;
        let png = if full_page {
            dive_cdp::page::capture_full_page_instant(&session, dive_cdp::page::ImageFormat::Png)
                .await
        } else {
            dive_cdp::page::capture_screenshot(
                &session,
                dive_cdp::page::ScreenshotOptions::default(),
            )
            .await
        }
        .map_err(other)?;
        if png.len() > SCREENSHOT_TOOL_CAP {
            return Err(BrowserError::ResultTooLarge {
                bytes: png.len(),
                max: SCREENSHOT_TOOL_CAP,
            });
        }
        Ok(png)
    }

    async fn page_state(&self, tab: TabId) -> Result<String, BrowserError> {
        self.ensure_view(tab).await?;
        let session = self.session(tab)?;
        let tree = session
            .call("Accessibility.getFullAXTree", json!({}))
            .await
            .map_err(other)?;
        let nodes = crate::ax::flatten(&tree);
        let refs = nodes
            .iter()
            .filter_map(|n| {
                Some((
                    n.reference.clone()?,
                    crate::buffers::RefTarget {
                        backend_node_id: n.backend_node_id?,
                        role: n.role.clone(),
                        name: n.name.clone(),
                    },
                ))
            })
            .collect();
        self.state().buffers.set_refs(tab, refs);
        Ok(crate::ax::render(&nodes, 1500))
    }

    async fn page_inspect(&self, tab: TabId) -> Result<Value, BrowserError> {
        let session = self.session_for(tab).await?;
        let page = locator::page(&session, crate::snapshot::MAX_TEXT).await?;
        let elements = locator::elements(&session, INSPECT_ELEMENT_CAP).await?;
        let state = self.state();

        // Warnings and errors only. An agent reading this wants to know what
        // is wrong, and `console_tail` is there for the whole log.
        let mut console: Vec<Value> = state
            .buffers
            .console_tail(tab, 500)
            .into_iter()
            .filter(|e| {
                matches!(
                    e.level,
                    crate::console::Level::Warn | crate::console::Level::Error
                )
            })
            .map(|e| {
                json!({
                    "level": e.level,
                    "text": e.text.lines().next().unwrap_or_default().chars().take(300).collect::<String>(),
                    "url": e.url,
                    "line": e.line,
                })
            })
            .collect();
        keep_last(&mut console, INSPECT_DIAGNOSTIC_CAP);

        let all_requests = state.buffers.requests_listing(tab, 1000);
        let total_requests = all_requests.len();
        let mut failed: Vec<Value> = all_requests
            .iter()
            .filter(|r| r.error.is_some() || r.status.is_some_and(|s| s >= 400))
            .map(|r| {
                json!({
                    "id": r.id,
                    "method": r.method,
                    "url": r.url,
                    "status": r.status,
                    "error": r.error,
                })
            })
            .collect();
        keep_last(&mut failed, INSPECT_DIAGNOSTIC_CAP);

        Ok(json!({
            "url": page["url"],
            "title": page["title"],
            "loading": page["loading"],
            "viewport": page["viewport"],
            "scroll": page["scroll"],
            "scroll_height": page["scroll_height"],
            "emulated_color_scheme": page["color_scheme"],
            "visible_text": page["visible_text"],
            "elements": elements["elements"],
            "elements_truncated": elements["truncated"],
            "console": console,
            "failed_requests": failed,
            "request_count": total_requests,
            "actions": state.buffers.timeline(tab, INSPECT_DIAGNOSTIC_CAP),
            "hint": "Each element carries the locator that addresses it. Call page_screenshot when layout matters, network_list for the full request log, console_tail for the whole console.",
        }))
    }

    async fn page_click(&self, tab: TabId, target: Target) -> Result<Value, BrowserError> {
        let session = self.action_session_for(tab).await?;
        let described = target.locator.clone().or_else(|| target.r#ref.clone());
        self.tracked(tab, "page_click", described, async {
            let (x, y, label) = self.point_for(tab, &session, &target).await?;
            automation::click_at(
                &session,
                Some(&self.app),
                tab,
                x,
                y,
                &label,
                self.on_screen(tab),
            )
            .await
            .map_err(|e| other(e.message))?;
            Ok(json!({"clicked": label, "x": x, "y": y}))
        })
        .await
    }

    async fn page_type(
        &self,
        tab: TabId,
        target: Target,
        text: String,
        clear: bool,
        submit: bool,
    ) -> Result<Value, BrowserError> {
        if text.chars().count() > TYPE_TEXT_CAP {
            return Err(BrowserError::BadRequest(format!(
                "text is over the {TYPE_TEXT_CAP} character limit"
            )));
        }
        let session = self.action_session_for(tab).await?;
        let described = target.locator.clone().or_else(|| target.r#ref.clone());
        self.tracked(tab, "page_type", described, async {
            let label = self
                .focus_for(tab, &session, &target, true)
                .await?
                .unwrap_or_else(|| "the focused element".to_owned());
            automation::type_text(&session, &text, clear, submit)
                .await
                .map_err(|e| other(e.message))?;
            Ok(json!({"typed_into": label, "characters": text.chars().count(), "submitted": submit}))
        })
        .await
    }

    async fn page_press(
        &self,
        tab: TabId,
        target: Target,
        key: String,
        modifiers: Vec<String>,
    ) -> Result<(), BrowserError> {
        let session = self.action_session_for(tab).await?;
        self.tracked(tab, "page_press", Some(key.clone()), async {
            // Focusing is optional: pressing Escape to dismiss a dialog has
            // no element to aim at.
            self.focus_for(tab, &session, &target, false).await?;
            let mask = automation::modifier_mask(&modifiers).map_err(|e| other(e.message))?;
            automation::press(&session, &key, mask)
                .await
                .map_err(|e| other(e.message))
        })
        .await
    }

    async fn page_scroll(
        &self,
        tab: TabId,
        target: Target,
        delta_x: f64,
        delta_y: f64,
    ) -> Result<Value, BrowserError> {
        if !delta_x.is_finite()
            || !delta_y.is_finite()
            || delta_x.abs() > MAX_SCROLL_DELTA
            || delta_y.abs() > MAX_SCROLL_DELTA
        {
            return Err(BrowserError::BadRequest(format!(
                "scroll deltas must be finite and no larger than {MAX_SCROLL_DELTA}"
            )));
        }
        let session = self.action_session_for(tab).await?;
        self.tracked(tab, "page_scroll", target.locator.clone(), async {
            // With no target, scroll the middle of the viewport: a wheel
            // event at (0,0) can land on a fixed header that swallows it.
            let (x, y) = if target.locator.is_none() && target.r#ref.is_none() && target.x.is_none()
            {
                let viewport = locator::viewport(&session).await?;
                (viewport.width / 2.0, viewport.height / 2.0)
            } else {
                let (x, y, _) = self.point_for(tab, &session, &target).await?;
                (x, y)
            };
            automation::scroll(&session, x, y, delta_x, delta_y)
                .await
                .map_err(|e| other(e.message))?;
            // CDP acknowledges the wheel event before the compositor applies
            // it. Waiting one frame keeps the returned offset truthful.
            tokio::time::sleep(std::time::Duration::from_millis(SCROLL_SETTLE_MS)).await;
            let page = locator::page(&session, 0).await?;
            Ok(json!({"scroll": page["scroll"], "scroll_height": page["scroll_height"]}))
        })
        .await
    }

    async fn page_wait_for(
        &self,
        tab: TabId,
        params: WaitForParams,
    ) -> Result<Value, BrowserError> {
        let session = self.session_for(tab).await?;
        if params.locator.is_none()
            && params.text.is_none()
            && params.url_includes.is_none()
            && !params.load
        {
            return Err(BrowserError::BadRequest(
                "give at least one of locator, text, url_includes or load=true".into(),
            ));
        }
        if params
            .text
            .as_ref()
            .is_some_and(|text| text.chars().count() > WAIT_TEXT_CAP)
        {
            return Err(BrowserError::BadRequest(format!(
                "wait text is over the {WAIT_TEXT_CAP} character limit"
            )));
        }
        let timeout_ms = params.timeout_ms.unwrap_or(dive_mcp::DEFAULT_WAIT_MS);
        if timeout_ms > dive_mcp::MAX_WAIT_MS {
            return Err(BrowserError::BadRequest(format!(
                "timeout_ms cannot exceed {}",
                dive_mcp::MAX_WAIT_MS
            )));
        }
        let described = params
            .locator
            .clone()
            .or_else(|| params.text.clone())
            .or_else(|| params.url_includes.clone());
        self.tracked(tab, "page_wait_for", described, async {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
            let mut unmet = Vec::new();
            loop {
                unmet.clear();
                let page = locator::page(&session, 0).await?;
                if params.load && page["loading"] == Value::Bool(true) {
                    unmet.push("still loading".to_owned());
                }
                if let Some(text) = &params.text
                    && !locator::contains_text(&session, text).await?
                {
                    unmet.push(format!("text {text:?} not on the page"));
                }
                if let Some(fragment) = &params.url_includes
                    && !page["url"].as_str().unwrap_or_default().contains(fragment)
                {
                    unmet.push(format!("url does not contain {fragment:?}"));
                }
                if let Some(selector) = &params.locator {
                    // An unparseable locator can never match, so fail now
                    // rather than after the whole timeout.
                    let count = locator::count(&session, selector).await?;
                    if count == 0 {
                        unmet.push(format!("nothing matches {selector:?}"));
                    }
                }
                if unmet.is_empty() {
                    return Ok(json!({
                        "matched": true,
                        "url": page["url"],
                        "title": page["title"],
                        "loading": page["loading"],
                    }));
                }
                if std::time::Instant::now() >= deadline {
                    return Err(BrowserError::Timeout {
                        operation: "page_wait_for".into(),
                        timeout_ms,
                        detail: unmet.join("; "),
                    });
                }
                tokio::time::sleep(std::time::Duration::from_millis(WAIT_POLL_MS)).await;
            }
        })
        .await
    }

    async fn page_locate(&self, tab: TabId, selector: String) -> Result<Value, BrowserError> {
        let session = self.session_for(tab).await?;
        let count = locator::count(&session, &selector).await?;
        let matches = locator::all(&session, &selector, LOCATE_CAP).await?;
        Ok(json!({
            "locator": selector,
            "count": count,
            "truncated": usize::try_from(count).unwrap_or(usize::MAX) > matches.len(),
            "matches": matches,
            "hint": if count > 1 {
                "More than one match: append \" >> nth=0\" to pick one."
            } else if matches.is_empty() {
                "Nothing matched. Call page_inspect for the locators that do."
            } else {
                "Unambiguous."
            },
        }))
    }

    async fn page_resize(&self, tab: TabId, params: ResizeParams) -> Result<Value, BrowserError> {
        if let Some(orientation) = params.orientation.as_deref()
            && !matches!(orientation, "portrait" | "landscape")
        {
            return Err(BrowserError::BadRequest(
                "orientation must be portrait or landscape".into(),
            ));
        }
        if params.reset
            && (params.preset.is_some()
                || params.width.is_some()
                || params.height.is_some()
                || params.orientation.is_some())
        {
            return Err(BrowserError::BadRequest(
                "reset=true cannot be combined with a preset, size or orientation".into(),
            ));
        }
        let ui = match params.ui.as_deref() {
            None => crate::emulate::UiMode::Browser,
            Some(name) => crate::emulate::UiMode::parse(name)
                .map_err(|e| BrowserError::BadRequest(e.message))?,
        };
        // (id, device to apply, note)
        let requested = match (&params.preset, params.width, params.height, params.reset) {
            (Some(_), Some(_), _, _) | (Some(_), _, Some(_), _) => {
                return Err(BrowserError::BadRequest(
                    "give either a preset or width and height, not both".into(),
                ));
            }
            (_, _, _, true) => None,
            (Some(id), None, None, _) => {
                let preset = crate::emulate::preset_by_id(id).ok_or_else(|| {
                    BrowserError::BadRequest(format!(
                        "unknown preset {id:?}; call page_devices for the list"
                    ))
                })?;
                // A preset's native orientation is portrait for phones and
                // tablets; a laptop is already landscape.
                let native_landscape = preset.device.width > preset.device.height;
                let landscape = match params.orientation.as_deref() {
                    Some("landscape") => true,
                    Some("portrait") => false,
                    _ => native_landscape,
                };
                let rotated = landscape != native_landscape;
                let device = crate::emulate::realize(&preset, rotated, ui);
                let strips = crate::emulate::strips_for(preset.frame, rotated, ui);
                let (screen_w, screen_h) = if rotated {
                    (preset.device.height, preset.device.width)
                } else {
                    (preset.device.width, preset.device.height)
                };
                let note = if strips == crate::emulate::Insets::default() {
                    format!(
                        "{}: the page gets the whole {screen_w}x{screen_h} screen.",
                        preset.name
                    )
                } else {
                    format!(
                        "{} ({}): the page gets {}x{} of the {screen_w}x{screen_h} screen, with {} CSS px of status bar and browser chrome above and {} below, as it would on the device.",
                        preset.name,
                        params.ui.as_deref().unwrap_or("browser"),
                        device.width,
                        device.height,
                        strips.top,
                        strips.bottom
                    )
                };
                Some((preset.id.clone(), device, note))
            }
            (None, Some(width), Some(height), _) => {
                if params.orientation.is_some() || params.ui.is_some() {
                    return Err(BrowserError::BadRequest(
                        "orientation and ui only apply to a preset".into(),
                    ));
                }
                let device = crate::emulate::exact(width, height)
                    .map_err(|e| BrowserError::BadRequest(e.message))?;
                Some((
                    format!("{width}x{height}"),
                    device,
                    "A bare viewport with Dive's own user agent.".into(),
                ))
            }
            (None, Some(_), None, _) | (None, None, Some(_), _) => {
                return Err(BrowserError::BadRequest(
                    "width and height have to be given together".into(),
                ));
            }
            (None, None, None, false) => {
                return Err(BrowserError::BadRequest(
                    "give a preset, width and height, or reset=true".into(),
                ));
            }
        };
        let described = requested.as_ref().map(|(id, _, _)| id.clone());
        let device = requested.as_ref().map(|(_, d, _)| d.clone());
        let note = requested.as_ref().map(|(_, _, n)| n.clone());
        self.tracked(tab, "page_resize", described.clone(), async {
            let reloaded = self.emulate_device(tab, device.clone()).await?;
            Ok(json!({
                "preset": described,
                "viewport": device.as_ref().map(|d| json!({"width": d.width, "height": d.height})),
                "dpr": device.as_ref().map(|d| d.dpr),
                "safe_area": device.as_ref().and_then(|d| d.safe_area),
                "reset": requested.is_none(),
                "reloaded": reloaded,
                "note": note.unwrap_or_else(|| "Emulation cleared; the page fills the window again.".into()),
            }))
        })
        .await
    }

    async fn page_devices(&self) -> Result<Value, BrowserError> {
        serde_json::to_value(crate::emulate::presets()).map_err(other)
    }

    async fn page_appearance(
        &self,
        tab: TabId,
        mut params: AppearanceParams,
    ) -> Result<Value, BrowserError> {
        // `system` is how a caller clears one override without disturbing
        // the others, so it maps to None rather than being rejected.
        if params.color_scheme.is_none()
            && params.reduced_motion.is_none()
            && params.media_type.is_none()
            && params.display_mode.is_none()
        {
            return Err(BrowserError::BadRequest(
                "give color_scheme, reduced_motion, media_type or display_mode".into(),
            ));
        }
        let current = self.state().buffers.media(tab);
        let color_scheme = params.color_scheme.or(current.color_scheme);
        let reduced_motion = params.reduced_motion.or(current.reduced_motion);
        let media_type = params.media_type.or(current.media_type);
        let display_mode = params.display_mode.or(current.display_mode);
        params.color_scheme = color_scheme;
        params.reduced_motion = reduced_motion;
        params.media_type = media_type;
        params.display_mode = display_mode;
        let clearable =
            |value: Option<String>, allowed: &[&str]| -> Result<Option<String>, BrowserError> {
                match value.as_deref().map(str::trim) {
                    None | Some("system" | "") => Ok(None),
                    Some(v) if allowed.contains(&v) => Ok(Some(v.to_owned())),
                    Some(v) => Err(BrowserError::BadRequest(format!(
                        "unknown value {v:?}; use one of {} or system",
                        allowed.join(", ")
                    ))),
                }
            };
        let overrides = crate::emulate::MediaOverrides {
            color_scheme: clearable(params.color_scheme, &["light", "dark"])?,
            reduced_motion: clearable(params.reduced_motion, &["reduce", "no-preference"])?,
            media_type: clearable(params.media_type, &["screen", "print"])?,
            display_mode: clearable(
                params.display_mode,
                &["standalone", "browser", "fullscreen", "minimal-ui"],
            )?,
        };
        let session = self.session_for(tab).await?;
        let described = overrides.color_scheme.clone();
        self.tracked(tab, "page_appearance", described, async {
            let (method, args) = crate::emulate::media_call(&overrides);
            session.call(method, args).await.map_err(other)?;
            self.state().buffers.set_media(tab, overrides.clone());
            Ok(json!({
                "color_scheme": overrides.color_scheme,
                "reduced_motion": overrides.reduced_motion,
                "media_type": overrides.media_type,
                "display_mode": overrides.display_mode,
            }))
        })
        .await
    }

    async fn page_throttle(&self, tab: TabId, profile: String) -> Result<Value, BrowserError> {
        let parsed = crate::emulate::profile_by_name(&profile)
            .map_err(|e| BrowserError::BadRequest(e.message))?;
        let session = self.session_for(tab).await?;
        self.tracked(tab, "page_throttle", Some(profile.clone()), async {
            let (method, args) = crate::emulate::network_call(parsed);
            session.call(method, args).await.map_err(other)?;
            Ok(json!({
                "profile": parsed.map_or("none".to_owned(), |_| profile.clone()),
                "note": "Reload the tab to see the effect on initial load.",
            }))
        })
        .await
    }

    async fn page_component(&self, tab: TabId, target: Target) -> Result<Value, BrowserError> {
        let session = self.session_for(tab).await?;
        let mut found = match target.resolve()? {
            Addressed::Locator(selector) => locator::component(&session, &selector).await?,
            Addressed::Ref(_) | Addressed::Point { .. } => {
                let (x, y, _) = self.point_for(tab, &session, &target).await?;
                locator::component_at(&session, x, y).await?
            }
        };
        // Turn the bundle location into a source location where a map is
        // available, so the answer points at a file someone can open.
        if let Some(frame) = found.get("source").cloned().filter(|f| !f.is_null()) {
            found["source_resolved"] = self.resolve_source(tab, &frame).await;
        }
        if found["component_name"].is_null() {
            found["note"] = Value::String(
                "No React component was found. Either the page is not React, or it is a production build with no component names or source locations.".into(),
            );
        }
        Ok(found)
    }

    async fn dev_servers(&self) -> Result<Value, BrowserError> {
        let servers = self.state().devservers.refresh().await.0;
        serde_json::to_value(servers).map_err(other)
    }

    async fn api_spec(&self, tab: TabId) -> Result<Value, BrowserError> {
        let state = self.state();
        let page_url = lock(&state.store).tab(tab).map_err(other)?.url;
        Ok(crate::openapi::from_requests(
            &page_url,
            &state.buffers.requests(tab, 1000),
        ))
    }

    async fn page_report(&self, tab: TabId) -> Result<String, BrowserError> {
        let state = self.state();
        let tab_row = lock(&state.store).tab(tab).map_err(other)?;
        Ok(crate::report::compose(
            &tab_row,
            &state.buffers.console_tail(tab, 500),
            &state.buffers.requests(tab, 1000),
            None,
        ))
    }

    async fn rules(&self) -> Result<Value, BrowserError> {
        let state = self.state();
        let ws = (*lock(&state.active_workspace)).ok_or_else(|| other("no active workspace"))?;
        serde_json::to_value(state.rules.list(&state, ws)).map_err(other)
    }

    async fn set_rules(&self, rules: Value) -> Result<(), BrowserError> {
        let state = self.state();
        let ws = (*lock(&state.active_workspace)).ok_or_else(|| other("no active workspace"))?;
        let rules: Vec<crate::rules::Rule> = serde_json::from_value(rules).map_err(other)?;
        state
            .rules
            .set(&state, ws, rules)
            .map_err(|e| other(e.message))?;
        crate::commands::reapply_rules(&state, ws)
            .await
            .map_err(|e| other(e.message))
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
        serde_json::to_value(self.state().buffers.requests_listing(tab, limit)).map_err(other)
    }

    async fn request_body(&self, tab: TabId, request_id: String) -> Result<Value, BrowserError> {
        let row = self
            .state()
            .buffers
            .request(tab, &request_id)
            .ok_or_else(|| BrowserError::Other(format!("no request {request_id}")))?;
        let frames = self.state().buffers.frames(tab, &request_id);
        if !frames.is_empty() {
            let recent: Vec<_> = frames.iter().rev().take(50).rev().collect();
            return Ok(serde_json::json!({
                "request_id": request_id,
                "mime_type": row.mime_type,
                "frames": recent,
                "total_frames": frames.len(),
            }));
        }
        let captured = row.response_body.is_some();
        let body = row.response_body.unwrap_or_default();
        let truncated = body.chars().count() > BODY_TOOL_CAP;
        Ok(serde_json::json!({
            "request_id": request_id,
            "mime_type": row.mime_type,
            "body": body.chars().take(BODY_TOOL_CAP).collect::<String>(),
            "truncated": truncated,
            "captured": captured,
            "capture_note": row.response_body_note,
        }))
    }

    async fn evaluate(&self, tab: TabId, expression: String) -> Result<Value, BrowserError> {
        if expression.chars().count() > EVALUATE_EXPRESSION_CAP {
            return Err(BrowserError::BadRequest(format!(
                "expression is over the {EVALUATE_EXPRESSION_CAP} character limit"
            )));
        }
        self.ensure_view(tab).await?;
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
                    .or_else(|| details["text"].as_str())
                    .unwrap_or("evaluation threw"),
            ));
        }
        let value = result["result"]["value"].clone();
        // A page can hand back a megabyte of DOM. Refusing it with the size
        // is more useful than filling the caller's context with it.
        let bytes = serde_json::to_string(&value).map_or(0, |s| s.len());
        if bytes > EVALUATE_CAP {
            return Err(BrowserError::ResultTooLarge {
                bytes,
                max: EVALUATE_CAP,
            });
        }
        Ok(value)
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
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;

                let metadata = std::fs::symlink_metadata(&path)?;
                if !metadata.file_type().is_file() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "MCP token path is not a regular file",
                    ));
                }
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
            }
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
