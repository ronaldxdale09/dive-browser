//! Dive as an MCP server. Coding agents (Claude Code, Cursor, Codex) connect
//! over streamable HTTP on localhost and get the browser's tabs, page text,
//! screenshots and navigation as tools.
//!
//! The crate is engine-agnostic: the desktop app implements [`Browser`].

mod browser;
mod catalog;
mod error;
mod http;
mod params;
mod server;

pub use browser::{Browser, TabInfo};
pub use catalog::{CatalogEntry, tool_catalog};
pub use error::BrowserError;
pub use http::{Handle, serve};
pub use params::{
    Addressed, AppearanceParams, BodyParams, ClickParams, ComponentParams, DEFAULT_WAIT_MS,
    DialogParams, DragParams, EvaluateParams, FillFormParams, FormField, HistoryParams,
    LOCATOR_GRAMMAR, LocateParams, MAX_LOCATOR_CHARS, MAX_REF_CHARS, MAX_WAIT_MS, NavigateParams,
    OpenParams, PressParams, ResizeParams, RulesParams, ScreenshotParams, ScrollParams,
    SelectParams, TabRef, TailParams, Target, ThrottleParams, TypeParams, UploadParams,
    WaitForParams,
};
pub use server::{Config, DiveServer};
