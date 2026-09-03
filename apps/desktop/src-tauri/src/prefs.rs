//! User preferences: one JSON blob in the settings table, read on first use
//! and applied to the engine when a tab opens and whenever they change.
//!
//! Only settings this app can actually enforce live here. Appearance keys are
//! read by the chrome (theme, accent); the rest turn into `DevTools` calls,
//! the search template, the download directory or the agent's request.

use std::sync::Mutex;

use dive_cdp::CdpSession;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Key holding the JSON blob in the settings table.
const KEY: &str = "prefs";

/// Every preference, with the defaults a fresh profile starts on. Stored blobs
/// from older builds are merged with [`Prefs::default`] when they are loaded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[allow(clippy::struct_excessive_bools)] // These are independent user-facing toggles.
pub struct Prefs {
    /// Chrome theme: `system` | `dark` | `light`. Applied by the chrome.
    pub theme: String,
    /// Accent color as a CSS hex string. Applied by the chrome.
    pub accent: String,
    /// Force pages to see the chrome's color scheme. Ignored while the theme
    /// follows the system, since the host cannot read the OS setting.
    pub tell_pages_theme: bool,
    /// What opens at launch: `restore` the last tab, the `home` page, or
    /// `none` for the welcome screen.
    pub startup: String,
    /// Home page URL; empty means the welcome screen.
    pub homepage: String,
    /// Search engine key, or `custom` to use [`Prefs::search_template`].
    pub search_engine: String,
    /// Custom search URL with a `{query}` placeholder.
    pub search_template: String,
    /// Zoom factor new tabs open at.
    pub default_zoom: f64,
    /// Send `DNT: 1` and `Sec-GPC: 1` with every request.
    pub do_not_track: bool,
    /// Block the built-in list of tracker and ad hosts.
    pub block_trackers: bool,
    /// Extra hosts or URL globs to block, one per entry.
    pub blocked_patterns: Vec<String>,
    /// Run page scripts. Off makes every tab script-free.
    pub javascript: bool,
    /// Days of history to keep; `0` keeps it forever.
    pub history_days: i32,
    /// Directory downloads are written to; empty means `~/Downloads`.
    pub download_dir: String,
    /// Open `DevTools` for every new tab.
    pub devtools_on_open: bool,
    /// Workspace rail shows names and tab counts rather than marks alone.
    pub rail_expanded: bool,
    /// Model the agent sidecar talks to.
    pub agent_model: String,
    /// Let the agent act on a page without asking first.
    pub agent_auto_approve: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            accent: "#7FD8C8".into(),
            tell_pages_theme: false,
            startup: "restore".into(),
            homepage: String::new(),
            search_engine: "duckduckgo".into(),
            search_template: String::new(),
            default_zoom: 1.0,
            do_not_track: false,
            block_trackers: false,
            blocked_patterns: Vec::new(),
            javascript: true,
            history_days: 0,
            download_dir: String::new(),
            devtools_on_open: false,
            rail_expanded: true,
            agent_model: dive_agent::DEFAULT_MODEL.to_owned(),
            agent_auto_approve: false,
        }
    }
}

/// Search engines offered in Settings, as `(key, template)`.
pub const ENGINES: &[(&str, &str)] = &[
    ("duckduckgo", "https://duckduckgo.com/?q={query}"),
    ("google", "https://www.google.com/search?q={query}"),
    ("bing", "https://www.bing.com/search?q={query}"),
    ("brave", "https://search.brave.com/search?q={query}"),
    ("kagi", "https://kagi.com/search?q={query}"),
    (
        "startpage",
        "https://www.startpage.com/sp/search?query={query}",
    ),
];

/// Hosts blocked when "block trackers" is on. Deliberately short and
/// analytics-only: a developer browser must not silently break the site
/// under test, so CDN and consent hosts are left alone.
pub const TRACKERS: &[&str] = &[
    "*://*.doubleclick.net/*",
    "*://*.googlesyndication.com/*",
    "*://*.googletagmanager.com/*",
    "*://*.google-analytics.com/*",
    "*://*.analytics.google.com/*",
    "*://*.adservice.google.com/*",
    "*://*.facebook.net/*",
    "*://*.scorecardresearch.com/*",
    "*://*.hotjar.com/*",
    "*://*.mixpanel.com/*",
    "*://*.amplitude.com/*",
    "*://*.segment.io/*",
    "*://*.fullstory.com/*",
    "*://*.criteo.com/*",
    "*://*.taboola.com/*",
    "*://*.outbrain.com/*",
];

/// Largest number of custom block patterns kept.
const MAX_PATTERNS: usize = 200;
/// Zoom bounds new tabs may open at.
const ZOOM_RANGE: (f64, f64) = (0.25, 3.0);

impl Prefs {
    /// Fold out-of-range or malformed values back to something usable. Runs
    /// on write, so nothing downstream has to re-validate.
    #[allow(clippy::assigning_clones)] // Trimming in place would complicate Unicode boundaries.
    fn clamp(mut self) -> Self {
        let d = Self::default();
        if !matches!(self.theme.as_str(), "system" | "dark" | "light") {
            self.theme = d.theme;
        }
        if !is_hex_color(&self.accent) {
            self.accent = d.accent;
        }
        if !matches!(self.startup.as_str(), "restore" | "home" | "none") {
            self.startup = d.startup;
        }
        if self.search_engine != "custom"
            && !ENGINES.iter().any(|(key, _)| *key == self.search_engine)
        {
            self.search_engine = d.search_engine;
        }
        self.homepage = self.homepage.trim().to_owned();
        self.search_template = self.search_template.trim().to_owned();
        self.download_dir = self.download_dir.trim().to_owned();
        self.default_zoom = if self.default_zoom.is_finite() {
            self.default_zoom.clamp(ZOOM_RANGE.0, ZOOM_RANGE.1)
        } else {
            1.0
        };
        self.history_days = self.history_days.clamp(0, 3650);
        self.blocked_patterns = self
            .blocked_patterns
            .into_iter()
            .map(|p| p.trim().chars().take(200).collect::<String>())
            .filter(|p| !p.is_empty())
            .take(MAX_PATTERNS)
            .collect();
        if self.agent_model.trim().is_empty() {
            self.agent_model = d.agent_model;
        }
        self
    }

    /// The search URL template in force, with its `{query}` placeholder.
    pub fn search_template(&self) -> &str {
        if self.search_engine == "custom" && self.search_template.contains("{query}") {
            return &self.search_template;
        }
        ENGINES
            .iter()
            .find(|(key, _)| *key == self.search_engine)
            .map_or(ENGINES[0].1, |(_, template)| *template)
    }

    /// Where downloads are written.
    pub fn download_dir(&self) -> std::path::PathBuf {
        if self.download_dir.is_empty() {
            crate::engine::downloads_dir()
        } else {
            std::path::PathBuf::from(&self.download_dir)
        }
    }

    /// URL patterns the engine should refuse to load.
    pub fn blocked_urls(&self) -> Vec<String> {
        let custom = self.blocked_patterns.iter().map(|p| {
            // A bare host is the common case; widen it so it matches the
            // scheme and path the request actually carries.
            if p.contains('*') || p.contains('/') {
                p.clone()
            } else {
                format!("*{p}*")
            }
        });
        if self.block_trackers {
            TRACKERS
                .iter()
                .map(|s| (*s).to_owned())
                .chain(custom)
                .collect()
        } else {
            custom.collect()
        }
    }
}

fn is_hex_color(s: &str) -> bool {
    let body = s.strip_prefix('#').unwrap_or_default();
    matches!(body.len(), 3 | 6) && body.chars().all(|c| c.is_ascii_hexdigit())
}

/// Preferences held in memory, loaded from the store on first use.
#[derive(Default)]
pub struct Registry {
    cached: Mutex<Option<Prefs>>,
}

impl Registry {
    /// Current preferences, reading the store the first time.
    pub fn get(&self, state: &AppState) -> Prefs {
        if let Some(prefs) = crate::state::lock(&self.cached).clone() {
            return prefs;
        }
        let stored = crate::state::lock(&state.store)
            .setting(KEY)
            .ok()
            .flatten()
            .and_then(|json| parse_stored(&json).ok())
            .unwrap_or_default();
        crate::state::lock(&self.cached)
            .get_or_insert(stored)
            .clone()
    }

    /// Persist `prefs` and return them as stored (clamped).
    pub fn set(&self, state: &AppState, prefs: Prefs) -> AppResult<Prefs> {
        let prefs = prefs.clamp();
        let json = serde_json::to_string(&prefs).map_err(AppError::new)?;
        crate::state::lock(&state.store).set_setting(KEY, &json)?;
        *crate::state::lock(&self.cached) = Some(prefs.clone());
        Ok(prefs)
    }
}

fn parse_stored(json: &str) -> serde_json::Result<Prefs> {
    let mut complete = serde_json::to_value(Prefs::default())?;
    let incoming: Value = serde_json::from_str(json)?;
    let (Some(complete), Some(incoming)) = (complete.as_object_mut(), incoming.as_object()) else {
        return serde_json::from_value(incoming);
    };
    complete.extend(incoming.clone());
    serde_json::from_value(Value::Object(complete.clone()))
}

/// The `DevTools` calls that put `prefs` into force on one tab.
///
/// The emulated color scheme is only sent when the user asked for it, so a
/// preference write never clobbers a per-tab override from the device menu.
pub fn calls(prefs: &Prefs) -> Vec<(&'static str, Value)> {
    let headers = if prefs.do_not_track {
        json!({"DNT": "1", "Sec-GPC": "1"})
    } else {
        json!({})
    };
    let mut calls = vec![
        ("Network.setExtraHTTPHeaders", json!({"headers": headers})),
        (
            "Network.setBlockedURLs",
            json!({"urls": prefs.blocked_urls()}),
        ),
        (
            "Emulation.setScriptExecutionDisabled",
            json!({"value": !prefs.javascript}),
        ),
    ];
    if prefs.tell_pages_theme && prefs.theme != "system" {
        calls.push((
            "Emulation.setEmulatedMedia",
            json!({"features": [{"name": "prefers-color-scheme", "value": prefs.theme}]}),
        ));
    }
    calls
}

/// Apply `prefs` to one tab's session. Failures are logged, not fatal: a tab
/// that has just closed must not fail a settings write.
pub async fn apply(session: &CdpSession, prefs: &Prefs) {
    for (method, params) in calls(prefs) {
        if let Err(e) = session.call(method, params).await {
            tracing::debug!("{method} failed: {e}");
        }
    }
}

/// What [`clear`] should delete.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[allow(clippy::struct_excessive_bools)] // Each field is an independent clear-data checkbox.
pub struct ClearRequest {
    /// Visited pages.
    pub history: bool,
    /// Cookies of every profile with an open tab.
    pub cookies: bool,
    /// HTTP cache.
    pub cache: bool,
    /// `localStorage`, `sessionStorage`, `IndexedDB` and friends for the
    /// origins of open tabs.
    pub site_data: bool,
}

/// Delete the requested browsing data and describe what went.
///
/// Cookies, cache and site data are cleared through the open tabs' `DevTools`
/// sessions, so a profile with no tab open keeps its data; the returned
/// summary says so rather than pretending otherwise.
pub async fn clear(state: &AppState, what: ClearRequest) -> AppResult<String> {
    let mut done: Vec<String> = Vec::new();
    if what.history {
        let n = crate::state::lock(&state.store).clear_history()?;
        done.push(format!("history ({n})"));
    }
    let sessions: Vec<(String, CdpSession)> = {
        let host = crate::state::lock(&state.host);
        let store = crate::state::lock(&state.store);
        host.as_ref().map_or_else(Vec::new, |host| {
            host.sessions()
                .into_iter()
                .map(|(id, session)| {
                    let url = store.tab(id).map(|t| t.url).unwrap_or_default();
                    (url, session)
                })
                .collect()
        })
    };
    if sessions.is_empty() && (what.cookies || what.cache || what.site_data) {
        done.push("nothing else (no tab open)".into());
        return Ok(summary(&done));
    }
    for (url, session) in &sessions {
        if what.cookies {
            let _ = session.call0("Network.clearBrowserCookies").await;
        }
        if what.cache {
            let _ = session.call0("Network.clearBrowserCache").await;
        }
        if what.site_data
            && let Some(origin) = origin_of(url)
        {
            let _ = session
                .call(
                    "Storage.clearDataForOrigin",
                    json!({"origin": origin, "storageTypes": "all"}),
                )
                .await;
        }
    }
    if what.cookies {
        done.push("cookies".into());
    }
    if what.cache {
        done.push("cache".into());
    }
    if what.site_data {
        done.push("site data".into());
    }
    Ok(summary(&done))
}

fn origin_of(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let origin = parsed.origin();
    origin.is_tuple().then(|| origin.ascii_serialization())
}

fn summary(done: &[String]) -> String {
    if done.is_empty() {
        "Nothing selected".to_owned()
    } else {
        format!("Cleared {}", done.join(", "))
    }
}

/// Drop visits older than the retention window; no-op when history is kept
/// forever. Returns how many rows went.
pub fn prune_history(state: &AppState) -> AppResult<usize> {
    let days = state.prefs.get(state).history_days;
    if days <= 0 {
        return Ok(0);
    }
    let cutoff = dive_core::Timestamp::now() - time::Duration::days(i64::from(days));
    Ok(crate::state::lock(&state.store).prune_history(cutoff)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_survive_a_partial_blob() {
        let prefs = parse_stored(r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(prefs.theme, "dark");
        assert_eq!(prefs.search_engine, "duckduckgo");
        assert!(prefs.javascript);
    }

    #[test]
    fn clamp_rejects_nonsense() {
        let prefs = Prefs {
            theme: "neon".into(),
            accent: "red".into(),
            startup: "whatever".into(),
            search_engine: "askjeeves".into(),
            default_zoom: 99.0,
            history_days: -5,
            blocked_patterns: vec!["  ads.dev ".into(), "   ".into()],
            agent_model: "  ".into(),
            ..Prefs::default()
        }
        .clamp();
        assert_eq!(prefs.theme, "system");
        assert_eq!(prefs.accent, Prefs::default().accent);
        assert_eq!(prefs.startup, "restore");
        assert_eq!(prefs.search_engine, "duckduckgo");
        assert!((prefs.default_zoom - 3.0).abs() < f64::EPSILON);
        assert_eq!(prefs.history_days, 0);
        assert_eq!(prefs.blocked_patterns, vec!["ads.dev".to_owned()]);
        assert_eq!(prefs.agent_model, dive_agent::DEFAULT_MODEL);
    }

    #[test]
    fn search_template_falls_back_to_a_known_engine() {
        let mut prefs = Prefs::default();
        assert!(
            prefs
                .search_template()
                .starts_with("https://duckduckgo.com/")
        );
        prefs.search_engine = "google".into();
        assert!(prefs.search_template().contains("google.com/search"));
        prefs.search_engine = "custom".into();
        prefs.search_template = "https://s.dev/find".into();
        assert!(
            prefs.search_template().contains("duckduckgo"),
            "a custom template without {{query}} is unusable"
        );
        prefs.search_template = "https://s.dev/find?q={query}".into();
        assert_eq!(prefs.search_template(), "https://s.dev/find?q={query}");
    }

    #[test]
    fn blocked_urls_widen_bare_hosts() {
        let prefs = Prefs {
            block_trackers: false,
            blocked_patterns: vec!["ads.dev".into(), "*://x.dev/track*".into()],
            ..Prefs::default()
        };
        assert_eq!(
            prefs.blocked_urls(),
            vec!["*ads.dev*".to_owned(), "*://x.dev/track*".to_owned()]
        );
        let blocking = Prefs {
            block_trackers: true,
            ..prefs
        };
        assert_eq!(blocking.blocked_urls().len(), TRACKERS.len() + 2);
    }

    #[test]
    fn calls_cover_headers_blocking_and_scripts() {
        let prefs = Prefs {
            do_not_track: true,
            javascript: false,
            theme: "dark".into(),
            tell_pages_theme: true,
            ..Prefs::default()
        };
        let sent = calls(&prefs);
        assert_eq!(sent[0].1["headers"]["DNT"], "1");
        assert_eq!(sent[2].1["value"], true);
        assert_eq!(sent[3].0, "Emulation.setEmulatedMedia");
        // Following the system theme leaves the page's scheme alone.
        let system = Prefs {
            tell_pages_theme: true,
            ..Prefs::default()
        };
        assert_eq!(calls(&system).len(), 3);
        assert_eq!(calls(&system)[0].1["headers"], json!({}));
    }
}
