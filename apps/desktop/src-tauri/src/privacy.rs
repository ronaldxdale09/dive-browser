use adblock::{Engine, FilterSet, lists::ParseOptions, request::Request};
use dive_cdp::{CdpEvent, CdpSession};
use dive_core::TabId;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::Runtime;

const ADS_RULES: &str = include_str!("../privacy/ads.txt");
const TRACKER_RULES: &str = include_str!("../privacy/trackers.txt");
const EXCEPTION_RULES: &str = include_str!("../privacy/exceptions.txt");
const COSMETIC_RULES: &str = include_str!("../privacy/cosmetic.json");
const YOUTUBE_SCRIPT: &str = include_str!("inject/youtube_privacy.js");
const _: &str = include_str!("../privacy/VERSION");
const PAGE_BINDING_PREFIX: &str = "__divePrivacy_";
const MAX_PAGE_EVENT: usize = 64;

/// Version of the rule assets bundled with this application.
pub const DIVE_PRIVACY_VERSION: &str = "2026.09.04.2";

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
    /// `YouTube` elements were removed from a document.
    #[serde(rename = "youtube")]
    YouTube {
        /// Tab whose document was cleaned.
        tab_id: TabId,
        /// Number of elements removed.
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
        ("Runtime.addBinding", json!({"name": binding})),
        ("Page.enable", json!({})),
        (
            "Page.addScriptToEvaluateOnNewDocument",
            json!({"source": source}),
        ),
        ("Runtime.evaluate", json!({"expression": source})),
    ] {
        if let Err(error) = session.call(method, params).await {
            tracing::debug!(%tab_id, %method, "DivePrivacy page setup failed open: {error}");
        }
    }

    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => {
                    if event.method == "Page.frameNavigated"
                        && event.params["frame"]["parentId"].is_null()
                        && let Some(document_url) = event.params["frame"]["url"].as_str()
                    {
                        let state = app.state::<crate::state::AppState>();
                        let prefs = state.prefs.get(&state);
                        apply_page(&session, &prefs, document_url).await;
                        continue;
                    }
                    if let Some(event) = map_binding_event(&event, &binding, tab_id)
                        && let Err(error) = event.emit(&app)
                    {
                        tracing::warn!(%tab_id, "privacy event emit failed: {error}");
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                    tracing::warn!(%tab_id, count, "DivePrivacy missed CDP events");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// Apply current preferences and the exact document host's cosmetic rules.
/// A malformed URL, rules asset, serialization error, or CDP failure is a
/// fail-open no-op (the injected script removes any previously applied CSS).
pub async fn apply_page(session: &CdpSession, prefs: &crate::prefs::Prefs, document_url: &str) {
    let configuration = page_configuration(prefs, document_url);
    let Ok(encoded) = serde_json::to_string(&configuration) else {
        tracing::debug!("could not serialize DivePrivacy page configuration");
        return;
    };
    let expression = format!("window.__divePrivacy?.configure({encoded})");
    if let Err(error) = session
        .call("Runtime.evaluate", json!({"expression": expression}))
        .await
    {
        tracing::debug!("DivePrivacy page configuration failed open: {error}");
    }
}

/// Decode the single bounded page-side intervention message shape.
#[must_use]
pub fn map_binding_event(event: &CdpEvent, binding: &str, tab_id: TabId) -> Option<PrivacyEvent> {
    if event.method != "Runtime.bindingCalled" || event.params["name"].as_str()? != binding {
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
    PageConfiguration {
        enabled: prefs.block_trackers && site_enabled && youtube_host && prefs.youtube_protection,
        cosmetic_css: if site_enabled && prefs.block_trackers {
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
                version: "2026.09.04.2".into(),
                ad_rules: 63,
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
    fn binding_events_accept_only_the_bounded_youtube_shape() {
        let tab_id = dive_core::TabId::new();
        let binding = "__divePrivacy_test";
        let event = dive_cdp::CdpEvent {
            method: "Runtime.bindingCalled".into(),
            params: serde_json::json!({
                "name": binding,
                "payload": r#"{"kind":"youtube","count":1}"#,
            }),
        };
        assert_eq!(
            map_binding_event(&event, binding, tab_id),
            Some(PrivacyEvent::YouTube { tab_id, count: 1 })
        );

        for payload in [
            r#"{"kind":"youtube","count":2}"#,
            r#"{"kind":"youtube","count":1,"url":"https://example.test"}"#,
            r#"{"kind":"other","count":1}"#,
            "not json",
        ] {
            let malformed = dive_cdp::CdpEvent {
                method: "Runtime.bindingCalled".into(),
                params: serde_json::json!({"name": binding, "payload": payload}),
            };
            assert_eq!(map_binding_event(&malformed, binding, tab_id), None);
        }

        let oversized = dive_cdp::CdpEvent {
            method: "Runtime.bindingCalled".into(),
            params: serde_json::json!({"name": binding, "payload": "x".repeat(65)}),
        };
        assert_eq!(map_binding_event(&oversized, binding, tab_id), None);
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
            self.host == other.host
                && other.path.starts_with(self.path)
                && (!self.third_party || other.third_party)
                && (self.resource_type.is_none() || self.resource_type == other.resource_type)
        }
    }
}
