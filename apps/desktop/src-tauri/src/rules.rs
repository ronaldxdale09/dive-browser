//! Mock and rewrite rules: per-workspace URL patterns that block a request,
//! answer it with a canned response, or add a request header. Applied
//! through the `DevTools` `Fetch` domain on every tab of the workspace.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use dive_cdp::CdpSession;
use dive_core::{TabId, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::Runtime;
use crate::error::{AppError, AppResult};
use crate::prefs::Prefs;
use crate::privacy::{DivePrivacy, PrivacyCategory, PrivacyDecision, PrivacyEvent, RequestContext};
use crate::state::AppState;

/// One rule; the first enabled match wins.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Rule {
    pub id: String,
    /// URL glob; `*` matches any run of characters. Matched case-insensitively.
    pub pattern: String,
    pub enabled: bool,
    pub action: RuleAction,
}

/// What happens to a matching request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RuleAction {
    /// Fail the request as blocked by the client.
    Block,
    /// Answer without hitting the network.
    Mock {
        status: u16,
        content_type: String,
        body: String,
    },
    /// Add or replace one request header.
    Header { name: String, value: String },
}

/// Request fields used by the pure interception planner.
#[derive(Debug, Clone, Copy)]
pub struct PausedRequest<'a> {
    pub url: &'a str,
    pub document_url: &'a str,
    pub resource_type: &'a str,
    pub method: &'a str,
}

/// The document URL that belongs to the current top frame, advanced from the
/// same ordered CDP stream as paused requests. The database URL is only a
/// seed: address-change persistence is deliberately asynchronous and can lag
/// the first subresources of a navigation.
struct TopFrameContext {
    frame_id: Option<String>,
    document_url: String,
}

impl TopFrameContext {
    fn new(document_url: &str) -> Self {
        Self {
            frame_id: None,
            document_url: document_url.to_owned(),
        }
    }

    fn document_url(&self) -> &str {
        &self.document_url
    }

    fn observe(&mut self, event: &dive_cdp::CdpEvent) {
        let params = &event.params;
        match event.method.as_str() {
            "Page.frameNavigated" => {
                let frame = &params["frame"];
                if frame["parentId"].as_str().is_none()
                    && let Some(frame_id) = frame["id"].as_str()
                {
                    self.frame_id = Some(frame_id.to_owned());
                    frame["url"]
                        .as_str()
                        .unwrap_or_default()
                        .clone_into(&mut self.document_url);
                }
            }
            "Page.frameStartedLoading" => {
                if let Some(frame_id) = params["frameId"].as_str() {
                    let is_top = if let Some(top) = self.frame_id.as_deref() {
                        top == frame_id
                    } else {
                        self.frame_id = Some(frame_id.to_owned());
                        true
                    };
                    // An unknown destination must fail open instead of using
                    // the page the frame is leaving.
                    if is_top {
                        self.document_url.clear();
                    }
                }
            }
            "Network.requestWillBeSent" if params["type"].as_str() == Some("Document") => {
                self.note_document_request(
                    params["frameId"].as_str(),
                    params["request"]["url"].as_str(),
                );
            }
            "Fetch.requestPaused" if params["resourceType"].as_str() == Some("Document") => {
                self.note_document_request(
                    params["frameId"].as_str(),
                    params["request"]["url"].as_str(),
                );
            }
            _ => {}
        }
    }

    fn note_document_request(&mut self, frame_id: Option<&str>, url: Option<&str>) {
        let Some(frame_id) = frame_id else {
            self.document_url.clear();
            return;
        };
        let is_top = if let Some(top) = self.frame_id.as_deref() {
            top == frame_id
        } else {
            self.frame_id = Some(frame_id.to_owned());
            true
        };
        if is_top {
            url.unwrap_or_default().clone_into(&mut self.document_url);
        }
    }
}

/// The single terminal action chosen for one paused request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InterceptAction {
    Continue,
    Block,
    Mock {
        status: u16,
        content_type: String,
        body: String,
    },
    Header {
        name: String,
        value: String,
    },
    PrivacyBlock {
        category: PrivacyCategory,
    },
}

/// Largest mock body kept, in characters.
const MAX_BODY: usize = 256 * 1024;
const MAX_RULES: usize = 200;
const MAX_PATTERN: usize = 2 * 1024;
const MAX_HEADER_VALUE: usize = 8 * 1024;

/// Rules per workspace, loaded from settings on first use.
///
/// Each workspace's list is held behind an `Arc` so the request-pause loop
/// can take a snapshot per event without deep-cloning every rule body.
#[derive(Default)]
pub struct Registry {
    by_workspace: Mutex<HashMap<WorkspaceId, Arc<Vec<Rule>>>>,
}

fn setting_key(workspace: WorkspaceId) -> String {
    format!("rules:{workspace}")
}

impl Registry {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<WorkspaceId, Arc<Vec<Rule>>>> {
        self.by_workspace
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Rules for `workspace`, reading the store the first time.
    pub fn list(&self, state: &AppState, workspace: WorkspaceId) -> Vec<Rule> {
        self.snapshot(state, workspace).as_ref().clone()
    }

    /// A shared snapshot of the rules for `workspace`, reading the store the
    /// first time. Cheap to take per paused request; a later [`Self::set`]
    /// replaces the `Arc` rather than mutating it.
    pub fn snapshot(&self, state: &AppState, workspace: WorkspaceId) -> Arc<Vec<Rule>> {
        if let Some(rules) = self.map().get(&workspace) {
            return Arc::clone(rules);
        }
        let stored: Vec<Rule> = crate::state::lock(&state.store)
            .setting(&setting_key(workspace))
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();
        let stored = stored
            .into_iter()
            .take(MAX_RULES)
            .filter_map(|rule| validate(rule).ok())
            .collect();
        Arc::clone(
            self.map()
                .entry(workspace)
                .or_insert_with(|| Arc::new(stored)),
        )
    }

    /// Replace the rules for `workspace` and persist them.
    pub fn set(&self, state: &AppState, workspace: WorkspaceId, rules: Vec<Rule>) -> AppResult<()> {
        crate::state::lock(&state.store).workspace(workspace)?;
        if rules.len() > MAX_RULES {
            return Err(AppError::new(format!(
                "at most {MAX_RULES} rules are allowed"
            )));
        }
        let rules: Vec<Rule> = rules.into_iter().map(validate).collect::<AppResult<_>>()?;
        let json = serde_json::to_string(&rules).map_err(AppError::new)?;
        crate::state::lock(&state.store).set_setting(&setting_key(workspace), &json)?;
        self.map().insert(workspace, Arc::new(rules));
        Ok(())
    }
}

fn validate(mut rule: Rule) -> AppResult<Rule> {
    rule.id = rule.id.trim().chars().take(128).collect();
    rule.pattern = rule.pattern.trim().to_owned();
    if rule.pattern.is_empty() || rule.pattern.chars().count() > MAX_PATTERN {
        return Err(AppError::new(format!(
            "rule pattern must be 1-{MAX_PATTERN} characters"
        )));
    }
    if let RuleAction::Mock { body, .. } = &mut rule.action
        && body.chars().count() > MAX_BODY
    {
        *body = body.chars().take(MAX_BODY).collect();
    }
    match &mut rule.action {
        RuleAction::Mock {
            status,
            content_type,
            ..
        } => {
            if !(100..=599).contains(status) {
                return Err(AppError::new("mock status must be between 100 and 599"));
            }
            *content_type = content_type.trim().chars().take(256).collect();
            if content_type.is_empty() || content_type.contains(['\r', '\n']) {
                return Err(AppError::new("mock content type is invalid"));
            }
        }
        RuleAction::Header { name, value } => {
            *name = name.trim().to_owned();
            if name.is_empty()
                || name.len() > 256
                || !name.bytes().all(|b| {
                    b.is_ascii_alphanumeric()
                        || matches!(
                            b,
                            b'!' | b'#'
                                | b'$'
                                | b'%'
                                | b'&'
                                | b'\''
                                | b'*'
                                | b'+'
                                | b'-'
                                | b'.'
                                | b'^'
                                | b'_'
                                | b'`'
                                | b'|'
                                | b'~'
                        )
                })
            {
                return Err(AppError::new("header name is invalid"));
            }
            if value.contains(['\r', '\n']) || value.chars().count() > MAX_HEADER_VALUE {
                return Err(AppError::new("header value is invalid or too long"));
            }
        }
        RuleAction::Block => {}
    }
    Ok(rule)
}

/// Glob match with `*` wildcards, case-insensitive.
///
/// A two-pointer match that backtracks to the last `*`, so `*.png` matches
/// `https://cdn.png.host/logo.png`: the first `.png` it finds is not the one
/// that has to end the string.
pub fn matches(pattern: &str, url: &str) -> bool {
    let p = pattern.to_ascii_lowercase();
    let u = url.to_ascii_lowercase();
    let (p, u) = (p.as_bytes(), u.as_bytes());
    let (mut pi, mut ui) = (0usize, 0usize);
    let mut star: Option<(usize, usize)> = None;
    while ui < u.len() {
        if pi < p.len() && p[pi] == b'*' {
            star = Some((pi, ui));
            pi += 1;
        } else if pi < p.len() && p[pi] == u[ui] {
            pi += 1;
            ui += 1;
        } else if let Some((star_p, star_u)) = star {
            pi = star_p + 1;
            ui = star_u + 1;
            star = Some((star_p, star_u + 1));
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

/// First enabled rule matching `url`.
pub fn decide<'a>(rules: &'a [Rule], url: &str) -> Option<&'a Rule> {
    rules.iter().find(|r| r.enabled && matches(&r.pattern, url))
}

/// Whether this tab needs the shared `Fetch.requestPaused` pipeline.
pub fn interception_required(rules: &[Rule], prefs: &Prefs) -> bool {
    rules.iter().any(|rule| rule.enabled) || prefs.block_trackers
}

/// Choose one action, giving the first workspace rule priority over `DivePrivacy`.
pub fn decide_paused_request(
    rules: &[Rule],
    privacy: &DivePrivacy,
    prefs: &Prefs,
    request: &PausedRequest<'_>,
) -> InterceptAction {
    if let Some(rule) = decide(rules, request.url) {
        return match &rule.action {
            RuleAction::Block => InterceptAction::Block,
            RuleAction::Mock {
                status,
                content_type,
                body,
            } => InterceptAction::Mock {
                status: *status,
                content_type: content_type.clone(),
                body: body.clone(),
            },
            RuleAction::Header { name, value } => InterceptAction::Header {
                name: name.clone(),
                value: value.clone(),
            },
        };
    }
    if !prefs.block_trackers || !prefs.privacy_enabled_for(request.document_url) {
        return InterceptAction::Continue;
    }
    match privacy.decide(&RequestContext {
        url: request.url,
        document_url: request.document_url,
        resource_type: request.resource_type,
        method: request.method,
    }) {
        PrivacyDecision::Allow => InterceptAction::Continue,
        PrivacyDecision::Block(category) => InterceptAction::PrivacyBlock { category },
    }
}

/// Resource filters accepted by the pinned Chromium Fetch backend, excluding
/// `Media`. `Network.ResourceType` has additional values which Fetch rejects,
/// aborting the entire enable before any patterns are installed. See Chromium
/// 52a94675, `content/browser/devtools/protocol/network_handler.cc`,
/// `NetworkHandler::AddInterceptedResourceType` (not the Network domain schema).
/// Media is left off this pause pipeline on purpose: pausing every streaming
/// byte range stalled googlevideo playback, and neither privacy nor a
/// workspace rule is worth a stuck video.
const NON_MEDIA_RESOURCE_TYPES: &[&str] = &[
    "Document",
    "Stylesheet",
    "Image",
    "Font",
    "Script",
    "XHR",
    "Fetch",
    "CSPViolationReport",
    "Ping",
    "Other",
];

/// Privacy always allows documents, so do not pause navigation unless an
/// enabled workspace rule might block, mock or rewrite it. Document context
/// still advances through Network/Page events before early subresources.
/// A bare `"*"` would also include `Media` and stall streaming playback.
fn interception_patterns(rules: &[Rule]) -> serde_json::Value {
    let documents = rules.iter().any(|rule| rule.enabled);
    json!(
        NON_MEDIA_RESOURCE_TYPES
            .iter()
            .filter(|resource_type| documents || **resource_type != "Document")
            .map(|t| json!({"urlPattern": "*", "resourceType": t}))
            .collect::<Vec<_>>()
    )
}

/// Enable shared interception when workspace rules or `DivePrivacy` need it.
pub async fn apply(session: &CdpSession, rules: &[Rule], prefs: &Prefs) -> AppResult<()> {
    let result = if interception_required(rules, prefs) {
        session
            .call(
                "Fetch.enable",
                json!({"patterns": interception_patterns(rules)}),
            )
            .await
    } else {
        session.call0("Fetch.disable").await
    };
    result.map(|_| ()).map_err(AppError::new)
}

/// Release every currently paused request and restore the one Fetch owner
/// from authoritative rules. Each step is attempted once; recovery never
/// recurses into itself.
async fn reset_interception(session: &CdpSession, rules: &[Rule], prefs: &Prefs) {
    if let Err(error) = session.call0("Fetch.disable").await {
        tracing::debug!("Fetch.disable recovery failed: {error}");
    }
    if interception_required(rules, prefs)
        && let Err(error) = apply(session, rules, prefs).await
    {
        tracing::debug!("Fetch recovery re-enable failed: {error}");
    }
}

async fn request_id_or_reset(
    session: &CdpSession,
    tab_id: TabId,
    params: &Value,
    rules: &[Rule],
    prefs: &Prefs,
) -> Option<String> {
    if let Some(request_id) = params["requestId"].as_str() {
        return Some(request_id.to_owned());
    }
    tracing::warn!(%tab_id, "paused request had no request id; resetting interception");
    reset_interception(session, rules, prefs).await;
    None
}

/// Execute the selected terminal action. Any action that modifies or refuses
/// a request gets exactly one plain-continue fallback when Chromium rejects
/// it. A failed plain continue is not retried, which keeps failure bounded.
async fn execute_action(
    session: &CdpSession,
    request_id: &str,
    request_headers: &Value,
    action: &InterceptAction,
) -> Option<PrivacyCategory> {
    let privacy_category = match action {
        InterceptAction::PrivacyBlock { category } => Some(*category),
        _ => None,
    };
    let (method, params) = match action {
        InterceptAction::Block | InterceptAction::PrivacyBlock { .. } => (
            "Fetch.failRequest",
            json!({"requestId": request_id, "errorReason": "BlockedByClient"}),
        ),
        InterceptAction::Mock {
            status,
            content_type,
            body,
        } => (
            "Fetch.fulfillRequest",
            json!({
                "requestId": request_id,
                "responseCode": status,
                "responseHeaders": [
                    {"name": "Content-Type", "value": content_type},
                    {"name": "Access-Control-Allow-Origin", "value": "*"},
                    {"name": "X-Dive-Mock", "value": "1"}
                ],
                "body": base64::engine::general_purpose::STANDARD.encode(body),
            }),
        ),
        InterceptAction::Header { name, value } => {
            let mut headers: Vec<Value> = request_headers
                .as_object()
                .map(|headers| {
                    headers
                        .iter()
                        .filter(|(header, _)| !header.eq_ignore_ascii_case(name))
                        .map(|(header, value)| json!({"name": header, "value": value}))
                        .collect()
                })
                .unwrap_or_default();
            headers.push(json!({"name": name, "value": value}));
            (
                "Fetch.continueRequest",
                json!({"requestId": request_id, "headers": headers}),
            )
        }
        InterceptAction::Continue => ("Fetch.continueRequest", json!({"requestId": request_id})),
    };
    match session.call(method, params).await {
        Ok(_) => privacy_category,
        Err(error) => {
            tracing::debug!(%method, "intercept action failed: {error}");
            if !matches!(action, InterceptAction::Continue)
                && let Err(fallback) = session
                    .call("Fetch.continueRequest", json!({"requestId": request_id}))
                    .await
            {
                tracing::debug!("plain continue recovery failed: {fallback}");
            }
            None
        }
    }
}

/// Answer `Fetch.requestPaused` events for `tab` according to the
/// workspace's rules; also enables interception if rules already exist.
#[allow(clippy::too_many_lines)] // one event loop owns the Fetch request lifecycle
pub fn attach(
    app: AppHandle<Runtime>,
    tab_id: TabId,
    workspace: Option<WorkspaceId>,
    session: CdpSession,
) -> crate::cdp_feed::Ready {
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let mut events = session.subscribe();
        let (initial_rules, initial_prefs, initial_document_url) = {
            let state = app.state::<AppState>();
            let rules = workspace.map_or_else(
                || Arc::new(Vec::new()),
                |id| state.rules.snapshot(&state, id),
            );
            let prefs = state.prefs.snapshot(&state);
            let document_url = crate::state::lock(&state.store)
                .tab(tab_id)
                .map(|tab| tab.url)
                .unwrap_or_default();
            (rules, prefs, document_url)
        };
        if let Err(e) = apply(&session, &initial_rules, &initial_prefs).await {
            tracing::warn!(%tab_id, "fetch interception failed: {e}");
        }
        let mut top_frame = TopFrameContext::new(&initial_document_url);
        let _ = ready_tx.send(());
        loop {
            let event = match events.recv().await {
                Ok(event) => event,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    // Lost `requestPaused` events otherwise remain paused
                    // forever. Disabling Fetch releases them, then restores the
                    // current rules for subsequent requests.
                    tracing::warn!(%tab_id, n, "rule listener lagged; resetting interception");
                    let (rules, prefs) = {
                        let state = app.state::<AppState>();
                        (
                            workspace.map_or_else(
                                || Arc::new(Vec::new()),
                                |id| state.rules.snapshot(&state, id),
                            ),
                            state.prefs.snapshot(&state),
                        )
                    };
                    reset_interception(&session, &rules, &prefs).await;
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            top_frame.observe(&event);
            if event.method != "Fetch.requestPaused" {
                continue;
            }
            let p = &event.params;
            let (rules, prefs) = {
                let state = app.state::<AppState>();
                (
                    workspace.map_or_else(
                        || Arc::new(Vec::new()),
                        |id| state.rules.snapshot(&state, id),
                    ),
                    state.prefs.snapshot(&state),
                )
            };
            let Some(request_id) = request_id_or_reset(&session, tab_id, p, &rules, &prefs).await
            else {
                continue;
            };
            let url = p["request"]["url"].as_str().unwrap_or_default();
            let action = {
                let state = app.state::<AppState>();
                decide_paused_request(
                    &rules,
                    &state.privacy,
                    &prefs,
                    &PausedRequest {
                        url,
                        document_url: top_frame.document_url(),
                        resource_type: p["resourceType"].as_str().unwrap_or_default(),
                        method: p["request"]["method"].as_str().unwrap_or_default(),
                    },
                )
            };
            if let Some(category) =
                execute_action(&session, &request_id, &p["request"]["headers"], &action).await
                && let Err(e) = (PrivacyEvent::Blocked { tab_id, category }).emit(&app)
            {
                tracing::warn!(%tab_id, "privacy event emit failed: {e}");
            }
        }
    });
    ready_rx
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prefs::Prefs;
    use crate::privacy::{DivePrivacy, PrivacyCategory};
    use dive_cdp::{CdpError, Transport};
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex as StdMutex};

    fn rule(pattern: &str, action: RuleAction) -> Rule {
        Rule {
            id: pattern.into(),
            pattern: pattern.into(),
            enabled: true,
            action,
        }
    }

    fn privacy() -> DivePrivacy {
        DivePrivacy::from_text("||ads.doubleclick.net^", "||metrics.test^", "")
    }

    fn enabled_prefs() -> Prefs {
        Prefs {
            block_trackers: true,
            ..Prefs::default()
        }
    }

    fn paused_ad<'a>() -> PausedRequest<'a> {
        PausedRequest {
            url: "https://ads.doubleclick.net/pagead/id",
            document_url: "https://news.test/",
            resource_type: "Script",
            method: "GET",
        }
    }

    #[test]
    fn fetch_is_enabled_for_rules_or_diveprivacy() {
        assert!(!interception_required(&[], &Prefs::default()));
        assert!(!interception_required(
            &[],
            &Prefs {
                blocked_patterns: vec!["example.test".into()],
                ..Prefs::default()
            }
        ));
        assert!(interception_required(
            &[rule("*", RuleAction::Block)],
            &Prefs::default()
        ));
        assert!(interception_required(&[], &enabled_prefs()));
    }

    #[test]
    fn workspace_rule_precedes_privacy() {
        let rules = vec![rule(
            "*://ads.doubleclick.net/*",
            RuleAction::Mock {
                status: 204,
                content_type: "text/plain".into(),
                body: String::new(),
            },
        )];
        assert!(matches!(
            decide_paused_request(&rules, &privacy(), &enabled_prefs(), &paused_ad()),
            InterceptAction::Mock { .. }
        ));
    }

    #[test]
    fn diveprivacy_runs_only_without_a_workspace_match() {
        assert_eq!(
            decide_paused_request(&[], &privacy(), &enabled_prefs(), &paused_ad()),
            InterceptAction::PrivacyBlock {
                category: PrivacyCategory::Ads
            }
        );
        let mut prefs = enabled_prefs();
        prefs.privacy_exceptions = vec!["news.test".into()];
        assert_eq!(
            decide_paused_request(&[], &privacy(), &prefs, &paused_ad()),
            InterceptAction::Continue
        );
    }

    #[test]
    fn globs_match_like_devtools() {
        assert!(matches("https://api.dev/*", "https://api.dev/users"));
        assert!(matches("*/users/*", "https://API.dev/users/1"));
        assert!(matches("*.png", "https://a.dev/x.PNG"));
        assert!(!matches("*.png", "https://a.dev/x.png?x=1"));
        // Backtracking: the first `.png` is not the one that ends the URL.
        assert!(matches("*.png", "https://cdn.png.host/logo.png"));
        assert!(matches("https://*/a/*/c", "https://h.dev/a/x/a/y/c"));
        assert!(!matches("https://*/a/*/c", "https://h.dev/a/x/a/y/d"));
        assert!(matches("*", ""));
        assert!(matches("**", "https://a.dev/"));
        assert!(!matches("", "https://a.dev/"));
        assert!(!matches("https://a.dev/*/x", "https://a.dev/x"));
        assert!(matches("https://a.dev/", "https://a.dev/"));
        assert!(!matches("https://a.dev/", "https://a.dev/x"));
        assert!(!matches(
            "https://api.dev/*",
            "https://other.dev/https://api.dev/"
        ));
    }

    #[test]
    fn first_enabled_match_wins() {
        let mut off = rule("*", RuleAction::Block);
        off.enabled = false;
        let rules = vec![
            off,
            rule(
                "*/api/*",
                RuleAction::Header {
                    name: "X-Test".into(),
                    value: "1".into(),
                },
            ),
            rule("*", RuleAction::Block),
        ];
        assert!(matches!(
            decide(&rules, "https://a.dev/api/x").map(|r| &r.action),
            Some(RuleAction::Header { .. })
        ));
        assert!(matches!(
            decide(&rules, "https://a.dev/img.png").map(|r| &r.action),
            Some(RuleAction::Block)
        ));
    }

    #[test]
    fn mock_bodies_are_capped() {
        let big = "x".repeat(MAX_BODY + 10);
        let r = validate(rule(
            "*",
            RuleAction::Mock {
                status: 200,
                content_type: "text/plain".into(),
                body: big,
            },
        ))
        .unwrap();
        assert!(matches!(r.action, RuleAction::Mock { ref body, .. } if body.len() == MAX_BODY));
    }

    #[test]
    fn rejects_invalid_rules() {
        assert!(validate(rule("", RuleAction::Block)).is_err());
        assert!(
            validate(rule(
                "*",
                RuleAction::Mock {
                    status: 999,
                    content_type: "text/plain".into(),
                    body: String::new(),
                },
            ))
            .is_err()
        );
        assert!(
            validate(rule(
                "*",
                RuleAction::Header {
                    name: "Bad Header".into(),
                    value: "x".into(),
                },
            ))
            .is_err()
        );
    }

    fn event(method: &str, params: Value) -> dive_cdp::CdpEvent {
        dive_cdp::CdpEvent {
            method: method.into(),
            params,
        }
    }

    #[test]
    fn top_frame_navigation_context_changes_before_early_subresources() {
        let mut context = TopFrameContext::new("https://news.test/old");
        context.observe(&event(
            "Page.frameNavigated",
            json!({"frame": {"id": "main", "url": "https://news.test/old"}}),
        ));
        context.observe(&event(
            "Network.requestWillBeSent",
            json!({
                "frameId": "main",
                "type": "Document",
                "request": {"url": "https://excepted.test/landing"}
            }),
        ));

        let prefs = Prefs {
            block_trackers: true,
            privacy_exceptions: vec!["excepted.test".into()],
            ..Prefs::default()
        };
        let early = PausedRequest {
            url: "https://ads.doubleclick.net/early.js",
            document_url: context.document_url(),
            resource_type: "Script",
            method: "GET",
        };
        assert_eq!(
            decide_paused_request(&[], &privacy(), &prefs, &early),
            InterceptAction::Continue,
            "the destination exception must win before the stored tab URL catches up",
        );

        context.observe(&event(
            "Network.requestWillBeSent",
            json!({
                "frameId": "main",
                "type": "Document",
                "request": {"url": "https://protected.test/redirected"},
                "redirectResponse": {"status": 302}
            }),
        ));
        let after_redirect = PausedRequest {
            url: "https://ads.doubleclick.net/early.js",
            document_url: context.document_url(),
            resource_type: "Script",
            method: "GET",
        };
        assert_eq!(
            decide_paused_request(&[], &privacy(), &prefs, &after_redirect),
            InterceptAction::PrivacyBlock {
                category: PrivacyCategory::Ads,
            },
            "a cross-origin redirect must stop using the previous exception",
        );
    }

    #[test]
    fn top_frame_loading_clears_the_page_being_left_until_the_destination_is_known() {
        let mut context = TopFrameContext::new("https://protected.test/old");
        context.observe(&event(
            "Page.frameNavigated",
            json!({"frame": {"id": "main", "url": "https://protected.test/old"}}),
        ));

        context.observe(&event(
            "Page.frameStartedLoading",
            json!({"frameId": "main"}),
        ));

        assert_eq!(context.document_url(), "");
    }

    #[test]
    fn subframe_documents_cannot_replace_the_top_frame_context() {
        let mut context = TopFrameContext::new("https://protected.test/");
        context.observe(&event(
            "Page.frameNavigated",
            json!({"frame": {"id": "main", "url": "https://protected.test/"}}),
        ));
        context.observe(&event(
            "Fetch.requestPaused",
            json!({
                "requestId": "child-document",
                "frameId": "child",
                "resourceType": "Document",
                "request": {"url": "https://excepted.test/frame"}
            }),
        ));
        assert_eq!(context.document_url(), "https://protected.test/");

        context.observe(&event(
            "Fetch.requestPaused",
            json!({
                "requestId": "top-document",
                "frameId": "main",
                "resourceType": "Document",
                "request": {"url": "https://excepted.test/top"}
            }),
        ));
        assert_eq!(context.document_url(), "https://excepted.test/top");
    }

    #[derive(Clone, Copy)]
    enum Reply {
        Ok,
        ProtocolError,
        PinnedFetchContract,
    }

    // Chromium 52a94675, NetworkHandler::AddInterceptedResourceType. This
    // deliberately differs from the broader Network.ResourceType schema.
    const PINNED_FETCH_TYPES: &[&str] = &[
        "Document",
        "Stylesheet",
        "Image",
        "Media",
        "Font",
        "Script",
        "XHR",
        "Fetch",
        "CSPViolationReport",
        "Ping",
        "Other",
    ];

    fn pinned_fetch_rejection(message: &Value) -> Option<&str> {
        if message["method"] != "Fetch.enable" {
            return None;
        }
        message["params"]["patterns"]
            .as_array()?
            .iter()
            .find_map(|pattern| {
                let kind = pattern["resourceType"].as_str()?;
                (!kind.is_empty() && !PINNED_FETCH_TYPES.contains(&kind)).then_some(kind)
            })
    }

    #[derive(Clone)]
    struct ScriptedTransport {
        sent: Arc<StdMutex<Vec<Value>>>,
        replies: Arc<StdMutex<VecDeque<Reply>>>,
        session: Arc<StdMutex<Option<CdpSession>>>,
    }

    impl Transport for ScriptedTransport {
        fn send(&self, message: &str) -> Result<(), CdpError> {
            let value: Value = serde_json::from_str(message).expect("outgoing CDP JSON");
            let id = value["id"].as_u64().expect("CDP call id");
            self.sent
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(value.clone());
            let reply = self
                .replies
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .pop_front()
                .unwrap_or(Reply::Ok);
            let incoming = match reply {
                Reply::PinnedFetchContract => match pinned_fetch_rejection(&value) {
                    Some(kind) => json!({"id": id, "error": {"code": -32602,
                        "message": format!("Unknown resource type in fetch filter: '{kind}'")}}),
                    None => json!({"id": id, "result": {}}),
                },
                Reply::Ok => json!({"id": id, "result": {}}),
                Reply::ProtocolError => {
                    json!({"id": id, "error": {"code": -32000, "message": "injected"}})
                }
            };
            self.session
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_ref()
                .expect("session installed")
                .handle_incoming(&incoming.to_string())?;
            Ok(())
        }
    }

    fn scripted_session(replies: Vec<Reply>) -> (CdpSession, Arc<StdMutex<Vec<Value>>>) {
        let sent = Arc::new(StdMutex::new(Vec::new()));
        let holder = Arc::new(StdMutex::new(None));
        let session = CdpSession::new(ScriptedTransport {
            sent: Arc::clone(&sent),
            replies: Arc::new(StdMutex::new(replies.into())),
            session: Arc::clone(&holder),
        });
        *holder
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(session.clone());
        (session, sent)
    }

    #[tokio::test]
    async fn failed_header_rewrite_retries_one_plain_continue() {
        let (session, sent) = scripted_session(vec![Reply::ProtocolError, Reply::Ok]);
        let action = InterceptAction::Header {
            name: "X-Test".into(),
            value: "one".into(),
        };

        let reported = execute_action(
            &session,
            "request-1",
            &json!({"Existing": "value"}),
            &action,
        )
        .await;

        assert_eq!(reported, None);
        let sent = sent
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(sent.len(), 2, "recovery is bounded to one retry");
        assert_eq!(sent[0]["method"], "Fetch.continueRequest");
        assert!(sent[0]["params"].get("headers").is_some());
        assert_eq!(
            sent[1]["params"],
            json!({"requestId": "request-1"}),
            "the retry must drop the failed header override",
        );
    }

    #[tokio::test]
    async fn missing_request_id_recovery_resets_fetch_once() {
        let (session, sent) = scripted_session(vec![Reply::Ok, Reply::Ok]);

        let request_id = request_id_or_reset(
            &session,
            TabId::new(),
            &json!({"request": {"url": "https://example.test/"}}),
            &[],
            &enabled_prefs(),
        )
        .await;

        assert_eq!(request_id, None);
        let methods = sent
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .map(|message| message["method"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(methods, vec!["Fetch.disable", "Fetch.enable"]);
    }

    #[tokio::test]
    async fn privacy_apply_is_accepted_by_pinned_fetch_and_can_block_a_tracker() {
        let (session, sent) = scripted_session(vec![Reply::PinnedFetchContract, Reply::Ok]);
        apply(&session, &[], &enabled_prefs())
            .await
            .expect("privacy filters must enable on the shipping Fetch backend");
        let action = decide_paused_request(&[], &privacy(), &enabled_prefs(), &paused_ad());
        assert!(matches!(action, InterceptAction::PrivacyBlock { .. }));
        assert!(
            execute_action(&session, "tracker", &json!({}), &action)
                .await
                .is_some()
        );
        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0]["method"], "Fetch.enable");
        assert_eq!(sent[1]["method"], "Fetch.failRequest");
        assert_eq!(sent[1]["params"]["errorReason"], "BlockedByClient");
        let actual: std::collections::BTreeSet<_> = sent[0]["params"]["patterns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["resourceType"].as_str().unwrap())
            .collect();
        let expected = PINNED_FETCH_TYPES
            .iter()
            .copied()
            .filter(|kind| !matches!(*kind, "Media" | "Document"))
            .collect();
        assert_eq!(
            actual, expected,
            "all supported privacy subresource filters, without a wildcard"
        );
    }

    #[tokio::test]
    async fn disabling_workspace_rule_restores_valid_privacy_filters_then_disables_fetch() {
        let (session, sent) = scripted_session(vec![Reply::PinnedFetchContract; 3]);
        let mut workspace_rule = rule("*://media.example/*", RuleAction::Block);
        apply(&session, &[workspace_rule.clone()], &enabled_prefs())
            .await
            .unwrap();
        workspace_rule.enabled = false;
        apply(&session, &[workspace_rule], &enabled_prefs())
            .await
            .unwrap();
        apply(&session, &[], &Prefs::default()).await.unwrap();
        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 3);
        for message in &sent[..2] {
            let patterns = message["params"]["patterns"].as_array().unwrap();
            assert!(
                patterns.iter().all(|p| p["resourceType"]
                    .as_str()
                    .is_some_and(|kind| kind != "Media")),
                "a workspace rule must not widen interception to media"
            );
        }
        assert!(
            sent[1]["params"]["patterns"]
                .as_array()
                .unwrap()
                .iter()
                .all(|p| p["resourceType"]
                    .as_str()
                    .is_some_and(|kind| kind != "Media"))
        );
        assert_eq!(sent[2]["method"], "Fetch.disable");
    }

    #[tokio::test]
    async fn pinned_fetch_fixture_rejects_network_only_resource_types() {
        for kind in [
            "TextTrack",
            "Prefetch",
            "EventSource",
            "WebSocket",
            "Manifest",
            "SignedExchange",
            "Preflight",
        ] {
            let (session, _) = scripted_session(vec![Reply::PinnedFetchContract]);
            let error = session
                .call("Fetch.enable", json!({"patterns":[{"resourceType":kind}]}))
                .await
                .unwrap_err();
            assert!(error.to_string().contains("-32602"));
            assert!(error.to_string().contains(kind));
        }
    }

    #[test]
    fn privacy_only_interception_leaves_documents_and_media_alone() {
        let patterns = interception_patterns(&[]);
        let arr = patterns.as_array().unwrap();
        let types: Vec<&str> = arr
            .iter()
            .map(|p| p["resourceType"].as_str().unwrap())
            .collect();
        assert!(
            !types.contains(&"Media"),
            "media must not be intercepted for privacy"
        );
        assert!(
            !types.contains(&"Document"),
            "privacy always allows documents"
        );
        assert!(types.contains(&"Script"));
        assert!(arr.iter().all(|p| p["urlPattern"] == "*"));
    }

    #[test]
    fn a_workspace_rule_never_intercepts_media() {
        let rule = Rule {
            id: "r".into(),
            pattern: "*://media.example/*".into(),
            enabled: true,
            action: RuleAction::Block,
        };
        let patterns = interception_patterns(&[rule]);
        let arr = patterns.as_array().unwrap();
        assert!(
            arr.iter().all(|p| p.get("resourceType").is_some()),
            "a bare urlPattern would include Media and stall streaming"
        );
        let types: Vec<&str> = arr
            .iter()
            .map(|p| p["resourceType"].as_str().unwrap())
            .collect();
        assert!(!types.contains(&"Media"));
        assert!(
            types.contains(&"Document"),
            "workspace rules can rewrite documents"
        );
    }

    #[test]
    fn disabled_workspace_rules_do_not_pause_documents() {
        let mut disabled = rule("*", RuleAction::Block);
        disabled.enabled = false;
        assert_eq!(
            interception_patterns(&[disabled]),
            interception_patterns(&[])
        );
    }

    #[tokio::test]
    async fn enabling_and_disabling_a_document_rule_updates_the_fetch_filters() {
        let (session, sent) = scripted_session(vec![Reply::PinnedFetchContract; 3]);
        let prefs = enabled_prefs();
        let mut document_rule = rule(
            "*://example.test/*",
            RuleAction::Header {
                name: "X-Workspace".into(),
                value: "present".into(),
            },
        );
        apply(&session, &[], &prefs).await.unwrap();
        apply(&session, &[document_rule.clone()], &prefs)
            .await
            .unwrap();
        document_rule.enabled = false;
        apply(&session, &[document_rule], &prefs).await.unwrap();
        let sent = sent.lock().unwrap();
        let documents: Vec<bool> = sent
            .iter()
            .map(|message| {
                message["params"]["patterns"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|pattern| pattern["resourceType"] == "Document")
            })
            .collect();
        assert_eq!(documents, [false, true, false]);
    }

    #[tokio::test]
    async fn missing_request_id_recovery_does_not_disable_twice_when_it_stays_off() {
        let (session, sent) = scripted_session(vec![Reply::Ok]);

        let request_id = request_id_or_reset(
            &session,
            TabId::new(),
            &json!({"request": {"url": "https://example.test/"}}),
            &[],
            &Prefs::default(),
        )
        .await;

        assert_eq!(request_id, None);
        let methods = sent
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .map(|message| message["method"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(methods, vec!["Fetch.disable"]);
    }
}
