//! Mock and rewrite rules: per-workspace URL patterns that block a request,
//! answer it with a canned response, or add a request header. Applied
//! through the `DevTools` `Fetch` domain on every tab of the workspace.

use std::collections::HashMap;
use std::sync::Mutex;

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
#[derive(Default)]
pub struct Registry {
    by_workspace: Mutex<HashMap<WorkspaceId, Vec<Rule>>>,
}

fn setting_key(workspace: WorkspaceId) -> String {
    format!("rules:{workspace}")
}

impl Registry {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<WorkspaceId, Vec<Rule>>> {
        self.by_workspace
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Rules for `workspace`, reading the store the first time.
    pub fn list(&self, state: &AppState, workspace: WorkspaceId) -> Vec<Rule> {
        if let Some(rules) = self.map().get(&workspace) {
            return rules.clone();
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
        self.map().entry(workspace).or_insert(stored).clone()
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
        self.map().insert(workspace, rules);
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
pub fn matches(pattern: &str, url: &str) -> bool {
    let (p, u) = (pattern.to_ascii_lowercase(), url.to_ascii_lowercase());
    let parts: Vec<&str> = p.split('*').collect();
    if parts.len() == 1 {
        return p == u;
    }
    let mut pos = 0;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        let Some(found) = u[pos..].find(part) else {
            return false;
        };
        if i == 0 && found != 0 {
            return false;
        }
        pos += found + part.len();
    }
    parts.last().is_some_and(|last| last.is_empty()) || pos == u.len()
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

/// Enable shared interception when workspace rules or `DivePrivacy` need it.
pub async fn apply(session: &CdpSession, rules: &[Rule], prefs: &Prefs) -> AppResult<()> {
    let result = if interception_required(rules, prefs) {
        session
            .call("Fetch.enable", json!({"patterns": [{"urlPattern": "*"}]}))
            .await
    } else {
        session.call0("Fetch.disable").await
    };
    result.map(|_| ()).map_err(AppError::new)
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
        {
            let state = app.state::<AppState>();
            let rules = workspace.map_or_else(Vec::new, |id| state.rules.list(&state, id));
            let prefs = state.prefs.get(&state);
            if let Err(e) = apply(&session, &rules, &prefs).await {
                tracing::warn!(%tab_id, "fetch interception failed: {e}");
            }
        }
        let _ = ready_tx.send(());
        loop {
            let event = match events.recv().await {
                Ok(event) => event,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    // Lost `requestPaused` events otherwise remain paused
                    // forever. Disabling Fetch releases them, then restores the
                    // current rules for subsequent requests.
                    tracing::warn!(%tab_id, n, "rule listener lagged; resetting interception");
                    let _ = session.call0("Fetch.disable").await;
                    let (rules, prefs) = {
                        let state = app.state::<AppState>();
                        (
                            workspace.map_or_else(Vec::new, |id| state.rules.list(&state, id)),
                            state.prefs.get(&state),
                        )
                    };
                    let _ = apply(&session, &rules, &prefs).await;
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            if event.method != "Fetch.requestPaused" {
                continue;
            }
            let p = &event.params;
            let Some(request_id) = p["requestId"].as_str().map(str::to_owned) else {
                tracing::warn!(%tab_id, "paused request had no request id; cannot fail open");
                continue;
            };
            let url = p["request"]["url"].as_str().unwrap_or_default();
            let (rules, prefs, document_url) = {
                let state = app.state::<AppState>();
                (
                    workspace.map_or_else(Vec::new, |id| state.rules.list(&state, id)),
                    state.prefs.get(&state),
                    crate::state::lock(&state.store)
                        .tab(tab_id)
                        .map(|tab| tab.url)
                        .unwrap_or_default(),
                )
            };
            let action = {
                let state = app.state::<AppState>();
                decide_paused_request(
                    &rules,
                    &state.privacy,
                    &prefs,
                    &PausedRequest {
                        url,
                        document_url: &document_url,
                        resource_type: p["resourceType"].as_str().unwrap_or_default(),
                        method: p["request"]["method"].as_str().unwrap_or_default(),
                    },
                )
            };
            let privacy_category = match &action {
                InterceptAction::PrivacyBlock { category } => Some(*category),
                _ => None,
            };
            let (method, params) = match action {
                InterceptAction::Block | InterceptAction::PrivacyBlock { .. } => (
                    "Fetch.failRequest",
                    json!({"requestId": &request_id, "errorReason": "BlockedByClient"}),
                ),
                InterceptAction::Mock {
                    status,
                    content_type,
                    body,
                } => (
                    "Fetch.fulfillRequest",
                    json!({
                        "requestId": &request_id,
                        "responseCode": status,
                        "responseHeaders": [
                            {"name": "Content-Type", "value": content_type},
                            {"name": "Access-Control-Allow-Origin", "value": "*"},
                            {"name": "X-Dive-Mock", "value": "1"}
                        ],
                        "body": base64::engine::general_purpose::STANDARD.encode(&body),
                    }),
                ),
                InterceptAction::Header { name, value } => {
                    let mut headers: Vec<Value> = p["request"]["headers"]
                        .as_object()
                        .map(|m| {
                            m.iter()
                                .filter(|(k, _)| !k.eq_ignore_ascii_case(&name))
                                .map(|(k, v)| json!({"name": k, "value": v}))
                                .collect()
                        })
                        .unwrap_or_default();
                    headers.push(json!({"name": name, "value": value}));
                    (
                        "Fetch.continueRequest",
                        json!({"requestId": &request_id, "headers": headers}),
                    )
                }
                InterceptAction::Continue => {
                    ("Fetch.continueRequest", json!({"requestId": &request_id}))
                }
            };
            match session.call(method, params).await {
                Ok(_) => {
                    if let Some(category) = privacy_category
                        && let Err(e) = (PrivacyEvent::Blocked { tab_id, category }).emit(&app)
                    {
                        tracing::warn!(%tab_id, "privacy event emit failed: {e}");
                    }
                }
                Err(e) => {
                    tracing::debug!(%tab_id, "{method} failed: {e}");
                    // A failed mock/block must degrade to a real request rather
                    // than leaving the page permanently waiting on interception.
                    if method != "Fetch.continueRequest" {
                        let _ = session
                            .call("Fetch.continueRequest", json!({"requestId": &request_id}))
                            .await;
                    }
                }
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
}
