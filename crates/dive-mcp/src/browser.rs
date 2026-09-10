//! The engine surface the MCP tools need.

use async_trait::async_trait;
use dive_core::TabId;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::error::BrowserError;
use crate::params::{
    AppearanceParams, DialogParams, DragParams, FillFormParams, ResizeParams, SelectParams, Target,
    UploadParams, WaitForParams,
};

/// What a tool caller gets to know about a tab.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TabInfo {
    /// Stable id, pass it back to tab-scoped tools.
    pub id: String,
    /// Current URL.
    pub url: String,
    /// Page title.
    pub title: String,
    /// Whether this tab is the one the user is looking at.
    pub active: bool,
}

/// The engine surface the MCP tools need.
#[async_trait]
pub trait Browser: Send + Sync + 'static {
    /// All tabs in the active workspace.
    async fn tabs(&self) -> Result<Vec<TabInfo>, BrowserError>;
    /// Open a tab in the active workspace and focus it.
    async fn open_tab(&self, url: String) -> Result<TabInfo, BrowserError>;
    /// Navigate an existing tab.
    async fn navigate(&self, tab: TabId, url: String) -> Result<(), BrowserError>;
    /// Bring a tab to the front, so the person sees what the agent is doing.
    async fn activate(&self, tab: TabId) -> Result<(), BrowserError>;
    /// Close a tab.
    async fn close(&self, tab: TabId) -> Result<(), BrowserError>;
    /// Visible text of the page (`document.body.innerText`).
    async fn page_text(&self, tab: TabId) -> Result<String, BrowserError>;
    /// The page as Markdown, keeping headings, link targets, lists and tables.
    async fn page_markdown(&self, tab: TabId) -> Result<String, BrowserError>;
    /// PNG screenshot of the viewport or the full document.
    async fn screenshot(&self, tab: TabId, full_page: bool) -> Result<Vec<u8>, BrowserError>;
    /// Evaluate JavaScript and return the JSON result.
    async fn evaluate(
        &self,
        tab: TabId,
        expression: String,
    ) -> Result<serde_json::Value, BrowserError>;
    /// Recent console output, oldest first, as JSON rows.
    async fn console_tail(
        &self,
        tab: TabId,
        limit: usize,
    ) -> Result<serde_json::Value, BrowserError>;
    /// Recent requests, oldest first, as JSON rows (no headers or bodies).
    async fn requests(&self, tab: TabId, limit: usize) -> Result<serde_json::Value, BrowserError>;
    /// The captured response body of one request, truncated to a few KB.
    async fn request_body(
        &self,
        tab: TabId,
        request_id: String,
    ) -> Result<serde_json::Value, BrowserError>;
    /// Accessibility tree as indented text with `[ref=eN]` markers on interactive nodes.
    async fn page_state(&self, tab: TabId) -> Result<String, BrowserError>;
    /// Everything about a page in one call: state, elements, diagnostics and
    /// the action timeline. Screenshots stay separate so this cheap read does
    /// not inject a large base64 payload into every agent turn.
    async fn page_inspect(&self, tab: TabId) -> Result<serde_json::Value, BrowserError>;
    /// Click a target.
    async fn page_click(
        &self,
        tab: TabId,
        target: Target,
    ) -> Result<serde_json::Value, BrowserError>;
    /// Insert text into a field, optionally replacing it and pressing Enter.
    async fn page_type(
        &self,
        tab: TabId,
        target: Target,
        text: String,
        clear: bool,
        submit: bool,
    ) -> Result<serde_json::Value, BrowserError>;
    /// Press one key, optionally focusing a target first.
    async fn page_press(
        &self,
        tab: TabId,
        target: Target,
        key: String,
        modifiers: Vec<String>,
    ) -> Result<(), BrowserError>;
    /// Scroll the page, or a container named by `target`.
    async fn page_scroll(
        &self,
        tab: TabId,
        target: Target,
        delta_x: f64,
        delta_y: f64,
    ) -> Result<serde_json::Value, BrowserError>;
    /// Go back, go forward or reload; `action` is one of those words.
    async fn history(&self, tab: TabId, action: String) -> Result<serde_json::Value, BrowserError>;
    /// Move the pointer over an element without clicking.
    async fn page_hover(
        &self,
        tab: TabId,
        target: Target,
    ) -> Result<serde_json::Value, BrowserError>;
    /// Choose an option in a `<select>` by value or visible label.
    async fn page_select(
        &self,
        tab: TabId,
        params: SelectParams,
    ) -> Result<serde_json::Value, BrowserError>;
    /// Answer the dialog (`alert`, `confirm`, `prompt`, `beforeunload`) the
    /// page has open, which blocks the page's script until it is answered.
    async fn page_dialog(
        &self,
        tab: TabId,
        params: DialogParams,
    ) -> Result<serde_json::Value, BrowserError>;
    /// Wait until every supplied condition holds, or time out.
    async fn page_wait_for(
        &self,
        tab: TabId,
        params: WaitForParams,
    ) -> Result<serde_json::Value, BrowserError>;
    /// Describe the elements a locator matches, for disambiguation.
    async fn page_locate(
        &self,
        tab: TabId,
        locator: String,
    ) -> Result<serde_json::Value, BrowserError>;
    /// Resize the viewport to a preset or exact size, or clear emulation.
    async fn page_resize(
        &self,
        tab: TabId,
        params: ResizeParams,
    ) -> Result<serde_json::Value, BrowserError>;
    /// The device presets `page_resize` accepts.
    async fn page_devices(&self) -> Result<serde_json::Value, BrowserError>;
    /// Emulate colour scheme, reduced motion, media type and display mode.
    async fn page_appearance(
        &self,
        tab: TabId,
        params: AppearanceParams,
    ) -> Result<serde_json::Value, BrowserError>;
    /// Throttle or un-throttle a tab's network.
    async fn page_throttle(
        &self,
        tab: TabId,
        profile: String,
    ) -> Result<serde_json::Value, BrowserError>;
    /// The component that rendered an element, and the source file it is in.
    async fn page_component(
        &self,
        tab: TabId,
        target: Target,
    ) -> Result<serde_json::Value, BrowserError>;
    /// Dev servers listening on this machine.
    async fn dev_servers(&self) -> Result<serde_json::Value, BrowserError>;
    /// `OpenAPI` 3.1 JSON inferred from the tab's traffic.
    async fn api_spec(&self, tab: TabId) -> Result<serde_json::Value, BrowserError>;
    /// Markdown bug report: page, console errors and failed requests.
    async fn page_report(&self, tab: TabId) -> Result<String, BrowserError>;
    /// Mock/rewrite rules of the active workspace, as JSON.
    async fn rules(&self) -> Result<serde_json::Value, BrowserError>;
    /// Replace the active workspace's rules with `rules` (JSON array).
    async fn set_rules(&self, rules: serde_json::Value) -> Result<(), BrowserError>;
    /// Remember the page's current state for a later diff.
    async fn page_snapshot(&self, tab: TabId) -> Result<String, BrowserError>;
    /// Snapshot now and compare with the previous snapshot.
    async fn page_diff(&self, tab: TabId) -> Result<serde_json::Value, BrowserError>;
    /// Fill several fields in one call, in order, stopping at the first that
    /// fails. One round trip for a whole form instead of one per field.
    async fn page_fill_form(
        &self,
        tab: TabId,
        params: FillFormParams,
    ) -> Result<serde_json::Value, BrowserError>;
    /// Attach files to a file input, as choosing them in the picker would.
    async fn page_upload(
        &self,
        tab: TabId,
        params: UploadParams,
    ) -> Result<serde_json::Value, BrowserError>;
    /// Drag one element onto another with the pointer held down.
    async fn page_drag(
        &self,
        tab: TabId,
        params: DragParams,
    ) -> Result<serde_json::Value, BrowserError>;
}
