//! devtools commands.

// Tauri commands receive their arguments by value; that is the IPC contract.
#![allow(clippy::needless_pass_by_value)]

use dive_core::{TabId, WorkspaceId};
use tauri::{AppHandle, State};

use super::{capture_tab, cdp_for, stamped_capture};
use crate::Runtime;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// Emulate `device` on a tab, or clear emulation with `None`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_emulate(
    state: State<'_, AppState>,
    id: TabId,
    device: Option<crate::emulate::Device>,
    reload: bool,
) -> AppResult<()> {
    let session = cdp_for(&state, id)?;
    crate::emulate::apply(&session, crate::emulate::device_calls(device.as_ref())).await?;
    // Remembered so an agent's page_resize can tell whether the user agent
    // moved from what the chrome last applied, and reload only then.
    state.buffers.set_device(id, device);
    // Metrics take effect live; the user agent does not. The chrome asks for
    // a reload only when the UA changed, so rotating or zooming a phone does
    // not throw the page's state away.
    if reload {
        session.call0("Page.reload").await.map_err(AppError::new)?;
    }
    Ok(())
}

/// Override where and when the page thinks it is: geolocation, time zone,
/// locale. Unset fields clear their override.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_environment(
    state: State<'_, AppState>,
    id: TabId,
    environment: crate::emulate::Environment,
) -> AppResult<()> {
    let session = cdp_for(&state, id)?;
    crate::emulate::apply(&session, crate::emulate::environment_calls(&environment)).await
}

/// The device catalog, for the picker and for anything scripting Dive.
#[tauri::command]
#[specta::specta]
pub(crate) fn device_presets() -> Vec<crate::emulate::Preset> {
    crate::emulate::presets()
}

/// Override media features (color scheme, reduced motion, media type).
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_media(
    state: State<'_, AppState>,
    id: TabId,
    media: crate::emulate::MediaOverrides,
) -> AppResult<()> {
    let session = cdp_for(&state, id)?;
    let (method, params) = crate::emulate::media_call(&media);
    session.call(method, params).await.map_err(AppError::new)?;
    state.buffers.set_media(id, media);
    Ok(())
}

/// Mock and rewrite rules of a workspace.
#[tauri::command]
#[specta::specta]
pub(crate) fn rules_list(
    state: State<'_, AppState>,
    workspace: WorkspaceId,
) -> Vec<crate::rules::Rule> {
    state.rules.list(&state, workspace)
}

/// Replace a workspace's rules and re-apply interception on its open tabs.
#[tauri::command]
#[specta::specta]
pub(crate) async fn rules_set(
    state: State<'_, AppState>,
    workspace: WorkspaceId,
    rules: Vec<crate::rules::Rule>,
) -> AppResult<()> {
    state.rules.set(&state, workspace, rules)?;
    reapply_interception(&state, Some(workspace)).await;
    Ok(())
}

#[derive(Default)]
struct ReapplySummary {
    dead: Vec<TabId>,
    failed: Vec<(TabId, String)>,
}

async fn apply_interception_targets(
    targets: Vec<(TabId, Vec<crate::rules::Rule>, dive_cdp::CdpSession)>,
    prefs: &crate::prefs::Prefs,
) -> ReapplySummary {
    let mut summary = ReapplySummary::default();
    for (tab_id, rules, session) in targets {
        if session.is_closed() {
            summary.dead.push(tab_id);
            continue;
        }
        if let Err(error) = crate::rules::apply(&session, &rules, prefs).await {
            summary.failed.push((tab_id, error.to_string()));
        }
    }
    summary
}

/// Reapply shared Fetch interception on all tabs, or those owned by one workspace.
pub(crate) async fn reapply_interception(state: &AppState, workspace: Option<WorkspaceId>) {
    let prefs = state.prefs.get(state);
    let sessions: Vec<(TabId, Option<WorkspaceId>, dive_cdp::CdpSession)> = {
        let host = lock(&state.host);
        let store = lock(&state.store);
        host.as_ref().map_or_else(Vec::new, |host| {
            host.sessions()
                .into_iter()
                .filter_map(|(id, session)| {
                    let owner = store.tab(id).ok()?.workspace_id;
                    (workspace.is_none() || owner == workspace).then_some((id, owner, session))
                })
                .collect()
        })
    };
    // Rule cache misses read the store, so resolve them only after releasing
    // the host/store snapshot locks above.
    let targets = sessions
        .into_iter()
        .map(|(id, owner, session)| {
            let rules = owner.map_or_else(Vec::new, |id| state.rules.list(state, id));
            (id, rules, session)
        })
        .collect();
    let summary = apply_interception_targets(targets, &prefs).await;
    for tab_id in &summary.dead {
        tracing::debug!(%tab_id, "pruning closed interception session");
        state.privacy_pages.drop_tab(*tab_id);
    }
    for (tab_id, error) in &summary.failed {
        tracing::warn!(%tab_id, %error, "could not reapply interception to tab");
    }
    let pruned = lock(&state.host)
        .as_mut()
        .map_or_else(Vec::new, crate::engine::TabHost::prune_closed_sessions);
    for tab_id in pruned {
        tracing::debug!(%tab_id, "pruned closed CDP session after interception reapply");
        state.privacy_pages.drop_tab(tab_id);
    }
}

/// Reapply interception after an existing workspace-rules integration writes rules.
pub(crate) async fn reapply_rules(state: &AppState, workspace: WorkspaceId) -> AppResult<()> {
    reapply_interception(state, Some(workspace)).await;
    Ok(())
}

/// Throttle a tab's network, or clear throttling with `None`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_throttle(
    state: State<'_, AppState>,
    id: TabId,
    profile: Option<crate::emulate::NetworkProfile>,
) -> AppResult<()> {
    let session = cdp_for(&state, id)?;
    let (method, params) = crate::emulate::network_call(profile);
    session.call(method, params).await.map_err(AppError::new)?;
    Ok(())
}

/// Cookies and web storage for a tab.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_storage(
    state: State<'_, AppState>,
    id: TabId,
) -> AppResult<crate::storage::StorageSnapshot> {
    let url = lock(&state.store).tab(id)?.url;
    let session = cdp_for(&state, id)?;
    crate::storage::snapshot(&session, &url).await
}

/// Remove a cookie or a web-storage key from the Storage panel.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_storage_delete(
    state: State<'_, AppState>,
    id: TabId,
    section: String,
    key: String,
    domain: Option<String>,
    path: Option<String>,
) -> AppResult<()> {
    let url = lock(&state.store).tab(id)?.url;
    let session = cdp_for(&state, id)?;
    crate::storage::delete(
        &session,
        &url,
        &section,
        &key,
        domain.as_deref(),
        path.as_deref(),
    )
    .await
}

/// Find in page with the engine's own find. `find_next` steps to the next
/// match (the previous one when `forward` is false) instead of starting the
/// search over; an empty query ends the search and clears its highlights.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_find(
    state: State<'_, AppState>,
    id: TabId,
    query: String,
    forward: bool,
    find_next: bool,
) -> AppResult<crate::find::FindResult> {
    crate::find::find(&state, id, &query, forward, find_next).await
}

/// Web Vitals from buffered performance entries.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_vitals(
    state: State<'_, AppState>,
    id: TabId,
) -> AppResult<crate::vitals::Vitals> {
    let session = cdp_for(&state, id)?;
    crate::vitals::read(&session).await
}

/// Map a script location to its original source through source maps.
#[tauri::command]
#[specta::specta]
pub(crate) async fn resolve_frame(
    state: State<'_, AppState>,
    tab_id: TabId,
    url: String,
    line: u32,
    column: Option<u32>,
) -> AppResult<Option<crate::sourcemaps::Original>> {
    let page_url = lock(&state.store).tab(tab_id)?.url;
    Ok(state
        .sourcemaps
        .resolve(&page_url, &url, line, column.unwrap_or(1))
        .await)
}

/// The captured request as an editable replay draft.
#[tauri::command]
#[specta::specta]
pub(crate) fn request_captured(
    state: State<'_, AppState>,
    tab_id: TabId,
    request_id: String,
) -> AppResult<crate::replay::ReplayRequest> {
    let r = state
        .buffers
        .request(tab_id, &request_id)
        .ok_or_else(|| AppError::new("request no longer in the buffer"))?;
    let captured_host = url::Url::parse(&r.url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_default();
    Ok(crate::replay::ReplayRequest {
        method: r.method,
        url: r.url,
        headers: r.headers,
        body: r.post_data,
        with_cookies: true,
        captured_host,
    })
}

/// What was sent and what came back, for reading rather than editing.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct RequestDetail {
    pub method: String,
    pub url: String,
    pub status: Option<u16>,
    pub mime_type: String,
    pub request_headers: std::collections::BTreeMap<String, String>,
    pub request_body: Option<String>,
    pub response_headers: std::collections::BTreeMap<String, String>,
    /// The body when it was captured (JSON within the budget).
    pub response_body: Option<String>,
    /// Why the body is absent, when it is.
    pub response_body_note: Option<String>,
    /// What workspace rules did to this request, in words.
    pub rewrites: Vec<String>,
}

/// The captured request and response for the Network panel's detail pane.
#[tauri::command]
#[specta::specta]
pub(crate) fn request_detail(
    state: State<'_, AppState>,
    tab_id: TabId,
    request_id: String,
) -> AppResult<RequestDetail> {
    let r = state
        .buffers
        .request(tab_id, &request_id)
        .ok_or_else(|| AppError::new("request no longer in the buffer"))?;
    Ok(RequestDetail {
        method: r.method,
        url: r.url,
        status: r.status,
        mime_type: r.mime_type,
        request_headers: r.headers,
        request_body: r.post_data,
        response_headers: r.response_headers,
        response_body: r.response_body,
        response_body_note: r.response_body_note,
        rewrites: state.buffers.rewrites_for(tab_id, &request_id),
    })
}

/// Replay a (possibly edited) request, optionally with the tab's cookies.
#[tauri::command]
#[specta::specta]
pub(crate) async fn request_replay(
    state: State<'_, AppState>,
    tab_id: TabId,
    request: crate::replay::ReplayRequest,
) -> AppResult<crate::replay::ReplayResponse> {
    let cookie = if crate::replay::cookies_allowed(&request) {
        let session = cdp_for(&state, tab_id)?;
        crate::replay::cookie_header(&session, &request.url).await
    } else {
        None
    };
    crate::replay::send(&request, cookie).await
}

/// `OpenAPI` 3.1 JSON inferred from the tab's captured traffic; also saved
/// under captures and copied to the clipboard.
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_openapi(state: State<'_, AppState>, id: TabId) -> AppResult<OpenapiExport> {
    let page_url = lock(&state.store).tab(id)?.url;
    let requests = state.buffers.requests(id, 1000);
    let spec = crate::openapi::from_requests(&page_url, &requests);
    let text = serde_json::to_string_pretty(&spec).map_err(AppError::new)?;
    let path = stamped_capture(&page_url, "openapi", "json")?;
    std::fs::write(&path, &text)?;
    let copied = arboard::Clipboard::new()
        .and_then(|mut cb| cb.set_text(text))
        .is_ok();
    Ok(OpenapiExport {
        path: path.to_string_lossy().into_owned(),
        copied,
    })
}

/// Where an `OpenAPI` export was written, and whether it also reached the
/// clipboard. The notice used to say "copied" whether or not it had been.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub(crate) struct OpenapiExport {
    /// The saved file.
    pub path: String,
    /// The clipboard took it too.
    pub copied: bool,
}

/// Forget a tab's console output in the host too, so the agent's view of the
/// page and a bug report agree with the cleared panel. `before_navigation`
/// keeps what the page has logged since it last started over.
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_console_clear(state: State<'_, AppState>, id: TabId, before_navigation: bool) {
    state.buffers.clear_console(id, before_navigation);
}

/// Forget a tab's requests in the host too: all of them, or those before
/// `keep_from`, the document request of the page now showing.
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_network_clear(state: State<'_, AppState>, id: TabId, keep_from: Option<String>) {
    state.buffers.clear_network(id, keep_from.as_deref());
}

/// One storage value in full, for copying. The panel lists values cut short
/// (see [`crate::storage::VALUE_SHOWN`]); this is how the rest is reached.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_storage_value(
    state: State<'_, AppState>,
    id: TabId,
    section: String,
    key: String,
    domain: Option<String>,
    path: Option<String>,
) -> AppResult<Option<String>> {
    let url = lock(&state.store).tab(id)?.url;
    let session = cdp_for(&state, id)?;
    crate::storage::value(
        &session,
        &url,
        &section,
        &key,
        domain.as_deref(),
        path.as_deref(),
    )
    .await
}

/// Export the captured requests of a tab as a HAR 1.2 file; returns its path.
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_har(state: State<'_, AppState>, id: TabId) -> AppResult<String> {
    let tab = lock(&state.store).tab(id)?;
    let requests = state.buffers.requests(id, 1000);
    let har = crate::har::from_requests(&tab.url, &tab.title, &requests);
    let path = stamped_capture(&tab.url, "requests", "har")?;
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&har).map_err(AppError::new)?,
    )?;
    Ok(path.to_string_lossy().into_owned())
}

/// Compose a Markdown bug report for a tab (viewport screenshot, console
/// errors, failed requests), copy it to the clipboard and save it; returns
/// the report path.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_bug_report(state: State<'_, AppState>, id: TabId) -> AppResult<String> {
    let shot = capture_tab(&state, id, false).await.ok();
    let tab = lock(&state.store).tab(id)?;
    let console = state.buffers.console_tail(id, 500);
    let requests = state.buffers.requests(id, 1000);
    let text = crate::report::compose(&tab, &console, &requests, shot.as_deref());
    let path = stamped_capture(&tab.url, "bug report", "md")?;
    std::fs::write(&path, &text)?;
    if let Ok(mut cb) = arboard::Clipboard::new() {
        let _ = cb.set_text(text);
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Start recording the person's interactions in a tab.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_record_start(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: TabId,
) -> AppResult<()> {
    let session = cdp_for(&state, id)?;
    crate::recorder::start(app, id, session).await
}

/// Stop recording and return the steps.
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_record_stop(
    state: State<'_, AppState>,
    id: TabId,
) -> Vec<crate::recorder::RecordedStep> {
    let (steps, script_id) = state.buffers.finish_recording(id);
    if let Ok(session) = cdp_for(&state, id) {
        tauri::async_runtime::spawn(crate::recorder::stop(session, script_id));
    }
    steps
}

/// Head metadata for the Meta panel.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_meta(
    state: State<'_, AppState>,
    id: TabId,
) -> AppResult<crate::meta::MetaSnapshot> {
    let session = cdp_for(&state, id)?;
    crate::meta::snapshot(&session).await
}

/// Run axe-core (source supplied by the chrome) and return violations.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_a11y(
    state: State<'_, AppState>,
    id: TabId,
    axe_source: String,
) -> AppResult<crate::a11y::A11yReport> {
    let session = cdp_for(&state, id)?;
    crate::a11y::run(&session, &axe_source).await
}

/// Scroll to the first element matching `selector` and flash it.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tab_a11y_reveal(
    state: State<'_, AppState>,
    id: TabId,
    selector: String,
) -> AppResult<bool> {
    let session = cdp_for(&state, id)?;
    crate::a11y::reveal(&session, &selector).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[derive(Clone)]
    struct AckTransport {
        sent: std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
        session: std::sync::Arc<std::sync::Mutex<Option<dive_cdp::CdpSession>>>,
    }

    impl dive_cdp::Transport for AckTransport {
        fn send(&self, message: &str) -> Result<(), dive_cdp::CdpError> {
            let message: Value = serde_json::from_str(message).expect("outgoing CDP JSON");
            let id = message["id"].as_u64().expect("CDP call id");
            self.sent
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(message);
            self.session
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_ref()
                .expect("session installed")
                .handle_incoming(&serde_json::json!({"id": id, "result": {}}).to_string())?;
            Ok(())
        }
    }

    fn acknowledged_session() -> (
        dive_cdp::CdpSession,
        std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
    ) {
        let sent = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let holder = std::sync::Arc::new(std::sync::Mutex::new(None));
        let session = dive_cdp::CdpSession::new(AckTransport {
            sent: std::sync::Arc::clone(&sent),
            session: std::sync::Arc::clone(&holder),
        });
        *holder
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(session.clone());
        (session, sent)
    }

    #[tokio::test]
    async fn interception_reapply_prunes_a_dead_first_session_and_updates_the_next() {
        let dead_id = TabId::new();
        let live_id = TabId::new();
        let (dead, _) = acknowledged_session();
        dead.close();
        let (live, sent) = acknowledged_session();
        let prefs = crate::prefs::Prefs {
            block_trackers: true,
            ..crate::prefs::Prefs::default()
        };

        let summary = apply_interception_targets(
            vec![(dead_id, Vec::new(), dead), (live_id, Vec::new(), live)],
            &prefs,
        )
        .await;

        assert_eq!(summary.dead, vec![dead_id]);
        assert!(summary.failed.is_empty());
        let sent = sent
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["method"], "Fetch.enable");
    }
}
