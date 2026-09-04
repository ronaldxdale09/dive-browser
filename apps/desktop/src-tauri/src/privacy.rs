use adblock::{Engine, FilterSet, lists::ParseOptions, request::Request};

const ADS_RULES: &str = include_str!("../privacy/ads.txt");
const TRACKER_RULES: &str = include_str!("../privacy/trackers.txt");
const EXCEPTION_RULES: &str = include_str!("../privacy/exceptions.txt");
const _: &str = include_str!("../privacy/cosmetic.json");
const _: &str = include_str!("../privacy/VERSION");

/// Version of the rule assets bundled with this application.
pub const DIVE_PRIVACY_VERSION: &str = "2026.09.04.1";

/// Categories reported for network requests blocked by `DivePrivacy`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PrivacyCategory {
    /// Advertising delivery and auction infrastructure.
    Ads,
    /// Analytics, telemetry, fingerprinting, and cryptomining infrastructure.
    Tracker,
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
        if context.resource_type.eq_ignore_ascii_case("document") {
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
}
