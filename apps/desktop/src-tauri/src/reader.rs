//! Reader view: the article, without the rest of the page.
//!
//! Chromium's own reader is off in this build -- `ImmersiveReadAnything` is
//! disabled because its service crashes the renderer (see `startup.rs`) -- so
//! Dive finds the article itself, in the page, and swaps the body for a clean
//! one. The original body is kept aside rather than rebuilt, so leaving
//! reader view restores the page exactly.

use dive_cdp::CdpSession;
use dive_core::TabId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;

use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// What happened when reader view was asked for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ReaderResult {
    pub ok: bool,
    /// `no-article` when the page has nothing article-shaped in it, `empty`
    /// when it has no body yet.
    pub reason: Option<String>,
    /// Characters of article text shown.
    pub words: Option<f64>,
    /// The page was already in reader view.
    pub already: bool,
}

fn session_for(state: &AppState, tab_id: TabId) -> AppResult<CdpSession> {
    let host = lock(&state.host);
    host.as_ref()
        .and_then(|host| {
            host.sessions()
                .into_iter()
                .find_map(|(id, session)| (id == tab_id).then_some(session))
        })
        .ok_or_else(|| AppError::new("this tab is not loaded"))
}

async fn run(session: &CdpSession, expression: &str) -> AppResult<Value> {
    let source = crate::pagescript::build("reader.js", &[]);
    let _ = session
        .call("Runtime.evaluate", json!({"expression": source}))
        .await;
    let result = session
        .call(
            "Runtime.evaluate",
            json!({"expression": expression, "returnByValue": true}),
        )
        .await
        .map_err(|error| AppError::new(format!("reader view failed: {error}")))?;
    Ok(result["result"]["value"].clone())
}

/// Put the tab's page into reader view.
pub async fn enter(state: &AppState, tab_id: TabId) -> AppResult<ReaderResult> {
    let session = session_for(state, tab_id)?;
    let value = run(&session, "window.__diveReader()").await?;
    Ok(ReaderResult {
        ok: value["ok"].as_bool().unwrap_or(false),
        reason: value["reason"].as_str().map(str::to_owned),
        words: value["words"].as_f64(),
        already: value["already"].as_bool().unwrap_or(false),
    })
}

/// Put the page back the way it was.
pub async fn leave(state: &AppState, tab_id: TabId) -> AppResult<()> {
    let session = session_for(state, tab_id)?;
    run(&session, "window.__diveReaderRestore()").await?;
    Ok(())
}

/// Whether this tab is in reader view.
pub async fn is_open(state: &AppState, tab_id: TabId) -> AppResult<bool> {
    let session = session_for(state, tab_id)?;
    let value = run(&session, "window.__diveReaderState_()").await?;
    Ok(value["inReader"].as_bool().unwrap_or(false))
}
