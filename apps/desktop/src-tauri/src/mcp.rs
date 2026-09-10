//! Desktop-side implementation of the MCP `Browser` trait plus server startup.

use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine as _;
use dive_cdp::CdpSession;
use dive_core::TabId;
use dive_mcp::{
    Addressed, AppearanceParams, Browser, BrowserError, DialogParams, ResizeParams, SelectParams,
    TabInfo, Target, WaitForParams,
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
/// Fields one `page_fill_form` may fill. Past this it is a page to script,
/// not a form to fill, and one huge call reports failure too coarsely.
const FILL_FIELD_CAP: usize = 40;
/// Files one `page_upload` may attach.
const UPLOAD_FILE_CAP: usize = 20;
/// Steps one `page_mouse` gesture may have. Enough for a signature or a long
/// drag; past it the caller wants a script, not a gesture.
const GESTURE_STEP_CAP: usize = 200;
/// How long a gesture's own pauses may add up to. The call blocks for that
/// whole time, so it has to stay well inside a client's patience.
const GESTURE_DELAY_CAP_MS: u64 = 10_000;
/// Checks one `page_expect` may make.
const EXPECT_CHECK_CAP: usize = 20;
/// How long between re-checks while `page_expect` is waiting.
const EXPECT_POLL_MS: u64 = 120;
/// How long between looks while `downloads` waits for one to finish.
const DOWNLOAD_POLL_MS: u64 = 120;
/// How many matches a visibility check looks at. Past this the answer is the
/// same either way: something is visible.
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

/// Keep a renderer admitted for the entire tool operation, including gaps
/// between polling calls. Dropping/cancelling the operation releases it.
struct ToolSession {
    session: CdpSession,
    _pending: crate::activity::Pending,
}

impl ToolSession {
    fn new(session: CdpSession, activity: &Arc<crate::activity::Registry>, tab: TabId) -> Self {
        Self {
            session,
            _pending: activity.pending(tab),
        }
    }
}

impl std::ops::Deref for ToolSession {
    type Target = CdpSession;

    fn deref(&self) -> &Self::Target {
        &self.session
    }
}

impl AppBrowser {
    /// Wrap the app handle.
    pub fn new(app: AppHandle<Runtime>) -> Self {
        Self { app }
    }

    fn state(&self) -> tauri::State<'_, AppState> {
        self.app.state::<AppState>()
    }

    fn session(&self, tab: TabId) -> Result<ToolSession, BrowserError> {
        let state = self.state();
        let host = lock(&state.host);
        let host = host
            .as_ref()
            .ok_or_else(|| BrowserError::Other("engine not ready".into()))?;
        let session = host
            .cdp(tab)
            .ok_or_else(|| BrowserError::TabNotFound(tab.to_string()))?;
        // The host lock is also held by request_discard. Admit the operation
        // before releasing it, so eviction cannot race session acquisition.
        Ok(ToolSession::new(session, &state.activity, tab))
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

/// A wait may cross a document replacement; retry only known transient CDP
/// readiness failures, and never retry a confirmed closed session.
fn retry_wait_during_navigation(error: &locator::Failure, closed: bool) -> bool {
    !closed
        && matches!(error, locator::Failure::Engine(message) if matches!(message.as_str(),
        "cdp error -32000: Inspected target navigated or closed"
        | "cdp error -32000: Not attached to an active page"
        | "cdp error -32000: Execution context was destroyed."))
}

impl AppBrowser {
    /// A live CDP session for `tab`, creating the view if it has been
    /// discarded.
    async fn session_for(&self, tab: TabId) -> Result<ToolSession, BrowserError> {
        self.ensure_view(tab).await?;
        self.refuse_while_dialog(tab)?;
        self.session(tab)
    }

    /// A page inside `alert()` or `confirm()` answers no CDP call at all:
    /// its main thread is parked in the dialog, so a read would only time
    /// out after 30 s. Say what is open instead.
    fn refuse_while_dialog(&self, tab: TabId) -> Result<(), BrowserError> {
        match self.state().js_dialogs.open(tab) {
            Some(dialog) => Err(BrowserError::NotAllowed {
                operation: "reading the page".into(),
                reason: format!(
                    "the page has a {} dialog open ({:?}) and answers nothing until it is closed; page_inspect shows it, page_dialog answers it",
                    dialog.kind,
                    dialog.message.chars().take(120).collect::<String>()
                ),
            }),
            None => Ok(()),
        }
    }

    /// A session that can accept real input. CEF stops acknowledging `Input`
    /// events while a native child view is hidden, so a user-like action must
    /// bring its target tab forward first.
    async fn action_session_for(&self, tab: TabId) -> Result<ToolSession, BrowserError> {
        self.ensure_view(tab).await?;
        if !self.on_screen(tab) {
            self.activate(tab).await?;
        }
        // A JavaScript dialog pauses the page's script and swallows input;
        // say which one is open and how to answer it.
        if let Some(dialog) = self.state().js_dialogs.open(tab) {
            return Err(BrowserError::NotAllowed {
                operation: "page input".into(),
                reason: format!(
                    "the page has a {} dialog open ({:?}); answer it with page_dialog first",
                    dialog.kind,
                    dialog.message.chars().take(120).collect::<String>()
                ),
            });
        }
        // Input to a page hidden under a chrome dialog never arrives; say so
        // now rather than after a 30 s round-trip timeout.
        let covered = lock(&self.state().host)
            .as_ref()
            .is_some_and(|host| host.covered() && !host.is_detached(tab));
        if covered {
            return Err(BrowserError::NotAllowed {
                operation: "page input".into(),
                reason: "a dialog or menu is open over the page; close it and try again".into(),
            });
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

    /// Run an input action, but stop waiting the moment the page opens a
    /// JavaScript dialog: the page's script is paused inside it, so the CDP
    /// input call would only time out. `on_dialog` turns the dialog into
    /// the tool's result instead.
    async fn or_dialog<T>(
        &self,
        tab: TabId,
        work: impl std::future::Future<Output = Result<T, BrowserError>>,
        on_dialog: impl FnOnce(&crate::js_dialog::JsDialogAsked) -> Result<T, BrowserError>,
    ) -> Result<T, BrowserError> {
        tokio::pin!(work);
        loop {
            tokio::select! {
                outcome = &mut work => return outcome,
                () = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                    if let Some(dialog) = self.state().js_dialogs.open(tab) {
                        return on_dialog(&dialog);
                    }
                }
            }
        }
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
        // Everything an agent does to a page comes through here, whether it
        // is the sidecar's own run or an MCP client on the other end of the
        // server, so this is where "something is driving this tab" is known.
        let presence = std::sync::Arc::clone(&self.state().agent_presence);
        presence.begin(&self.app, tab);
        let outcome = work.await;
        let error = outcome.as_ref().err().map(ToString::to_string);
        self.state().buffers.end_action(tab, &id, error);
        presence.end(&self.app, tab);
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
                    format!("{} {:?}", found.role, found.name).trim().to_owned()
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
                Ok(Some(
                    format!("{} {:?}", found.role, found.name).trim().to_owned(),
                ))
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

/// What an input tool returns when the action opened a dialog instead of
/// finishing: the dialog, and what to do about it.
fn dialog_opened(dialog: &crate::js_dialog::JsDialogAsked, action: &str) -> Value {
    json!({
        "dialog": {
            "kind": dialog.kind,
            "message": dialog.message,
            "default_value": dialog.default_value,
            "origin": dialog.origin,
        },
        "hint": format!("{action} opened a dialog and the page is waiting on it. Answer it with page_dialog (accept true or false, text for a prompt), then carry on."),
    })
}

/// Paper size in inches, by the names people use for paper.
fn paper_size(named: Option<&str>) -> Result<(f64, f64), BrowserError> {
    Ok(match named.unwrap_or("a4").to_ascii_lowercase().as_str() {
        "a4" => (8.27, 11.69),
        "a3" => (11.69, 16.54),
        "a5" => (5.83, 8.27),
        "letter" => (8.5, 11.0),
        "legal" => (8.5, 14.0),
        "tabloid" => (11.0, 17.0),
        other => {
            return Err(BrowserError::BadRequest(format!(
                "{other:?} is not a paper size; use a3, a4, a5, letter, legal or tabloid"
            )));
        }
    })
}

/// The file name a PDF is saved under.
///
/// A name, never a path: the file goes to the download folder, and a caller
/// that could pass `../` or an absolute path would be choosing where on the
/// disk a remote tool call writes.
fn pdf_filename(given: Option<&str>) -> Result<String, BrowserError> {
    let Some(given) = given.map(str::trim).filter(|n| !n.is_empty()) else {
        return Ok("page.pdf".to_owned());
    };
    if given.contains('/') || given.contains('\\') || given.starts_with('.') {
        return Err(BrowserError::BadRequest(
            "filename is a name, not a path; the file goes to the download folder".into(),
        ));
    }
    Ok(
        if std::path::Path::new(given)
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
        {
            given.to_owned()
        } else {
            format!("{given}.pdf")
        },
    )
}

/// Run one check and say whether it held, and what was there if it did not.
///
/// The "what was there" half is the point: an assertion that fails without
/// saying what it found instead costs another call to diagnose, and an agent
/// writing a test will make that call every time.
async fn run_check(
    session: &ToolSession,
    check: &dive_mcp::ExpectCheck,
) -> Result<Value, BrowserError> {
    let named = |what: String, passed: bool, actual: String| {
        Ok(json!({"check": what, "passed": passed, "actual": actual}))
    };
    if let Some(locator) = &check.visible {
        let seen = visible_matches(session, locator).await?;
        let matched = locator::count(session, locator).await?;
        return named(
            format!("visible {locator:?}"),
            seen > 0,
            if matched > 0 {
                // Told apart deliberately: "it is not there" and "it is there
                // but nobody can see it" call for different fixes.
                format!(
                    "{matched} {} match but none are visible",
                    plural(matched as usize, "element")
                )
            } else {
                "nothing matches it".to_owned()
            },
        );
    }
    if let Some(locator) = &check.hidden {
        let seen = visible_matches(session, locator).await?;
        return named(
            format!("hidden {locator:?}"),
            seen == 0,
            format!("{seen} {} still visible", plural(seen, "element")),
        );
    }
    if let Some(text) = &check.text {
        let found = locator::contains_text(session, text).await?;
        return named(
            format!("text {text:?}"),
            found,
            "the page does not show it".into(),
        );
    }
    if let Some(text) = &check.no_text {
        let found = locator::contains_text(session, text).await?;
        return named(
            format!("no_text {text:?}"),
            !found,
            "the page still shows it".into(),
        );
    }
    if let Some(want) = &check.value {
        locator::hold(session, &want.locator).await?;
        let held = session
            .call(
                "Runtime.evaluate",
                json!({"expression": "(() => { const el = window.__diveHeld; if (!el) return null; return el.value !== undefined ? String(el.value) : el.textContent; })()", "returnByValue": true}),
            )
            .await
            .map_err(|e| other(e.to_string()))?;
        let actual = held["result"]["value"].as_str().unwrap_or("");
        return named(
            format!("value of {:?} is {:?}", want.locator, want.equals),
            actual == want.equals,
            format!("it holds {actual:?}"),
        );
    }
    if let Some(want) = &check.count {
        let seen = locator::count(session, &want.locator).await?;
        let passed = want.equals.is_none_or(|n| seen == n)
            && want.at_least.is_none_or(|n| seen >= n)
            && want.at_most.is_none_or(|n| seen <= n);
        if want.equals.is_none() && want.at_least.is_none() && want.at_most.is_none() {
            return Err(BrowserError::BadRequest(
                "a count check needs equals, at_least or at_most".into(),
            ));
        }
        return named(
            format!("count of {:?}", want.locator),
            passed,
            format!("{seen} match"),
        );
    }
    if let Some(want) = &check.url_includes {
        let page = locator::page(session, 0).await?;
        let url = page["url"].as_str().unwrap_or("");
        return named(
            format!("url includes {want:?}"),
            url.contains(want.as_str()),
            format!("the address is {url:?}"),
        );
    }
    if let Some(want) = &check.title_includes {
        let page = locator::page(session, 0).await?;
        let title = page["title"].as_str().unwrap_or("");
        return named(
            format!("title includes {want:?}"),
            title.contains(want.as_str()),
            format!("the title is {title:?}"),
        );
    }
    Err(BrowserError::BadRequest(
        "each check needs exactly one of visible, hidden, text, no_text, value, count, url_includes or title_includes".into(),
    ))
}

/// How many elements a locator matches that a person could actually see.
///
/// Matching is not the same as being visible: a menu that is in the DOM but
/// collapsed matches its locator, and asserting on that would pass while the
/// person sees nothing. The engine's own `visible=true` filter decides, so
/// "visible" means here exactly what it means to a click.
async fn visible_matches(session: &ToolSession, locator: &str) -> Result<usize, BrowserError> {
    // `>>` scopes the next step inside the last, so this is "of the things
    // that match, the ones that are visible" rather than a second locator.
    let count = locator::count(session, &format!("{locator} >> visible=true")).await?;
    Ok(count as usize)
}

/// "1 element" / "2 elements", so a failure reads as a sentence.
fn plural(count: usize, word: &str) -> String {
    if count == 1 {
        word.to_owned()
    } else {
        format!("{word}s")
    }
}

/// The button a gesture step means, or why it is not one.
fn mouse_button(named: Option<&str>) -> Result<String, String> {
    match named.unwrap_or("left") {
        button @ ("left" | "right" | "middle") => Ok(button.to_owned()),
        other => Err(format!("button is left, right or middle, not {other:?}")),
    }
}

/// Where a gesture step happens.
///
/// A step with no coordinates happens wherever the last one left the pointer,
/// which is what makes `[move, down, move, move, up]` read as a drag. That
/// only works once something has said where the pointer is, so the first step
/// has to carry a position, and a point outside the viewport is refused
/// rather than sent: the page never sees such an event, so the gesture would
/// simply appear to do nothing.
fn gesture_point(
    step: &dive_mcp::MouseStep,
    previous: Option<(f64, f64)>,
    view: locator::Viewport,
) -> Result<(f64, f64), String> {
    match (step.x, step.y) {
        (Some(x), Some(y)) => {
            if x < 0.0 || y < 0.0 || x > view.width || y > view.height {
                return Err(format!(
                    "({x}, {y}) is outside the {}x{} viewport",
                    view.width, view.height
                ));
            }
            Ok((x, y))
        }
        (None, None) => previous.ok_or_else(|| {
            "the pointer has no position yet, so this step needs x and y".to_owned()
        }),
        _ => Err("give both x and y, or neither".to_owned()),
    }
}

/// One cookie in the shape `Network.setCookies` wants.
///
/// A cookie with neither a domain nor a URL is rejected outright, so the
/// page's own URL stands in for a missing domain: "a cookie for this page" is
/// what a caller who left it out meant, and it is the only guess that is ever
/// right. Path defaults to `/` for the same reason -- a cookie scoped to the
/// current path only would not be sent from anywhere else on the site, which
/// is never what restoring a session wanted.
fn cdp_cookie(cookie: &dive_mcp::Cookie, page_url: &str) -> Value {
    let mut entry = serde_json::Map::new();
    entry.insert("name".into(), json!(cookie.name));
    entry.insert("value".into(), json!(cookie.value));
    match &cookie.domain {
        Some(domain) => entry.insert("domain".into(), json!(domain)),
        None => entry.insert("url".into(), json!(page_url)),
    };
    entry.insert(
        "path".into(),
        json!(cookie.path.clone().unwrap_or_else(|| "/".into())),
    );
    if let Some(expires) = cookie.expires {
        entry.insert("expires".into(), json!(expires));
    }
    if let Some(http_only) = cookie.http_only {
        entry.insert("httpOnly".into(), json!(http_only));
    }
    if let Some(secure) = cookie.secure {
        entry.insert("secure".into(), json!(secure));
    }
    if let Some(same_site) = &cookie.same_site {
        entry.insert("sameSite".into(), json!(same_site));
    }
    Value::Object(entry)
}

/// The page's own URL, for scoping cookie reads and writes to this site.
async fn page_url(session: &ToolSession) -> Result<String, BrowserError> {
    let value = session
        .call(
            "Runtime.evaluate",
            json!({"expression": "location.href", "returnByValue": true}),
        )
        .await
        .map_err(|e| other(e.to_string()))?;
    value["result"]["value"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| other("the page did not say what its URL is"))
}

/// `localStorage` or `sessionStorage` as a flat object.
async fn read_web_storage(session: &ToolSession, which: &str) -> Result<Value, BrowserError> {
    let expression = format!(
        "(() => {{ try {{ const s = window.{which}Storage; const out = {{}}; for (let i = 0; i < s.length; i++) {{ const k = s.key(i); out[k] = s.getItem(k); }} return out; }} catch (e) {{ return {{ __error: String(e && e.message || e) }}; }} }})()"
    );
    let value = session
        .call(
            "Runtime.evaluate",
            json!({"expression": expression, "returnByValue": true}),
        )
        .await
        .map_err(|e| other(e.to_string()))?;
    let out = value["result"]["value"].clone();
    // A page on an opaque origin, or one with storage blocked, throws on
    // access rather than returning nothing; that is worth saying plainly
    // instead of reporting an empty store the caller would believe.
    if let Some(problem) = out["__error"].as_str() {
        return Err(BrowserError::BadRequest(format!(
            "this page cannot use {which}Storage: {problem}"
        )));
    }
    Ok(out)
}

/// Add or replace keys in `localStorage` or `sessionStorage`.
async fn write_web_storage(
    session: &ToolSession,
    which: &str,
    values: &std::collections::BTreeMap<String, String>,
) -> Result<(), BrowserError> {
    let payload = serde_json::to_string(values).map_err(other)?;
    let expression = format!(
        "(() => {{ try {{ const s = window.{which}Storage; const v = {payload}; for (const k of Object.keys(v)) s.setItem(k, v[k]); return null; }} catch (e) {{ return String(e && e.message || e); }} }})()"
    );
    let value = session
        .call(
            "Runtime.evaluate",
            json!({"expression": expression, "returnByValue": true}),
        )
        .await
        .map_err(|e| other(e.to_string()))?;
    if let Some(problem) = value["result"]["value"].as_str() {
        return Err(BrowserError::BadRequest(format!(
            "this page cannot use {which}Storage: {problem}"
        )));
    }
    Ok(())
}

/// Empty `localStorage` or `sessionStorage`, reporting how much went.
async fn clear_web_storage(session: &ToolSession, which: &str) -> Result<u64, BrowserError> {
    let expression = format!(
        "(() => {{ try {{ const s = window.{which}Storage; const n = s.length; s.clear(); return n; }} catch {{ return -1; }} }})()"
    );
    let value = session
        .call(
            "Runtime.evaluate",
            json!({"expression": expression, "returnByValue": true}),
        )
        .await
        .map_err(|e| other(e.to_string()))?;
    // A page that cannot touch storage has nothing to clear, which is not a
    // failure: the caller asked for it to be empty and it is.
    Ok(value["result"]["value"]
        .as_i64()
        .unwrap_or(0)
        .max(0)
        .unsigned_abs())
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
        let session = self.session_for(tab).await?;
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
        let session = self.session_for(tab).await?;
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
        let session = self.session_for(tab).await?;
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
        self.ensure_view(tab).await?;
        if let Some(dialog) = self.state().js_dialogs.open(tab) {
            // Nothing in the page can be read until this is answered, so the
            // report is the dialog and what the tab was doing.
            let known = self
                .tabs()
                .await?
                .into_iter()
                .find(|t| t.id == tab.to_string());
            return Ok(json!({
                "url": known.as_ref().map(|t| t.url.clone()),
                "title": known.map(|t| t.title),
                "dialog": {
                    "kind": dialog.kind,
                    "message": dialog.message,
                    "default_value": dialog.default_value,
                    "origin": dialog.origin,
                },
                "actions": self.state().buffers.timeline(tab, INSPECT_DIAGNOSTIC_CAP),
                "hint": "The page is paused in this dialog and cannot be read or clicked until it is answered. Call page_dialog with accept true or false (and text for a prompt), then page_inspect again.",
            }));
        }
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
            "dialog": state.js_dialogs.open(tab).map(|d| json!({
                "kind": d.kind,
                "message": d.message,
                "default_value": d.default_value,
                "origin": d.origin,
            })),
            "hint": "Each element carries the locator that addresses it. Call page_screenshot when layout matters, network_list for the full request log, console_tail for the whole console.",
        }))
    }

    async fn page_click(&self, tab: TabId, target: Target) -> Result<Value, BrowserError> {
        let session = self.action_session_for(tab).await?;
        let described = target.locator.clone().or_else(|| target.r#ref.clone());
        self.tracked(
            tab,
            "page_click",
            described,
            self.or_dialog(
                tab,
                async {
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
                },
                |dialog| Ok(dialog_opened(dialog, "The click")),
            ),
        )
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
        self.tracked(tab, "page_type", described, self.or_dialog(tab, async {
            let label = self
                .focus_for(tab, &session, &target, true)
                .await?
                .unwrap_or_else(|| "the focused element".to_owned());
            automation::type_text(&session, &text, clear, submit)
                .await
                .map_err(|e| other(e.message))?;
            Ok(json!({"typed_into": label, "characters": text.chars().count(), "submitted": submit}))
        }, |dialog| Ok(dialog_opened(dialog, "Typing"))))
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
        self.tracked(
            tab,
            "page_press",
            Some(key.clone()),
            self.or_dialog(
                tab,
                async {
                    // Focusing is optional: pressing Escape to dismiss a dialog has
                    // no element to aim at.
                    self.focus_for(tab, &session, &target, false).await?;
                    let mask =
                        automation::modifier_mask(&modifiers).map_err(|e| other(e.message))?;
                    automation::press(&session, &key, mask)
                        .await
                        .map_err(|e| other(e.message))
                },
                |dialog| {
                    // The trait gives a key press nothing to say, so the dialog
                    // is reported the one way it can be: as the reason it stopped.
                    Err(BrowserError::NotAllowed {
                        operation: "page_press".into(),
                        reason: format!(
                            "the key opened a {} dialog ({:?}); answer it with page_dialog",
                            dialog.kind,
                            dialog.message.chars().take(120).collect::<String>()
                        ),
                    })
                },
            ),
        )
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

    async fn history(&self, tab: TabId, action: String) -> Result<Value, BrowserError> {
        let action = match action.trim().to_ascii_lowercase().as_str() {
            "back" => "back",
            "forward" => "forward",
            "reload" | "refresh" => "reload",
            _ => {
                return Err(BrowserError::BadRequest(
                    "action must be back, forward or reload".into(),
                ));
            }
        };
        self.ensure_view(tab).await?;
        self.tracked(tab, "tab_history", Some(action.into()), async {
            self.on_main(move |app| {
                let state = app.state::<AppState>();
                let step: fn(&tauri::Webview<Runtime>) -> tauri::Result<()> = match action {
                    "back" => tauri::Webview::go_back,
                    "forward" => tauri::Webview::go_forward,
                    _ => tauri::Webview::reload,
                };
                crate::commands::with_view(&state, tab, step).map_err(|e| other(e.message))
            })
            .await??;
            Ok(json!({
                "action": action,
                "hint": "Call page_wait_for with load:true before reading the page.",
            }))
        })
        .await
    }

    async fn page_hover(&self, tab: TabId, target: Target) -> Result<Value, BrowserError> {
        let session = self.action_session_for(tab).await?;
        let described = target.locator.clone().or_else(|| target.r#ref.clone());
        self.tracked(
            tab,
            "page_hover",
            described,
            self.or_dialog(
                tab,
                async {
                    let (x, y, label) = self.point_for(tab, &session, &target).await?;
                    automation::hover_at(
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
                    Ok(json!({"hovering": label, "x": x, "y": y, "hint": "The pointer stays here until the next input; call page_inspect or page_screenshot to see what appeared."}))
                },
                |dialog| Ok(dialog_opened(dialog, "Hovering")),
            ),
        )
        .await
    }

    async fn page_select(&self, tab: TabId, params: SelectParams) -> Result<Value, BrowserError> {
        if params.value.is_none() && params.label.is_none() {
            return Err(BrowserError::BadRequest(
                "give value (the option's value attribute) or label (its visible text)".into(),
            ));
        }
        let session = self.action_session_for(tab).await?;
        let target = params.target;
        let described = target.locator.clone().or_else(|| target.r#ref.clone());
        self.tracked(tab, "page_select", described.clone(), async {
            let named = match target.resolve()? {
                Addressed::Locator(selector) => {
                    locator::hold(&session, &selector).await?;
                    selector
                }
                Addressed::Ref(_) | Addressed::Point { .. } => {
                    let (x, y, label) = self.point_for(tab, &session, &target).await?;
                    locator::component_hold_at(&session, x, y).await?;
                    label
                }
            };
            let outcome =
                locator::select_held(&session, params.value.as_deref(), params.label.as_deref())
                    .await?;
            match outcome["error"].as_str() {
                Some("not_select") => Err(BrowserError::BadRequest(format!(
                    "{named} is a <{}>, not a <select>; a custom dropdown is clicked like anything else",
                    outcome["tag"].as_str().unwrap_or("?")
                ))),
                Some("no_option") => Err(BrowserError::BadRequest(format!(
                    "{named} has no option {}; its options are {}",
                    params.value.or(params.label).map(|s| format!("{s:?}")).unwrap_or_default(),
                    outcome["options"]
                ))),
                Some("disabled") => Err(BrowserError::NotAllowed {
                    operation: "page_select".into(),
                    reason: format!("option {} is disabled", outcome["label"]),
                }),
                _ => Ok(json!({
                    "selected": named,
                    "value": outcome["value"],
                    "label": outcome["label"],
                    "changed": outcome["changed"],
                })),
            }
        })
        .await
    }

    async fn page_dialog(&self, tab: TabId, params: DialogParams) -> Result<Value, BrowserError> {
        self.ensure_view(tab).await?;
        let accept = params.accept.unwrap_or(true);
        let text = params.text;
        let label = if accept { "accept" } else { "dismiss" };
        self.tracked(tab, "page_dialog", Some(label.into()), async {
            let answered = self
                .on_main(move |app| {
                    let state = app.state::<AppState>();
                    let Some(dialog) = state.js_dialogs.open(tab) else {
                        return Err(BrowserError::BadRequest(
                            "the page has no dialog open; page_inspect shows one under 'dialog' when it does".into(),
                        ));
                    };
                    crate::js_dialog::answer(app, &state, tab, &dialog.dialog_id, accept, text)
                        .map_err(|e| other(e.message))
                })
                .await??;
            Ok(json!({
                "kind": answered.kind,
                "message": answered.message,
                "accepted": accept,
                "hint": "The page's script has resumed. Call page_inspect or page_wait_for to see what it did next.",
            }))
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
            loop {
                let probe = async {
                    let mut unmet = Vec::new();
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
                    Ok::<_, locator::Failure>((page, unmet))
                }
                .await;
                let (page, unmet) = match probe {
                    Ok(status) => status,
                    Err(error) if retry_wait_during_navigation(&error, session.is_closed()) => (
                        Value::Null,
                        vec!["navigation changed the document during the wait".into()],
                    ),
                    Err(error) => return Err(error.into()),
                };
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

    async fn page_fill_form(
        &self,
        tab: TabId,
        params: dive_mcp::FillFormParams,
    ) -> Result<Value, BrowserError> {
        if params.fields.is_empty() {
            return Err(BrowserError::BadRequest(
                "give at least one field: [{locator, value}]".into(),
            ));
        }
        if params.fields.len() > FILL_FIELD_CAP {
            return Err(BrowserError::BadRequest(format!(
                "fill at most {FILL_FIELD_CAP} fields at a time"
            )));
        }
        let session = self.action_session_for(tab).await?;
        let submit = params.submit.unwrap_or(false);
        let described = Some(format!("{} fields", params.fields.len()));
        self.tracked(tab, "page_fill_form", described, self.or_dialog(tab, async {
            let mut filled = Vec::new();
            let last = params.fields.len() - 1;
            for (index, field) in params.fields.iter().enumerate() {
                if field.value.chars().count() > TYPE_TEXT_CAP {
                    return Err(BrowserError::BadRequest(format!(
                        "the value for {} is over the {TYPE_TEXT_CAP} character limit",
                        field.locator
                    )));
                }
                // Held first, so the kind decides how the value is applied.
                // A form is a mix of text fields, dropdowns and checkboxes,
                // and asking the caller to sort them out per field would
                // defeat the point of filling the form in one call.
                locator::hold(&session, &field.locator).await?;
                let kind = locator::kind_held(&session).await?;
                let how = kind["kind"].as_str().unwrap_or("text");
                match how {
                    "select" => {
                        // A value that is not an option's `value` is tried as
                        // its visible label, which is what a caller reading
                        // the page would have to hand. The engine reports a
                        // miss in the payload rather than as an error, so it
                        // has to be read out of the answer -- otherwise a
                        // dropdown that matched nothing would be reported as
                        // filled and the form would submit with it empty.
                        let mut chosen =
                            locator::select_held(&session, Some(&field.value), None).await?;
                        if chosen["error"].is_string() {
                            chosen = locator::select_held(&session, None, Some(&field.value))
                                .await?;
                        }
                        if let Some(problem) = chosen["error"].as_str() {
                            let options = chosen["options"]
                                .as_array()
                                .map(|o| {
                                    o.iter()
                                        .filter_map(|opt| opt["label"].as_str())
                                        .collect::<Vec<_>>()
                                        .join(", ")
                                })
                                .unwrap_or_default();
                            return Err(BrowserError::BadRequest(match problem {
                                "disabled" => format!("{}: that option is disabled", field.locator),
                                _ => format!(
                                    "{}: no option {:?}; its options are {options}",
                                    field.locator, field.value
                                ),
                            }));
                        }
                        filled.push(json!({"locator": field.locator, "as": "select", "value": chosen["value"], "label": chosen["label"]}));
                    }
                    "checked" => {
                        let want = matches!(
                            field.value.trim().to_ascii_lowercase().as_str(),
                            "true" | "yes" | "on" | "1" | "checked"
                        );
                        let outcome = locator::set_checked_held(&session, want).await?;
                        filled.push(json!({"locator": field.locator, "as": "checkbox", "checked": outcome["checked"]}));
                    }
                    "file" => {
                        return Err(BrowserError::BadRequest(format!(
                            "{} is a file input; attach files with page_upload",
                            field.locator
                        )));
                    }
                    _ => {
                        locator::focus(&session, &field.locator).await?;
                        // Enter goes in the last field only, once the rest of
                        // the form holds what it should.
                        let press_enter = submit && index == last;
                        automation::type_text(&session, &field.value, true, press_enter)
                            .await
                            .map_err(|e| other(e.message))?;
                        filled.push(json!({"locator": field.locator, "as": "text", "characters": field.value.chars().count()}));
                    }
                }
            }
            Ok(json!({"filled": filled, "submitted": submit}))
        }, |dialog| Ok(dialog_opened(dialog, "Filling the form"))))
        .await
    }

    async fn page_upload(
        &self,
        tab: TabId,
        params: dive_mcp::UploadParams,
    ) -> Result<Value, BrowserError> {
        let locator = params
            .locator
            .ok_or_else(|| BrowserError::BadRequest("give locator: the file input".into()))?;
        if params.paths.len() > UPLOAD_FILE_CAP {
            return Err(BrowserError::BadRequest(format!(
                "attach at most {UPLOAD_FILE_CAP} files at a time"
            )));
        }
        // Checked here rather than left to Chromium, which accepts a missing
        // path in silence and leaves the input empty.
        for path in &params.paths {
            let p = std::path::Path::new(path);
            if !p.is_absolute() {
                return Err(BrowserError::BadRequest(format!(
                    "{path} is not an absolute path"
                )));
            }
            if !p.is_file() {
                return Err(BrowserError::BadRequest(format!("no file at {path}")));
            }
        }
        let session = self.action_session_for(tab).await?;
        self.tracked(tab, "page_upload", Some(locator.clone()), async {
            locator::hold(&session, &locator).await?;
            let kind = locator::kind_held(&session).await?;
            if kind["kind"].as_str() != Some("file") {
                return Err(BrowserError::BadRequest(format!(
                    "{locator} is a <{}>, not a file input; a picker opened by a click cannot be driven",
                    kind["tag"].as_str().unwrap_or("?")
                )));
            }
            // DOM.setFileInputFiles needs the node itself, so the held
            // element is handed back unserialised for its object id.
            let held = session
                .call(
                    "Runtime.evaluate",
                    json!({"expression": "window.__diveHeld", "returnByValue": false}),
                )
                .await
                .map_err(|e| other(e.to_string()))?;
            let object_id = held["result"]["objectId"]
                .as_str()
                .ok_or_else(|| other("the file input went away before the files could be attached"))?
                .to_owned();
            session
                .call(
                    "DOM.setFileInputFiles",
                    json!({"files": params.paths, "objectId": object_id}),
                )
                .await
                .map_err(|e| other(e.to_string()))?;
            Ok(json!({"attached_to": locator, "files": params.paths}))
        })
        .await
    }

    async fn page_drag(
        &self,
        tab: TabId,
        params: dive_mcp::DragParams,
    ) -> Result<Value, BrowserError> {
        let from = params
            .from
            .ok_or_else(|| BrowserError::BadRequest("give from: what to pick up".into()))?;
        let to = params
            .to
            .ok_or_else(|| BrowserError::BadRequest("give to: where to drop it".into()))?;
        let session = self.action_session_for(tab).await?;
        let described = Some(format!("{from} → {to}"));
        self.tracked(
            tab,
            "page_drag",
            described,
            self.or_dialog(
                tab,
                async {
                    let start = locator::point(&session, &from).await?;
                    // Resolved one at a time: picking the source up can move the
                    // destination, so the drop point is read from the page as it is
                    // once the drag is under way rather than from how it looked
                    // before.
                    let end = locator::point(&session, &to).await?;
                    automation::drag_between(
                        &session,
                        Some(&self.app),
                        tab,
                        (start.x, start.y),
                        (end.x, end.y),
                        &format!("{} → {}", start.describe(), end.describe()),
                        self.on_screen(tab),
                    )
                    .await
                    .map_err(|e| other(e.message))?;
                    Ok(json!({
                        "dragged": from,
                        "onto": to,
                        "from": {"x": start.x, "y": start.y},
                        "to": {"x": end.x, "y": end.y},
                    }))
                },
                |dialog| Ok(dialog_opened(dialog, "The drag")),
            ),
        )
        .await
    }

    async fn page_storage_get(
        &self,
        tab: TabId,
        params: dive_mcp::StorageGetParams,
    ) -> Result<Value, BrowserError> {
        use dive_mcp::StorageKind;
        let wanted = params.include.unwrap_or_else(|| {
            vec![
                StorageKind::Cookies,
                StorageKind::Local,
                StorageKind::Session,
            ]
        });
        let session = self.session_for(tab).await?;
        let mut out = serde_json::Map::new();
        if wanted.contains(&StorageKind::Cookies) {
            // Scoped to the page's own URL rather than the whole jar: an
            // agent asking about this page should not be handed every cookie
            // the profile holds for every site it has ever visited.
            let url = page_url(&session).await?;
            let answer = session
                .call("Network.getCookies", json!({"urls": [url]}))
                .await
                .map_err(|e| other(e.to_string()))?;
            out.insert("cookies".into(), answer["cookies"].clone());
        }
        for (kind, name) in [
            (StorageKind::Local, "local"),
            (StorageKind::Session, "session"),
        ] {
            if !wanted.contains(&kind) {
                continue;
            }
            out.insert(name.into(), read_web_storage(&session, name).await?);
        }
        Ok(Value::Object(out))
    }

    async fn page_storage_set(
        &self,
        tab: TabId,
        params: dive_mcp::StorageSetParams,
    ) -> Result<Value, BrowserError> {
        let session = self.session_for(tab).await?;
        let mut set = serde_json::Map::new();
        if let Some(cookies) = params.cookies {
            let url = page_url(&session).await?;
            let prepared: Vec<Value> = cookies.iter().map(|c| cdp_cookie(c, &url)).collect();
            session
                .call("Network.setCookies", json!({"cookies": prepared}))
                .await
                .map_err(|e| other(e.to_string()))?;
            set.insert("cookies".into(), json!(prepared.len()));
        }
        for (name, values) in [("local", params.local), ("session", params.session)] {
            let Some(values) = values else { continue };
            let count = values.len();
            write_web_storage(&session, name, &values).await?;
            set.insert(name.into(), json!(count));
        }
        if set.is_empty() {
            return Err(BrowserError::BadRequest(
                "give cookies, local or session: there is nothing to set".into(),
            ));
        }
        Ok(json!({"set": Value::Object(set), "note": "the page reads this on its next load"}))
    }

    async fn page_storage_clear(
        &self,
        tab: TabId,
        params: dive_mcp::StorageClearParams,
    ) -> Result<Value, BrowserError> {
        use dive_mcp::StorageKind;
        let wanted = params.clear.unwrap_or_else(|| {
            vec![
                StorageKind::Cookies,
                StorageKind::Local,
                StorageKind::Session,
            ]
        });
        let session = self.session_for(tab).await?;
        let mut cleared = Vec::new();
        if wanted.contains(&StorageKind::Cookies) {
            // Only this page's cookies: clearing the whole jar would sign the
            // person out of every site they are in, which is never what a
            // tool call about one page meant.
            let url = page_url(&session).await?;
            let answer = session
                .call("Network.getCookies", json!({"urls": [url]}))
                .await
                .map_err(|e| other(e.to_string()))?;
            let empty = Vec::new();
            let cookies = answer["cookies"].as_array().unwrap_or(&empty);
            for cookie in cookies {
                let Some(name) = cookie["name"].as_str() else {
                    continue;
                };
                session
                    .call(
                        "Network.deleteCookies",
                        json!({"name": name, "url": url, "domain": cookie["domain"], "path": cookie["path"]}),
                    )
                    .await
                    .map_err(|e| other(e.to_string()))?;
            }
            cleared.push(json!({"cookies": cookies.len()}));
        }
        for (kind, name) in [
            (StorageKind::Local, "local"),
            (StorageKind::Session, "session"),
        ] {
            if !wanted.contains(&kind) {
                continue;
            }
            let count = clear_web_storage(&session, name).await?;
            cleared.push(json!({name: count}));
        }
        Ok(json!({"cleared": cleared}))
    }

    async fn page_mouse(
        &self,
        tab: TabId,
        params: dive_mcp::MouseParams,
    ) -> Result<Value, BrowserError> {
        use dive_mcp::MouseAction;
        if params.steps.is_empty() {
            return Err(BrowserError::BadRequest(
                "give at least one step: [{action:'move', x, y}]".into(),
            ));
        }
        if params.steps.len() > GESTURE_STEP_CAP {
            return Err(BrowserError::BadRequest(format!(
                "a gesture may have at most {GESTURE_STEP_CAP} steps"
            )));
        }
        let total_delay: u64 = params.steps.iter().filter_map(|s| s.delay_ms).sum();
        if total_delay > GESTURE_DELAY_CAP_MS {
            return Err(BrowserError::BadRequest(format!(
                "the pauses in this gesture add up to {total_delay}ms, over the {GESTURE_DELAY_CAP_MS}ms limit"
            )));
        }
        let session = self.action_session_for(tab).await?;
        let described = Some(format!("{} steps", params.steps.len()));
        let on_screen = self.on_screen(tab);
        self.tracked(tab, "page_mouse", described, self.or_dialog(tab, async {
            let view = locator::viewport(&session).await?;
            // The pointer has to start somewhere. Nothing is known about where
            // it is when the gesture begins, so a step that gives no
            // coordinates before any step has is a mistake worth naming.
            let mut at: Option<(f64, f64)> = None;
            let mut held: Option<String> = None;
            for (index, step) in params.steps.iter().enumerate() {
                let button = mouse_button(step.button.as_deref())
                    .map_err(|e| BrowserError::BadRequest(format!("step {}: {e}", index + 1)))?;
                let (x, y) = gesture_point(step, at, view)
                    .map_err(|e| BrowserError::BadRequest(format!("step {}: {e}", index + 1)))?;
                at = Some((x, y));
                let buttons = i32::from(held.is_some());
                let event = match step.action {
                    MouseAction::Move => json!({
                        "type": "mouseMoved", "x": x, "y": y,
                        "button": held.clone().unwrap_or_else(|| "none".into()),
                        "buttons": buttons, "pointerType": "mouse"
                    }),
                    MouseAction::Down => {
                        held = Some(button.clone());
                        json!({"type": "mousePressed", "x": x, "y": y, "button": button, "buttons": 1, "clickCount": 1, "pointerType": "mouse"})
                    }
                    MouseAction::Up => {
                        held = None;
                        json!({"type": "mouseReleased", "x": x, "y": y, "button": button, "buttons": 0, "clickCount": 1, "pointerType": "mouse"})
                    }
                    MouseAction::Click => {
                        // Down and up are sent as one step so the caller does
                        // not have to remember to release; CEF needs a turn of
                        // the event loop between them or Blink produces no
                        // DOM click at all.
                        session
                            .call("Input.dispatchMouseEvent", json!({"type": "mousePressed", "x": x, "y": y, "button": button, "buttons": 1, "clickCount": 1, "pointerType": "mouse"}))
                            .await
                            .map_err(|e| other(e.to_string()))?;
                        tokio::time::sleep(std::time::Duration::from_millis(16)).await;
                        json!({"type": "mouseReleased", "x": x, "y": y, "button": button, "buttons": 0, "clickCount": 1, "pointerType": "mouse"})
                    }
                    MouseAction::Wheel => json!({
                        "type": "mouseWheel", "x": x, "y": y,
                        "deltaX": step.delta_x.unwrap_or(0.0),
                        "deltaY": step.delta_y.unwrap_or(0.0),
                        "button": "none", "buttons": buttons, "pointerType": "mouse"
                    }),
                };
                // The page's own cursor follows the gesture, so a drag across
                // a canvas can be watched rather than only inferred from what
                // it left behind. Only for a tab someone is looking at: on a
                // background tab it is a round trip per step for nobody.
                if on_screen {
                    automation::track_cursor(
                        &session,
                        tab,
                        x,
                        y,
                        if matches!(step.action, MouseAction::Click | MouseAction::Down) {
                            "click"
                        } else {
                            "move"
                        },
                    )
                    .await;
                }
                session
                    .call("Input.dispatchMouseEvent", event)
                    .await
                    .map_err(|e| other(e.to_string()))?;
                if let Some(pause) = step.delay_ms {
                    tokio::time::sleep(std::time::Duration::from_millis(pause)).await;
                }
            }
            // A button left down would keep the page in a drag for as long as
            // the tab lives, which no caller means to do.
            if let Some(button) = held {
                let (x, y) = at.unwrap_or((0.0, 0.0));
                session
                    .call("Input.dispatchMouseEvent", json!({"type": "mouseReleased", "x": x, "y": y, "button": button, "buttons": 0, "clickCount": 1, "pointerType": "mouse"}))
                    .await
                    .map_err(|e| other(e.to_string()))?;
            }
            let (x, y) = at.unwrap_or((0.0, 0.0));
            Ok(json!({"played": params.steps.len(), "pointer": {"x": x, "y": y}}))
        }, |dialog| Ok(dialog_opened(dialog, "The gesture"))))
        .await
    }

    async fn page_expect(
        &self,
        tab: TabId,
        params: dive_mcp::ExpectParams,
    ) -> Result<Value, BrowserError> {
        if params.checks.is_empty() {
            return Err(BrowserError::BadRequest(
                "give at least one check: [{visible: 'role=button'}]".into(),
            ));
        }
        if params.checks.len() > EXPECT_CHECK_CAP {
            return Err(BrowserError::BadRequest(format!(
                "check at most {EXPECT_CHECK_CAP} things at a time"
            )));
        }
        let timeout = std::time::Duration::from_millis(
            params.timeout_ms.unwrap_or(0).min(dive_mcp::MAX_WAIT_MS),
        );
        let session = self.session_for(tab).await?;
        let deadline = std::time::Instant::now() + timeout;
        let mut results;
        loop {
            results = Vec::with_capacity(params.checks.len());
            for check in &params.checks {
                results.push(run_check(&session, check).await?);
            }
            if results.iter().all(|r| r["passed"] == Value::Bool(true))
                || std::time::Instant::now() >= deadline
            {
                break;
            }
            // Re-check rather than watch for a change: a check may be about
            // anything, and polling is the only thing that answers all of
            // them the same way.
            tokio::time::sleep(std::time::Duration::from_millis(EXPECT_POLL_MS)).await;
        }
        let failed: Vec<&Value> = results
            .iter()
            .filter(|r| r["passed"] != Value::Bool(true))
            .collect();
        if failed.is_empty() {
            return Ok(json!({"ok": true, "checked": results.len()}));
        }
        // An error rather than a quiet `ok: false`: an assertion that did not
        // hold is the whole point of the call, and a caller that skims the
        // answer must not read past it.
        let lines: Vec<String> = failed
            .iter()
            .map(|r| {
                format!(
                    "{} — {}",
                    r["check"].as_str().unwrap_or("?"),
                    r["actual"].as_str().unwrap_or("did not hold")
                )
            })
            .collect();
        Err(BrowserError::BadRequest(format!(
            "{} of {} checks did not hold:\n  {}",
            failed.len(),
            results.len(),
            lines.join("\n  ")
        )))
    }

    async fn page_pdf(
        &self,
        tab: TabId,
        params: dive_mcp::PdfParams,
    ) -> Result<Value, BrowserError> {
        let (width, height) = paper_size(params.paper.as_deref())?;
        let name = pdf_filename(params.filename.as_deref())?;
        let session = self.session_for(tab).await?;
        let answer = session
            .call(
                "Page.printToPDF",
                json!({
                    "landscape": params.landscape.unwrap_or(false),
                    "displayHeaderFooter": params.headers.unwrap_or(false),
                    "printBackground": params.background.unwrap_or(true),
                    "paperWidth": width,
                    "paperHeight": height,
                    // Base64 rather than a stream: a page that prints to more
                    // than this is a book, and the caller gets a path either
                    // way.
                    "transferMode": "ReturnAsBase64",
                }),
            )
            .await
            .map_err(|e| other(e.to_string()))?;
        let encoded = answer["data"]
            .as_str()
            .ok_or_else(|| other("the page produced no PDF"))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|e| other(format!("the PDF came back unreadable: {e}")))?;
        let dir = {
            let state = self.state();
            state.prefs.get(&state).download_dir()
        };
        std::fs::create_dir_all(&dir).map_err(|e| other(format!("{}: {e}", dir.display())))?;
        let path = crate::engine::unique_path(&dir, &name);
        std::fs::write(&path, &bytes).map_err(|e| other(format!("{}: {e}", path.display())))?;
        // Recorded like any other download, so the same tool answers "what
        // file did that produce" however the file came about.
        self.state()
            .downloads
            .record(&crate::engine::DownloadNotice {
                tab: Some(tab),
                url: String::new(),
                path: path.to_string_lossy().into_owned(),
                status: "finished".into(),
            });
        Ok(json!({"path": path.to_string_lossy(), "bytes": bytes.len()}))
    }

    async fn downloads(&self, params: dive_mcp::DownloadsParams) -> Result<Value, BrowserError> {
        let limit = params.limit.unwrap_or(10).clamp(1, 50);
        let registry = &self.state().downloads;
        if let Some(wait) = params.wait_ms {
            // The count of finished downloads at the moment of asking is the
            // marker: anything that finishes after this is new, and a file
            // that was already on disk does not answer "wait for the one I
            // just started".
            let before = registry.finished_count();
            let deadline = std::time::Instant::now()
                + std::time::Duration::from_millis(wait.min(dive_mcp::MAX_WAIT_MS));
            while std::time::Instant::now() < deadline {
                if self.state().downloads.finished_count() > before {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(DOWNLOAD_POLL_MS)).await;
            }
            let after = self.state().downloads.finished_count();
            if after == before {
                return Err(BrowserError::BadRequest(
                    "no download finished in that time; check the click actually saved a file"
                        .into(),
                ));
            }
        }
        let recent = self.state().downloads.recent(limit);
        serde_json::to_value(json!({"downloads": recent})).map_err(other)
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
        let session = self.session_for(tab).await?;
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

#[cfg(test)]
mod tool_session_tests {
    use super::*;

    fn step(action: dive_mcp::MouseAction, x: Option<f64>, y: Option<f64>) -> dive_mcp::MouseStep {
        dive_mcp::MouseStep {
            action,
            x,
            y,
            button: None,
            delta_x: None,
            delta_y: None,
            delay_ms: None,
        }
    }

    const VIEW: locator::Viewport = locator::Viewport {
        width: 800.0,
        height: 600.0,
    };

    #[test]
    fn a_step_with_no_coordinates_happens_where_the_last_one_left_the_pointer() {
        // This is what makes move/down/move/move/up read as one drag rather
        // than as five unrelated events.
        let held = step(dive_mcp::MouseAction::Down, None, None);
        assert_eq!(
            gesture_point(&held, Some((10.0, 20.0)), VIEW),
            Ok((10.0, 20.0))
        );
    }

    #[test]
    fn the_first_step_has_to_say_where_it_is() {
        let held = step(dive_mcp::MouseAction::Down, None, None);
        let problem = gesture_point(&held, None, VIEW).expect_err("no position yet");
        assert!(problem.contains("needs x and y"), "{problem}");
    }

    #[test]
    fn a_point_outside_the_viewport_is_refused_rather_than_silently_lost() {
        // The page never receives an event outside its viewport, so sending
        // one would look exactly like a gesture that did nothing.
        for (x, y) in [(900.0, 10.0), (10.0, 700.0), (-1.0, 10.0), (10.0, -1.0)] {
            let moved = step(dive_mcp::MouseAction::Move, Some(x), Some(y));
            assert!(
                gesture_point(&moved, None, VIEW).is_err(),
                "({x}, {y}) should be refused"
            );
        }
        // The far corner is inside it.
        let corner = step(dive_mcp::MouseAction::Move, Some(800.0), Some(600.0));
        assert_eq!(gesture_point(&corner, None, VIEW), Ok((800.0, 600.0)));
    }

    #[test]
    fn half_a_coordinate_is_a_mistake_rather_than_a_default() {
        // Treating a lone x as "keep the old y" would silently move the
        // pointer somewhere the caller never named.
        let half = step(dive_mcp::MouseAction::Move, Some(10.0), None);
        assert!(gesture_point(&half, Some((1.0, 2.0)), VIEW).is_err());
    }

    #[test]
    fn buttons_are_named_or_refused() {
        assert_eq!(mouse_button(None), Ok("left".into()));
        for named in ["left", "right", "middle"] {
            assert_eq!(mouse_button(Some(named)), Ok(named.to_owned()));
        }
        assert!(mouse_button(Some("sideways")).is_err());
    }

    #[test]
    fn a_pdf_filename_is_a_name_and_never_a_path() {
        // A remote caller choosing where on the disk a tool writes is not a
        // filename, it is a file write, so anything path-shaped is refused.
        for hostile in [
            "../escape.pdf",
            "/etc/passwd",
            "a/b.pdf",
            ".hidden",
            "..\\win.pdf",
        ] {
            assert!(
                pdf_filename(Some(hostile)).is_err(),
                "{hostile} should be refused"
            );
        }
    }

    #[test]
    fn a_pdf_filename_gains_the_extension_it_will_be_opened_by() {
        assert_eq!(pdf_filename(Some("invoice")).unwrap(), "invoice.pdf");
        assert_eq!(pdf_filename(Some("invoice.pdf")).unwrap(), "invoice.pdf");
        assert_eq!(pdf_filename(Some("invoice.PDF")).unwrap(), "invoice.PDF");
        // Nothing given, and nothing but whitespace, both mean "you pick".
        assert_eq!(pdf_filename(None).unwrap(), "page.pdf");
        assert_eq!(pdf_filename(Some("   ")).unwrap(), "page.pdf");
    }

    #[test]
    fn paper_is_named_the_way_paper_is_named() {
        assert_eq!(paper_size(None).unwrap(), (8.27, 11.69));
        assert_eq!(paper_size(Some("Letter")).unwrap(), (8.5, 11.0));
        assert_eq!(paper_size(Some("LEGAL")).unwrap(), (8.5, 14.0));
        let problem = paper_size(Some("foolscap")).expect_err("not a size we know");
        assert!(format!("{problem}").contains("a4"), "{problem}");
    }

    #[test]
    fn a_cookie_with_no_domain_is_scoped_to_the_page_that_asked_for_it() {
        // Neither a domain nor a URL is rejected outright, so leaving the
        // domain out has to mean "this page" rather than "everywhere".
        let cookie = dive_mcp::Cookie {
            name: "sid".into(),
            value: "abc".into(),
            ..dive_mcp::Cookie::default()
        };
        let prepared = cdp_cookie(&cookie, "https://example.com/app");
        assert_eq!(prepared["url"], "https://example.com/app");
        assert!(prepared.get("domain").is_none());
        // Not the page's own path: a session cookie scoped to /app would not
        // be sent from anywhere else on the site.
        assert_eq!(prepared["path"], "/");
    }

    #[test]
    fn a_cookie_that_names_its_domain_keeps_it_and_carries_its_flags() {
        let cookie = dive_mcp::Cookie {
            name: "sid".into(),
            value: "abc".into(),
            domain: Some(".example.com".into()),
            path: Some("/admin".into()),
            expires: Some(1_800_000_000.0),
            http_only: Some(true),
            secure: Some(true),
            same_site: Some("Lax".into()),
        };
        let prepared = cdp_cookie(&cookie, "https://example.com/");
        assert_eq!(prepared["domain"], ".example.com");
        assert!(prepared.get("url").is_none());
        assert_eq!(prepared["path"], "/admin");
        assert_eq!(prepared["expires"], 1_800_000_000.0);
        assert_eq!(prepared["httpOnly"], true);
        assert_eq!(prepared["secure"], true);
        assert_eq!(prepared["sameSite"], "Lax");
    }

    #[test]
    fn flags_left_out_are_left_out_rather_than_sent_as_false() {
        // Sending httpOnly:false for a cookie the caller said nothing about
        // would quietly strip the flag from a cookie being restored.
        let cookie = dive_mcp::Cookie {
            name: "a".into(),
            value: "b".into(),
            ..dive_mcp::Cookie::default()
        };
        let prepared = cdp_cookie(&cookie, "https://example.com/");
        for absent in ["httpOnly", "secure", "sameSite", "expires"] {
            assert!(prepared.get(absent).is_none(), "{absent} should be absent");
        }
    }

    #[test]
    fn waits_retry_only_known_navigation_errors_on_live_sessions() {
        for message in [
            "cdp error -32000: Inspected target navigated or closed",
            "cdp error -32000: Not attached to an active page",
            "cdp error -32000: Execution context was destroyed.",
        ] {
            let error = locator::Failure::Engine(message.into());
            assert!(retry_wait_during_navigation(&error, false));
            assert!(!retry_wait_during_navigation(&error, true));
        }
        for message in [
            "session closed",
            "transport failure: disconnected",
            "script exception",
            "cdp call timed out: Runtime.evaluate",
        ] {
            assert!(!retry_wait_during_navigation(
                &locator::Failure::Engine(message.into()),
                false
            ));
        }
        assert!(!retry_wait_during_navigation(
            &locator::Failure::Invalid {
                locator: "[".into(),
                reason: "invalid selector".into(),
            },
            false
        ));
    }

    struct IdleTransport;
    impl dive_cdp::Transport for IdleTransport {
        fn send(&self, _: &str) -> Result<(), dive_cdp::CdpError> {
            Ok(())
        }
    }

    #[test]
    fn concurrent_tools_protect_the_renderer_until_the_last_operation_ends() {
        let activity = Arc::new(crate::activity::Registry::default());
        let tab = TabId::new();
        let nonce = activity.begin(tab);
        activity.ready(tab, &nonce);
        let prior = activity.ticket(tab).unwrap();
        let one = ToolSession::new(CdpSession::new(IdleTransport), &activity, tab);
        let two = ToolSession::new(CdpSession::new(IdleTransport), &activity, tab);
        assert!(activity.ticket(tab).is_none());
        assert!(!activity.begin_close(tab, &prior));
        drop(one);
        assert!(activity.ticket(tab).is_none());
        drop(two);
        let current = activity.ticket(tab).unwrap();
        assert_ne!(current, prior);
        assert!(activity.begin_close(tab, &current));
    }

    #[tokio::test]
    async fn cancelling_a_wait_releases_its_renderer_protection() {
        let activity = Arc::new(crate::activity::Registry::default());
        let tab = TabId::new();
        let nonce = activity.begin(tab);
        activity.ready(tab, &nonce);
        let session = ToolSession::new(CdpSession::new(IdleTransport), &activity, tab);
        let wait = tokio::spawn(async move {
            let _session = session;
            std::future::pending::<()>().await;
        });
        assert!(activity.ticket(tab).is_none());
        wait.abort();
        assert!(wait.await.unwrap_err().is_cancelled());
        assert!(activity.ticket(tab).is_some());
    }
}
