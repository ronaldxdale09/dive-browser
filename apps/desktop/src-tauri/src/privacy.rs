use adblock::{Engine, FilterSet, lists::ParseOptions, request::Request};
use dive_cdp::{CdpEvent, CdpSession};
use dive_core::TabId;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::Runtime;
use crate::error::{AppError, AppResult};

const ADS_RULES: &str = include_str!("../privacy/ads.txt");
const TRACKER_RULES: &str = include_str!("../privacy/trackers.txt");
const EXCEPTION_RULES: &str = include_str!("../privacy/exceptions.txt");
const COSMETIC_RULES: &str = include_str!("../privacy/cosmetic.json");
const YOUTUBE_SCRIPT: &str = include_str!("inject/youtube_privacy.js");
const _: &str = include_str!("../privacy/VERSION");
const PAGE_BINDING_PREFIX: &str = "__divePrivacy_";
const MAX_PAGE_EVENT: usize = 64;

/// Version of the rule assets bundled with this application.
pub const DIVE_PRIVACY_VERSION: &str = "2026.09.04.3";

/// Categories reported for network requests blocked by `DivePrivacy`.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyCategory {
    /// Advertising delivery and auction infrastructure.
    Ads,
    /// Analytics, telemetry, fingerprinting, and cryptomining infrastructure.
    Tracker,
}

/// A privacy action the chrome may summarize without exposing browsing URLs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum PrivacyEvent {
    /// A network request was cancelled by `DivePrivacy`.
    Blocked {
        /// Tab whose request was cancelled.
        tab_id: TabId,
        /// Which bundled matcher blocked it.
        category: PrivacyCategory,
    },
    /// A narrow `YouTube` privacy intervention was observed in a document.
    #[serde(rename = "youtube")]
    YouTube {
        /// Tab whose document received the intervention.
        tab_id: TabId,
        /// Number of reported interventions.
        count: u32,
    },
}

/// Public metadata about the bundled `DivePrivacy` assets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct PrivacyInfo {
    /// Bundled ruleset version.
    pub version: String,
    /// Number of advertising network rules.
    pub ad_rules: u32,
    /// Number of tracking network rules.
    pub tracker_rules: u32,
    /// Number of hosts with cosmetic rules.
    pub cosmetic_hosts: u32,
}

/// Return bundled ruleset metadata without reading browsing state.
#[tauri::command]
#[specta::specta]
pub fn privacy_info() -> PrivacyInfo {
    PrivacyInfo {
        version: DIVE_PRIVACY_VERSION.to_owned(),
        ad_rules: network_rule_count(ADS_RULES),
        tracker_rules: network_rule_count(TRACKER_RULES),
        cosmetic_hosts: serde_json::from_str::<serde_json::Value>(COSMETIC_RULES)
            .ok()
            .and_then(|value| value.as_object().map(serde_json::Map::len))
            .and_then(|count| u32::try_from(count).ok())
            .unwrap_or_default(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageConfiguration {
    enabled: bool,
    cosmetic_css: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentPolicy {
    global_enabled: bool,
    youtube_enabled: bool,
    exceptions: Vec<String>,
    cosmetic_css_by_host: BTreeMap<String, String>,
}

/// Per-tab identifiers for replaceable document-start policy scripts. The
/// page API itself is stable; only this small preferences snapshot changes.
#[derive(Default)]
pub struct PageRegistry {
    policies: Mutex<HashMap<TabId, Vec<String>>>,
}

impl PageRegistry {
    fn policies(&self, tab_id: TabId) -> Vec<String> {
        self.policies
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&tab_id)
            .cloned()
            .unwrap_or_default()
    }

    fn replace(&self, tab_id: TabId, identifiers: Vec<String>) {
        let mut policies = self
            .policies
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if identifiers.is_empty() {
            policies.remove(&tab_id);
        } else {
            policies.insert(tab_id, identifiers);
        }
    }

    /// Forget registration ids owned by a tab whose CDP session is gone.
    pub fn drop_tab(&self, tab_id: TabId) {
        self.replace(tab_id, Vec::new());
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PageEvent {
    kind: String,
    count: u32,
}

/// Install `DivePrivacy`'s page binding and bootstrap script for one CEF tab.
///
/// Every call is best effort: a missing CDP capability leaves the document
/// untouched rather than preventing its navigation.
pub async fn attach_page(app: AppHandle<Runtime>, tab_id: TabId, session: CdpSession) {
    let binding = page_binding(tab_id);
    let source = YOUTUBE_SCRIPT.replace("__DIVE_PRIVACY_BINDING__", &binding);
    let mut events = session.subscribe();

    for (method, params) in [
        ("Runtime.enable", json!({})),
        ("Runtime.addBinding", json!({"name": binding})),
        ("Page.enable", json!({})),
        (
            "Page.addScriptToEvaluateOnNewDocument",
            json!({"source": &source}),
        ),
    ] {
        if let Err(error) = session.call(method, params).await {
            tracing::debug!(%tab_id, %method, "DivePrivacy page setup failed open: {error}");
        }
    }
    // Join the same transaction boundary as `prefs_set`: otherwise a tab
    // attaching with an older snapshot could register its policy after a
    // newer persisted update had already finished applying.
    {
        let state = app.state::<crate::state::AppState>();
        let _update = state.prefs.begin_update().await;
        let prefs = state.prefs.get(&state);
        match register_document_policy(&session, &prefs).await {
            Ok(identifier) => state.privacy_pages.replace(tab_id, vec![identifier]),
            Err(error) => {
                tracing::debug!(%tab_id, "DivePrivacy document policy registration failed open: {error}");
            }
        }
        if let Err(error) = session
            .call("Runtime.evaluate", json!({"expression": &source}))
            .await
        {
            tracing::debug!(%tab_id, "DivePrivacy current-page bootstrap failed open: {error}");
        }
        apply_page(&session, &prefs).await;
    }

    tauri::async_runtime::spawn(async move {
        let mut context = PageBindingContext::default();
        loop {
            match events.recv().await {
                Ok(event) => {
                    context.observe(&event);
                    if event.method == "Page.frameNavigated"
                        && event.params["frame"]["parentId"].is_null()
                    {
                        let state = app.state::<crate::state::AppState>();
                        let _update = state.prefs.begin_update().await;
                        let prefs = state.prefs.get(&state);
                        apply_page(&session, &prefs).await;
                        continue;
                    }
                    if let Some(event) =
                        map_binding_event(&event, &binding, tab_id, context.execution_context())
                    {
                        let state = app.state::<crate::state::AppState>();
                        let _update = state.prefs.begin_update().await;
                        let prefs = state.prefs.get(&state);
                        let tab_exists = crate::state::lock(&state.store).tab(tab_id).is_ok();
                        let allowed = binding_event_allowed(
                            session.is_closed(),
                            tab_exists,
                            &prefs,
                            context.document_url(),
                        );
                        if allowed && let Err(error) = event.emit(&app) {
                            tracing::warn!(%tab_id, "privacy event emit failed: {error}");
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                    tracing::warn!(%tab_id, count, "DivePrivacy missed CDP events");
                    context.invalidate();
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    app.state::<crate::state::AppState>()
                        .privacy_pages
                        .drop_tab(tab_id);
                    break;
                }
            }
        }
    });
}

fn document_policy(prefs: &crate::prefs::Prefs) -> DocumentPolicy {
    DocumentPolicy {
        global_enabled: prefs.block_trackers,
        youtube_enabled: prefs.youtube_protection,
        exceptions: prefs.privacy_exceptions.clone(),
        cosmetic_css_by_host: cosmetic_policy(),
    }
}

fn document_policy_expression(prefs: &crate::prefs::Prefs) -> AppResult<String> {
    let encoded = serde_json::to_string(&document_policy(prefs)).map_err(AppError::new)?;
    Ok(format!(
        "window.__divePrivacy?.configureForDocument({encoded})"
    ))
}

async fn register_document_policy(
    session: &CdpSession,
    prefs: &crate::prefs::Prefs,
) -> AppResult<String> {
    let source = document_policy_expression(prefs)?;
    let result = session
        .call(
            "Page.addScriptToEvaluateOnNewDocument",
            json!({"source": source}),
        )
        .await
        .map_err(AppError::new)?;
    result["identifier"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| AppError::new("document policy registration returned no identifier"))
}

/// Replace the future-document policy, then apply the same authoritative
/// preferences to the live top document. Failed removals stay recorded so a
/// later update can retry them; the newest script runs last at document start.
pub async fn refresh_page_policy(
    state: &crate::state::AppState,
    tab_id: TabId,
    session: &CdpSession,
    prefs: &crate::prefs::Prefs,
) {
    replace_document_policy(&state.privacy_pages, tab_id, session, prefs).await;
    apply_page(session, prefs).await;
}

async fn replace_document_policy(
    registry: &PageRegistry,
    tab_id: TabId,
    session: &CdpSession,
    prefs: &crate::prefs::Prefs,
) {
    let mut remaining = Vec::new();
    for identifier in registry.policies(tab_id) {
        if let Err(error) = session
            .call(
                "Page.removeScriptToEvaluateOnNewDocument",
                json!({"identifier": &identifier}),
            )
            .await
        {
            tracing::debug!(%tab_id, %identifier, "could not replace old DivePrivacy policy: {error}");
            remaining.push(identifier);
        }
    }
    match register_document_policy(session, prefs).await {
        Ok(identifier) => remaining.push(identifier),
        Err(error) => {
            tracing::debug!(%tab_id, "could not register current DivePrivacy policy: {error}");
        }
    }
    registry.replace(tab_id, remaining);
}

/// Apply current preferences in the live document. Host selection happens in
/// page world from `location.hostname`, avoiding the asynchronously persisted
/// tab URL during navigation.
pub async fn apply_page(session: &CdpSession, prefs: &crate::prefs::Prefs) {
    let Ok(expression) = document_policy_expression(prefs) else {
        tracing::debug!("could not serialize DivePrivacy page configuration");
        return;
    };
    if let Err(error) = session
        .call("Runtime.evaluate", json!({"expression": expression}))
        .await
    {
        tracing::debug!("DivePrivacy page configuration failed open: {error}");
    }
}

/// Decode the single bounded page-side intervention message shape.
#[must_use]
pub fn map_binding_event(
    event: &CdpEvent,
    binding: &str,
    tab_id: TabId,
    expected_context: Option<i64>,
) -> Option<PrivacyEvent> {
    if event.method != "Runtime.bindingCalled" || event.params["name"].as_str()? != binding {
        return None;
    }
    if Some(event.params["executionContextId"].as_i64()?) != expected_context {
        return None;
    }
    let encoded = event.params["payload"].as_str()?;
    if encoded.len() > MAX_PAGE_EVENT {
        return None;
    }
    let payload: PageEvent = serde_json::from_str(encoded).ok()?;
    if payload.kind != "youtube" || payload.count != 1 {
        return None;
    }
    Some(PrivacyEvent::YouTube {
        tab_id,
        count: payload.count,
    })
}

#[derive(Default)]
struct PageBindingContext {
    frame_id: Option<String>,
    document_url: String,
    generation: u64,
    execution_context: Option<(i64, u64)>,
}

impl PageBindingContext {
    fn document_url(&self) -> &str {
        &self.document_url
    }

    fn execution_context(&self) -> Option<i64> {
        self.execution_context
            .filter(|(_, generation)| *generation == self.generation)
            .map(|(context, _)| context)
    }

    fn invalidate(&mut self) {
        self.execution_context = None;
    }

    fn begin_document(&mut self, frame_id: &str, document_url: Option<&str>) {
        let is_top = if let Some(top) = self.frame_id.as_deref() {
            top == frame_id
        } else {
            self.frame_id = Some(frame_id.to_owned());
            true
        };
        if is_top {
            self.generation = self.generation.saturating_add(1);
            self.execution_context = None;
            document_url
                .unwrap_or_default()
                .clone_into(&mut self.document_url);
        }
    }

    fn observe(&mut self, event: &CdpEvent) {
        let params = &event.params;
        match event.method.as_str() {
            "Page.frameNavigated" => {
                let frame = &params["frame"];
                if frame["parentId"].as_str().is_none()
                    && let Some(frame_id) = frame["id"].as_str()
                {
                    self.frame_id = Some(frame_id.to_owned());
                    self.generation = self.generation.saturating_add(1);
                    self.execution_context = None;
                    frame["url"]
                        .as_str()
                        .unwrap_or_default()
                        .clone_into(&mut self.document_url);
                }
            }
            "Page.frameStartedLoading" => {
                if let Some(frame_id) = params["frameId"].as_str() {
                    self.begin_document(frame_id, None);
                }
            }
            "Network.requestWillBeSent" if params["type"].as_str() == Some("Document") => {
                if let Some(frame_id) = params["frameId"].as_str() {
                    self.begin_document(frame_id, params["request"]["url"].as_str());
                }
            }
            "Fetch.requestPaused" if params["resourceType"].as_str() == Some("Document") => {
                if let Some(frame_id) = params["frameId"].as_str() {
                    self.begin_document(frame_id, params["request"]["url"].as_str());
                }
            }
            "Runtime.executionContextsCleared" => self.execution_context = None,
            "Runtime.executionContextDestroyed" => {
                if params["executionContextId"].as_i64() == self.execution_context() {
                    self.execution_context = None;
                }
            }
            "Runtime.executionContextCreated" => {
                let context = &params["context"];
                let auxiliary = &context["auxData"];
                if auxiliary["isDefault"].as_bool() == Some(true)
                    && auxiliary["frameId"].as_str() == self.frame_id.as_deref()
                    && let Some(context_id) = context["id"].as_i64()
                {
                    self.execution_context = Some((context_id, self.generation));
                }
            }
            _ => {}
        }
    }
}

fn binding_event_allowed(
    session_closed: bool,
    tab_exists: bool,
    prefs: &crate::prefs::Prefs,
    document_url: &str,
) -> bool {
    !session_closed && tab_exists && page_configuration(prefs, document_url).enabled
}

fn page_binding(tab_id: TabId) -> String {
    format!(
        "{PAGE_BINDING_PREFIX}{}",
        tab_id.to_string().replace('-', "")
    )
}

fn page_configuration(prefs: &crate::prefs::Prefs, document_url: &str) -> PageConfiguration {
    let Some(host) = exact_host(document_url) else {
        return PageConfiguration {
            enabled: false,
            cosmetic_css: String::new(),
        };
    };
    let site_enabled = prefs.privacy_enabled_for(document_url);
    let youtube_host = matches!(host.as_str(), "www.youtube.com" | "m.youtube.com");
    let layers_enabled =
        site_enabled && prefs.block_trackers && (!youtube_host || prefs.youtube_protection);
    PageConfiguration {
        enabled: prefs.block_trackers && site_enabled && youtube_host && prefs.youtube_protection,
        cosmetic_css: if layers_enabled {
            cosmetic_css(&host)
        } else {
            String::new()
        },
    }
}

fn exact_host(document_url: &str) -> Option<String> {
    url::Url::parse(document_url)
        .ok()?
        .host_str()
        .map(|host| host.trim_end_matches('.').to_ascii_lowercase())
}

fn cosmetic_css(host: &str) -> String {
    let Ok(rules) =
        serde_json::from_str::<std::collections::BTreeMap<String, Vec<String>>>(COSMETIC_RULES)
    else {
        return String::new();
    };
    let Some(selectors) = rules.get(host).filter(|selectors| !selectors.is_empty()) else {
        return String::new();
    };
    format!("{} {{ display: none !important; }}", selectors.join(",\n"))
}

fn cosmetic_policy() -> BTreeMap<String, String> {
    let Ok(rules) = serde_json::from_str::<BTreeMap<String, Vec<String>>>(COSMETIC_RULES) else {
        return BTreeMap::new();
    };
    rules
        .into_iter()
        .filter_map(|(host, selectors)| {
            (!selectors.is_empty()).then(|| {
                (
                    host,
                    format!("{} {{ display: none !important; }}", selectors.join(",\n")),
                )
            })
        })
        .collect()
}

fn network_rule_count(rules: &str) -> u32 {
    u32::try_from(
        rules
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('!'))
            .count(),
    )
    .unwrap_or(u32::MAX)
}

/// The result of applying `DivePrivacy` to one request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PrivacyDecision {
    /// Continue the request.
    Allow,
    /// Cancel the request and report its category.
    Block(PrivacyCategory),
}

/// Browser request data needed for privacy matching.
pub struct RequestContext<'a> {
    /// URL requested by the browser.
    pub url: &'a str,
    /// URL of the document that initiated the request.
    pub document_url: &'a str,
    /// `document_url`'s host as [`crate::rules::document_host_of`] gives it,
    /// parsed once per document by the caller rather than once per request.
    pub document_host: Option<String>,
    /// CDP resource type for the request.
    pub resource_type: &'a str,
    /// HTTP method for the request.
    pub method: &'a str,
}

/// Immutable, category-specific network matchers built from Dive-owned rules.
pub struct DivePrivacy {
    ads: Engine,
    trackers: Engine,
}

impl Default for DivePrivacy {
    fn default() -> Self {
        Self::new()
    }
}

impl DivePrivacy {
    /// Creates matchers from the rules bundled with Dive.
    #[must_use]
    pub fn new() -> Self {
        Self::from_text(ADS_RULES, TRACKER_RULES, EXCEPTION_RULES)
    }

    /// Creates matchers from rule text, primarily for focused regression tests.
    #[must_use]
    pub fn from_text(ads: &str, trackers: &str, exceptions: &str) -> Self {
        Self {
            ads: build_engine(ads, exceptions),
            trackers: build_engine(trackers, exceptions),
        }
    }

    /// Returns the category to block, or allows a request when it is malformed or unmatched.
    #[must_use]
    pub fn decide(&self, context: &RequestContext<'_>) -> PrivacyDecision {
        if context.resource_type.eq_ignore_ascii_case("document")
            || context.resource_type.eq_ignore_ascii_case("media")
        {
            return PrivacyDecision::Allow;
        }

        let resource_type = context.resource_type.to_ascii_lowercase();
        if !is_known_resource_type(&resource_type) {
            return PrivacyDecision::Allow;
        }

        if context.document_host.is_none() {
            return PrivacyDecision::Allow;
        }

        let Ok(request) = Request::new(
            context.url,
            context.document_url,
            &resource_type,
            context.method,
        ) else {
            return PrivacyDecision::Allow;
        };

        if self.ads.check_network_request(&request).should_block() {
            return PrivacyDecision::Block(PrivacyCategory::Ads);
        }
        if self.trackers.check_network_request(&request).should_block() {
            return PrivacyDecision::Block(PrivacyCategory::Tracker);
        }
        PrivacyDecision::Allow
    }
}

fn build_engine(rules: &str, exceptions: &str) -> Engine {
    let mut filters = FilterSet::new(false);
    filters.add_filter_list(format!("{rules}\n{exceptions}"), ParseOptions::default());
    Engine::new_with_filter_set(filters)
}

fn is_known_resource_type(resource_type: &str) -> bool {
    matches!(
        resource_type,
        "beacon"
            | "csp_report"
            | "document"
            | "eventsource"
            | "fetch"
            | "font"
            | "image"
            | "imageset"
            | "manifest"
            | "media"
            | "object"
            | "object_subrequest"
            | "other"
            | "ping"
            | "prefetch"
            | "preflight"
            | "script"
            | "signedexchange"
            | "stylesheet"
            | "sub_frame"
            | "subdocument"
            | "texttrack"
            | "websocket"
            | "xhr"
            | "xmlhttprequest"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use adblock::filters::network::NetworkFilter;
    use std::collections::HashSet;

    fn ctx<'a>(url: &'a str, document_url: &'a str, resource_type: &'a str) -> RequestContext<'a> {
        RequestContext {
            url,
            document_url,
            document_host: exact_host(document_url),
            resource_type,
            method: "GET",
        }
    }

    #[test]
    fn classifies_ads_trackers_and_safe_requests() {
        let privacy = DivePrivacy::new();
        assert_eq!(
            privacy.decide(&ctx(
                "https://ads.doubleclick.net/pagead/id",
                "https://news.test/",
                "script",
            )),
            PrivacyDecision::Block(PrivacyCategory::Ads)
        );
        assert_eq!(
            privacy.decide(&ctx(
                "https://www.google-analytics.com/g/collect",
                "https://shop.test/",
                "xhr",
            )),
            PrivacyDecision::Block(PrivacyCategory::Tracker)
        );
        assert_eq!(
            privacy.decide(&ctx(
                "https://cdn.shop.test/app.js",
                "https://shop.test/",
                "script",
            )),
            PrivacyDecision::Allow
        );
    }

    #[test]
    fn bundled_rules_block_the_live_fixture_endpoints() {
        let privacy = DivePrivacy::new();
        let document = "http://127.0.0.1:18765/";

        assert_eq!(
            privacy.decide(&ctx(
                "https://ads.doubleclick.net/diveprivacy-fixture.gif",
                document,
                "image",
            )),
            PrivacyDecision::Block(PrivacyCategory::Ads)
        );
        assert_eq!(
            privacy.decide(&ctx(
                "https://www.google-analytics.com/diveprivacy-fixture.js",
                document,
                "script",
            )),
            PrivacyDecision::Block(PrivacyCategory::Tracker)
        );
    }

    #[test]
    fn requests_without_valid_page_context_fail_open() {
        let privacy = DivePrivacy::new();

        for document_url in ["", "not a url", "about:blank"] {
            assert_eq!(
                privacy.decide(&ctx(
                    "https://ads.doubleclick.net/diveprivacy-fixture.gif",
                    document_url,
                    "image",
                )),
                PrivacyDecision::Allow,
                "document URL {document_url:?} must fail open",
            );
        }
    }

    #[test]
    fn exceptions_and_documents_fail_open() {
        let privacy =
            DivePrivacy::from_text("||metrics.test^", "", "@@||metrics.test/required.js$script");
        assert_eq!(
            privacy.decide(&ctx(
                "https://metrics.test/required.js",
                "https://app.test/",
                "script",
            )),
            PrivacyDecision::Allow
        );
        assert_eq!(
            privacy.decide(&ctx(
                "https://metrics.test/",
                "https://metrics.test/",
                "document",
            )),
            PrivacyDecision::Allow
        );
        assert_eq!(
            privacy.decide(&ctx("not a url", "https://app.test/", "script")),
            PrivacyDecision::Allow
        );
    }

    #[test]
    fn media_requests_fail_open() {
        let privacy = DivePrivacy::from_text("||ads.test^", "", "");
        assert_eq!(
            privacy.decide(&ctx(
                "https://ads.test/video.mp4",
                "https://news.test/",
                "media",
            )),
            PrivacyDecision::Allow
        );
    }

    #[test]
    fn bundled_network_rules_are_unique() {
        for (name, text) in [("ads", ADS_RULES), ("trackers", TRACKER_RULES)] {
            let mut rules = HashSet::new();
            for rule in text
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty() && !line.starts_with('!'))
            {
                assert!(rules.insert(rule), "duplicate {name} rule: {rule}");
            }
        }
    }

    #[test]
    fn bundled_network_rules_do_not_include_subsumed_rules() {
        for (name, text) in [("ads", ADS_RULES), ("trackers", TRACKER_RULES)] {
            let rules = text
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty() && !line.starts_with('!'))
                .map(OwnedNetworkRule::parse)
                .collect::<Vec<_>>();
            for (index, rule) in rules.iter().enumerate() {
                for other in rules.iter().skip(index + 1) {
                    assert!(
                        !rule.subsumes(other) && !other.subsumes(rule),
                        "subsumed {name} rule: {} and {}",
                        rule.raw,
                        other.raw
                    );
                }
            }
        }
    }

    #[test]
    fn bundled_network_rules_parse() {
        for (name, text) in [("ads", ADS_RULES), ("trackers", TRACKER_RULES)] {
            for rule in text
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty() && !line.starts_with('!'))
            {
                assert!(
                    NetworkFilter::parse(rule, false, ParseOptions::default()).is_ok(),
                    "invalid {name} rule: {rule}"
                );
            }
        }
    }

    #[test]
    fn bundled_version_matches_public_version() {
        assert_eq!(
            include_str!("../privacy/VERSION").trim(),
            DIVE_PRIVACY_VERSION
        );
    }

    #[test]
    fn privacy_info_reports_only_bundled_asset_metadata() {
        assert_eq!(
            privacy_info(),
            PrivacyInfo {
                version: "2026.09.04.3".into(),
                ad_rules: 62,
                tracker_rules: 60,
                cosmetic_hosts: 3,
            }
        );
    }

    #[test]
    fn page_configuration_uses_exact_hosts_and_honours_site_exceptions() {
        let mut prefs = crate::prefs::Prefs {
            block_trackers: true,
            ..crate::prefs::Prefs::default()
        };
        let youtube = page_configuration(&prefs, "https://www.youtube.com/watch?v=abc");
        assert!(youtube.enabled);
        assert!(youtube.cosmetic_css.contains(".ytp-ad-overlay-container"));
        assert!(!youtube.cosmetic_css.contains("*="));

        let google = page_configuration(&prefs, "https://www.google.com/search?q=dive");
        assert!(!google.enabled);
        assert!(google.cosmetic_css.contains("#tads"));
        assert!(google.cosmetic_css.contains("#bottomads"));

        let unsupported = page_configuration(&prefs, "https://video.youtube.com/watch?v=abc");
        assert!(!unsupported.enabled);
        assert!(unsupported.cosmetic_css.is_empty());

        prefs.privacy_exceptions = vec!["www.youtube.com".into()];
        let paused = page_configuration(&prefs, "https://www.youtube.com/watch?v=abc");
        assert!(!paused.enabled);
        assert!(paused.cosmetic_css.is_empty());
    }

    #[test]
    fn page_configuration_disables_youtube_when_global_protection_is_off() {
        let prefs = crate::prefs::Prefs {
            block_trackers: false,
            youtube_protection: true,
            ..crate::prefs::Prefs::default()
        };

        let youtube = page_configuration(&prefs, "https://www.youtube.com/watch?v=abc");

        assert!(!youtube.enabled);
        assert!(youtube.cosmetic_css.is_empty());
    }

    #[test]
    fn page_configuration_disables_all_youtube_layers_when_youtube_is_off() {
        let prefs = crate::prefs::Prefs {
            block_trackers: true,
            youtube_protection: false,
            ..crate::prefs::Prefs::default()
        };

        let youtube = page_configuration(&prefs, "https://www.youtube.com/watch?v=abc");

        assert!(!youtube.enabled);
        assert!(youtube.cosmetic_css.is_empty());
    }

    #[test]
    fn binding_events_accept_only_the_bounded_youtube_shape() {
        let tab_id = dive_core::TabId::new();
        let binding = "__divePrivacy_test";
        let event = dive_cdp::CdpEvent {
            method: "Runtime.bindingCalled".into(),
            params: serde_json::json!({
                "name": binding,
                "payload": r#"{"kind":"youtube","count":1}"#,
                "executionContextId": 7,
            }),
        };
        assert_eq!(
            map_binding_event(&event, binding, tab_id, Some(7)),
            Some(PrivacyEvent::YouTube { tab_id, count: 1 })
        );

        assert_eq!(
            map_binding_event(&event, binding, tab_id, Some(8)),
            None,
            "a stale or subframe execution context cannot report counts",
        );

        for payload in [
            r#"{"kind":"youtube","count":2}"#,
            r#"{"kind":"youtube","count":1,"url":"https://example.test"}"#,
            r#"{"kind":"other","count":1}"#,
            "not json",
        ] {
            let malformed = dive_cdp::CdpEvent {
                method: "Runtime.bindingCalled".into(),
                params: serde_json::json!({"name": binding, "payload": payload, "executionContextId": 7}),
            };
            assert_eq!(
                map_binding_event(&malformed, binding, tab_id, Some(7)),
                None
            );
        }

        let oversized = dive_cdp::CdpEvent {
            method: "Runtime.bindingCalled".into(),
            params: serde_json::json!({"name": binding, "payload": "x".repeat(65), "executionContextId": 7}),
        };
        assert_eq!(
            map_binding_event(&oversized, binding, tab_id, Some(7)),
            None
        );
    }

    fn cdp_event(method: &str, params: serde_json::Value) -> CdpEvent {
        CdpEvent {
            method: method.into(),
            params,
        }
    }

    #[test]
    fn binding_context_rejects_subframes_and_previous_document_generations() {
        let mut context = PageBindingContext::default();
        context.observe(&cdp_event(
            "Page.frameNavigated",
            json!({"frame": {"id": "main", "url": "https://www.youtube.com/watch?v=one"}}),
        ));
        context.observe(&cdp_event(
            "Runtime.executionContextCreated",
            json!({"context": {"id": 11, "auxData": {"frameId": "main", "isDefault": true}}}),
        ));
        assert_eq!(context.execution_context(), Some(11));
        assert_eq!(
            context.document_url(),
            "https://www.youtube.com/watch?v=one"
        );

        context.observe(&cdp_event(
            "Runtime.executionContextCreated",
            json!({"context": {"id": 12, "auxData": {"frameId": "child", "isDefault": true}}}),
        ));
        assert_eq!(context.execution_context(), Some(11));

        context.observe(&cdp_event(
            "Network.requestWillBeSent",
            json!({
                "frameId": "main",
                "type": "Document",
                "request": {"url": "https://www.youtube.com/watch?v=two"}
            }),
        ));
        assert_eq!(context.execution_context(), None);
        assert_eq!(
            context.document_url(),
            "https://www.youtube.com/watch?v=two"
        );
        context.observe(&cdp_event(
            "Runtime.executionContextCreated",
            json!({"context": {"id": 13, "auxData": {"frameId": "main", "isDefault": true}}}),
        ));
        assert_eq!(context.execution_context(), Some(13));
    }

    #[test]
    fn binding_counts_require_a_live_tab_and_effective_youtube_policy() {
        let prefs = crate::prefs::Prefs {
            block_trackers: true,
            youtube_protection: true,
            ..crate::prefs::Prefs::default()
        };
        assert!(binding_event_allowed(
            false,
            true,
            &prefs,
            "https://www.youtube.com/watch?v=abc",
        ));
        assert!(!binding_event_allowed(
            true,
            true,
            &prefs,
            "https://www.youtube.com/watch?v=abc",
        ));
        assert!(!binding_event_allowed(
            false,
            false,
            &prefs,
            "https://www.youtube.com/watch?v=abc",
        ));
        assert!(!binding_event_allowed(
            false,
            true,
            &prefs,
            "https://example.test/",
        ));
    }

    #[derive(Clone)]
    struct PolicyTransport {
        sent: std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
        session: std::sync::Arc<std::sync::Mutex<Option<CdpSession>>>,
    }

    impl dive_cdp::Transport for PolicyTransport {
        fn send(&self, message: &str) -> Result<(), dive_cdp::CdpError> {
            let message: serde_json::Value =
                serde_json::from_str(message).expect("outgoing CDP JSON");
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
                .handle_incoming(
                    &json!({"id": id, "result": {"identifier": "policy-1"}}).to_string(),
                )?;
            Ok(())
        }
    }

    #[tokio::test]
    async fn document_policy_is_registered_for_document_start() {
        let sent = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let holder = std::sync::Arc::new(std::sync::Mutex::new(None));
        let session = CdpSession::new(PolicyTransport {
            sent: std::sync::Arc::clone(&sent),
            session: std::sync::Arc::clone(&holder),
        });
        *holder
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(session.clone());
        let prefs = crate::prefs::Prefs {
            block_trackers: true,
            youtube_protection: true,
            privacy_exceptions: vec!["m.youtube.com".into()],
            ..crate::prefs::Prefs::default()
        };

        let identifier = register_document_policy(&session, &prefs)
            .await
            .expect("registered policy");

        assert_eq!(identifier, "policy-1");
        let sent = sent
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["method"], "Page.addScriptToEvaluateOnNewDocument");
    }

    #[tokio::test]
    async fn preference_refresh_replaces_the_future_document_policy() {
        let sent = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let holder = std::sync::Arc::new(std::sync::Mutex::new(None));
        let session = CdpSession::new(PolicyTransport {
            sent: std::sync::Arc::clone(&sent),
            session: std::sync::Arc::clone(&holder),
        });
        *holder
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(session.clone());
        let registry = PageRegistry::default();
        let tab_id = TabId::new();
        registry.replace(tab_id, vec!["policy-old".into()]);
        let prefs = crate::prefs::Prefs {
            block_trackers: false,
            youtube_protection: false,
            privacy_exceptions: vec!["www.youtube.com".into()],
            ..crate::prefs::Prefs::default()
        };

        replace_document_policy(&registry, tab_id, &session, &prefs).await;

        let sent = sent
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(sent.len(), 2);
        assert_eq!(
            sent[0],
            json!({
                "id": sent[0]["id"],
                "method": "Page.removeScriptToEvaluateOnNewDocument",
                "params": {"identifier": "policy-old"}
            })
        );
        assert_eq!(sent[1]["method"], "Page.addScriptToEvaluateOnNewDocument");
        let source = sent[1]["params"]["source"]
            .as_str()
            .expect("serialized policy source");
        assert!(source.contains(r#""globalEnabled":false"#));
        assert!(source.contains(r#""youtubeEnabled":false"#));
        assert_eq!(registry.policies(tab_id), vec!["policy-1"]);
    }

    #[test]
    fn blocked_event_contains_no_browsing_url() {
        let event = PrivacyEvent::Blocked {
            tab_id: dive_core::TabId::new(),
            category: PrivacyCategory::Tracker,
        };
        let value = serde_json::to_value(event).expect("serialize privacy event");
        assert_eq!(value["type"], "blocked");
        assert!(value["data"].get("tab_id").is_some());
        assert_eq!(value["data"]["category"], "tracker");
        assert!(value["data"].get("url").is_none());
    }

    #[test]
    fn youtube_event_uses_the_product_name_on_the_wire() {
        let event = PrivacyEvent::YouTube {
            tab_id: dive_core::TabId::new(),
            count: 3,
        };
        let value = serde_json::to_value(event).expect("serialize privacy event");
        assert_eq!(value["type"], "youtube");
        assert_eq!(value["data"]["count"], 3);
    }

    #[test]
    fn hostname_anchor_subsumption_respects_subdomain_boundaries_and_options() {
        let parent = OwnedNetworkRule::parse("||openx.net/w/1.0/$third-party");

        assert!(parent.subsumes(&OwnedNetworkRule::parse("||u.openx.net/w/1.0/$third-party",)));
        assert!(parent.subsumes(&OwnedNetworkRule::parse(
            "||u.openx.net/w/1.0/sync$third-party,script",
        )));
        assert!(!parent.subsumes(&OwnedNetworkRule::parse(
            "||notopenx.net/w/1.0/$third-party",
        )));
        assert!(!parent.subsumes(&OwnedNetworkRule::parse("||u.openx.net/v/1.0/$third-party",)));
        assert!(!parent.subsumes(&OwnedNetworkRule::parse("||u.openx.net/w/1.0/",)));
        assert!(
            !OwnedNetworkRule::parse("||openx.net/w/1.0/$third-party,script")
                .subsumes(&OwnedNetworkRule::parse("||u.openx.net/w/1.0/$third-party",))
        );
    }

    #[derive(Debug)]
    struct OwnedNetworkRule<'a> {
        raw: &'a str,
        host: &'a str,
        path: &'a str,
        third_party: bool,
        resource_type: Option<&'a str>,
    }

    impl<'a> OwnedNetworkRule<'a> {
        fn parse(raw: &'a str) -> Self {
            let (pattern, options) = raw.split_once('$').unwrap_or((raw, ""));
            let pattern = pattern.strip_prefix("||").expect("hostname anchor");
            let (host, path) = pattern.split_once('/').unwrap_or((pattern, ""));
            let options = options.split(',').collect::<Vec<_>>();
            Self {
                raw,
                host,
                path,
                third_party: options.contains(&"third-party"),
                resource_type: options.iter().copied().find(|option| *option == "script"),
            }
        }

        fn subsumes(&self, other: &Self) -> bool {
            let host_matches = self.host == other.host
                || other
                    .host
                    .strip_suffix(self.host)
                    .is_some_and(|prefix| prefix.ends_with('.'));
            host_matches
                && other.path.starts_with(self.path)
                && (!self.third_party || other.third_party)
                && (self.resource_type.is_none() || self.resource_type == other.resource_type)
        }
    }
}
