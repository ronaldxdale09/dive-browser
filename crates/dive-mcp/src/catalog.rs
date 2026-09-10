//! The tool surface as advertised, listed without a browser behind it.

use async_trait::async_trait;
use dive_core::TabId;

use crate::browser::{Browser, TabInfo};
use crate::error::BrowserError;
use crate::params::{
    AppearanceParams, DialogParams, DragParams, FillFormParams, ResizeParams, SelectParams,
    StorageClearParams, StorageGetParams, StorageSetParams, Target, UploadParams, WaitForParams,
};
use crate::server::DiveServer;

/// One tool as the server advertises it. The single source of the tool
/// surface; the sidecar agent's catalog is checked against it.
#[derive(Debug, Clone, PartialEq)]
pub struct CatalogEntry {
    /// Tool name.
    pub name: String,
    /// What the tool does, as clients see it.
    pub description: String,
    /// JSON schema of the parameters.
    pub input_schema: serde_json::Value,
}

/// Every tool the server advertises, listed without a browser behind it.
pub fn tool_catalog() -> Vec<CatalogEntry> {
    let mut entries: Vec<CatalogEntry> = DiveServer::<NoBrowser>::router()
        .list_all()
        .into_iter()
        .map(|t| CatalogEntry {
            name: t.name.into_owned(),
            description: t
                .description
                .map(std::borrow::Cow::into_owned)
                .unwrap_or_default(),
            input_schema: serde_json::Value::Object((*t.input_schema).clone()),
        })
        .collect();
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    entries
}

/// A browser that answers nothing, so the tool router can be built for its
/// metadata alone.
struct NoBrowser;

#[async_trait]
impl Browser for NoBrowser {
    async fn tabs(&self) -> Result<Vec<TabInfo>, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn open_tab(&self, _url: String) -> Result<TabInfo, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn navigate(&self, _tab: TabId, _url: String) -> Result<(), BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn activate(&self, _tab: TabId) -> Result<(), BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn close(&self, _tab: TabId) -> Result<(), BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_text(&self, _tab: TabId) -> Result<String, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_markdown(&self, _tab: TabId) -> Result<String, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn screenshot(&self, _tab: TabId, _full_page: bool) -> Result<Vec<u8>, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn evaluate(
        &self,
        _tab: TabId,
        _expression: String,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn console_tail(
        &self,
        _tab: TabId,
        _limit: usize,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn requests(
        &self,
        _tab: TabId,
        _limit: usize,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn request_body(
        &self,
        _tab: TabId,
        _request_id: String,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_state(&self, _tab: TabId) -> Result<String, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_inspect(&self, _tab: TabId) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_click(
        &self,
        _tab: TabId,
        _target: Target,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_type(
        &self,
        _tab: TabId,
        _target: Target,
        _text: String,
        _clear: bool,
        _submit: bool,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_press(
        &self,
        _tab: TabId,
        _target: Target,
        _key: String,
        _modifiers: Vec<String>,
    ) -> Result<(), BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_scroll(
        &self,
        _tab: TabId,
        _target: Target,
        _delta_x: f64,
        _delta_y: f64,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn history(
        &self,
        _tab: TabId,
        _action: String,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_hover(
        &self,
        _tab: TabId,
        _target: Target,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_select(
        &self,
        _tab: TabId,
        _params: SelectParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_dialog(
        &self,
        _tab: TabId,
        _params: DialogParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_wait_for(
        &self,
        _tab: TabId,
        _params: WaitForParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_locate(
        &self,
        _tab: TabId,
        _locator: String,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_resize(
        &self,
        _tab: TabId,
        _params: ResizeParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_devices(&self) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_appearance(
        &self,
        _tab: TabId,
        _params: AppearanceParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_throttle(
        &self,
        _tab: TabId,
        _profile: String,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_component(
        &self,
        _tab: TabId,
        _target: Target,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn dev_servers(&self) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn api_spec(&self, _tab: TabId) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_report(&self, _tab: TabId) -> Result<String, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn rules(&self) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn set_rules(&self, _rules: serde_json::Value) -> Result<(), BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_snapshot(&self, _tab: TabId) -> Result<String, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_diff(&self, _tab: TabId) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_fill_form(
        &self,
        _tab: TabId,
        _params: FillFormParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_upload(
        &self,
        _tab: TabId,
        _params: UploadParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_drag(
        &self,
        _tab: TabId,
        _params: DragParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_storage_get(
        &self,
        _tab: TabId,
        _params: StorageGetParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_storage_set(
        &self,
        _tab: TabId,
        _params: StorageSetParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }

    async fn page_storage_clear(
        &self,
        _tab: TabId,
        _params: StorageClearParams,
    ) -> Result<serde_json::Value, BrowserError> {
        Err(BrowserError::Other("no browser behind the catalog".into()))
    }
}
