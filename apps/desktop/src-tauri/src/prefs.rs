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
use crate::state::{AppState, lock};

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
    /// What opens at launch: the `home` page, `restore` for the tab the last
    /// session ended on, or `none` for the welcome screen. A `home` start with
    /// no homepage set is the welcome screen.
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
    /// Apply narrow `YouTube` privacy interventions when `DivePrivacy` is active.
    #[serde(default = "default_youtube_protection")]
    pub youtube_protection: bool,
    /// Exact document hosts where `DivePrivacy` is disabled.
    #[serde(default)]
    pub privacy_exceptions: Vec<String>,
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
    /// Provider the agent talks to; a `dive_agent::Provider` id.
    pub agent_provider: String,
    /// Model the agent talks to, in the provider's naming.
    pub agent_model: String,
    /// Reasoning depth: `default` | `low` | `medium` | `high` | `max`.
    pub agent_reasoning: String,
    /// Most tool calls one message may make before the run is stopped.
    pub agent_max_steps: i32,
    /// Let the agent act on a page without asking first.
    pub agent_auto_approve: bool,
    /// Send the current tab's title, URL, console and text with each message.
    pub agent_include_page: bool,
    /// Base URL of the custom OpenAI-compatible endpoint.
    pub agent_custom_base_url: String,
    /// Preferred code editor for Jump-to-Source: `vscode` | `cursor` | `zed`.
    #[serde(default = "default_editor")]
    pub preferred_editor: String,
    /// Chrome palette template; one of [`APPEARANCE_PRESETS`] or `custom`.
    #[serde(default = "default_preset")]
    pub appearance_preset: String,
    /// Custom template seed: the ground (window) colour as CSS hex.
    #[serde(default = "default_custom_ground")]
    pub custom_ground: String,
    /// Custom template seed: the text colour as CSS hex.
    #[serde(default = "default_custom_ink")]
    pub custom_ink: String,
    /// Custom template seed: the highlight colour as CSS hex.
    #[serde(default = "default_custom_highlight")]
    pub custom_highlight: String,
    /// Chrome typeface: `geist` | `system` | `mono` | `serif`.
    #[serde(default = "default_ui_font")]
    pub ui_font: String,
    /// Chrome size multiplier, 0.8 to 1.3; everything in the chrome scales.
    #[serde(default = "default_ui_scale")]
    pub ui_scale: f64,
    /// Row heights and gaps: `compact` | `comfortable` | `relaxed`.
    #[serde(default = "default_density")]
    pub density: String,
    /// Corner rounding of chrome controls: `sharp` | `soft` | `round`.
    #[serde(default = "default_radius")]
    pub corner_radius: String,
    /// Tab strip look: `pill` | `flat`.
    #[serde(default = "default_tab_style")]
    pub tab_style: String,
    /// Chrome motion: follow the `system`, `reduce`, or always `full`.
    #[serde(default = "default_motion")]
    pub motion: String,
    /// Welcome screen backdrop: `orbs` | `plain` | `gradient`.
    #[serde(default = "default_welcome_background")]
    pub welcome_background: String,
}

/// Built-in palette templates the chrome knows how to draw.
pub const APPEARANCE_PRESETS: &[&str] = &[
    "graphite", "midnight", "paper", "sepia", "forest", "ocean", "rose", "custom",
];
/// Chrome typefaces that ship with the app or come from the OS.
pub const UI_FONTS: &[&str] = &["geist", "system", "mono", "serif"];
/// Chrome scale bounds.
pub const UI_SCALE_RANGE: (f64, f64) = (0.8, 1.3);

fn default_preset() -> String {
    "graphite".into()
}
fn default_custom_ground() -> String {
    "#111111".into()
}
fn default_custom_ink() -> String {
    "#ECECEC".into()
}
fn default_custom_highlight() -> String {
    "#7FD8C8".into()
}
fn default_ui_font() -> String {
    "geist".into()
}
fn default_ui_scale() -> f64 {
    1.0
}
fn default_density() -> String {
    "comfortable".into()
}
fn default_radius() -> String {
    "round".into()
}
fn default_tab_style() -> String {
    "pill".into()
}
fn default_motion() -> String {
    "system".into()
}
fn default_welcome_background() -> String {
    "orbs".into()
}

fn default_editor() -> String {
    "vscode".into()
}

fn default_youtube_protection() -> bool {
    true
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            accent: "#7FD8C8".into(),
            tell_pages_theme: false,
            startup: "home".into(),
            homepage: String::new(),
            search_engine: "duckduckgo".into(),
            search_template: String::new(),
            default_zoom: 1.0,
            do_not_track: false,
            block_trackers: false,
            blocked_patterns: Vec::new(),
            youtube_protection: default_youtube_protection(),
            privacy_exceptions: Vec::new(),
            javascript: true,
            history_days: 0,
            download_dir: String::new(),
            devtools_on_open: false,
            rail_expanded: true,
            agent_provider: dive_agent::Provider::Anthropic.id_str().to_owned(),
            agent_model: dive_agent::DEFAULT_MODEL.to_owned(),
            agent_reasoning: "default".into(),
            agent_max_steps: 25,
            agent_auto_approve: false,
            agent_include_page: true,
            agent_custom_base_url: String::new(),
            preferred_editor: default_editor(),
            appearance_preset: default_preset(),
            custom_ground: default_custom_ground(),
            custom_ink: default_custom_ink(),
            custom_highlight: default_custom_highlight(),
            ui_font: default_ui_font(),
            ui_scale: default_ui_scale(),
            density: default_density(),
            corner_radius: default_radius(),
            tab_style: default_tab_style(),
            motion: default_motion(),
            welcome_background: default_welcome_background(),
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
        if !APPEARANCE_PRESETS.contains(&self.appearance_preset.as_str()) {
            self.appearance_preset = d.appearance_preset;
        }
        if !is_hex_color(&self.custom_ground) {
            self.custom_ground = d.custom_ground;
        }
        if !is_hex_color(&self.custom_ink) {
            self.custom_ink = d.custom_ink;
        }
        if !is_hex_color(&self.custom_highlight) {
            self.custom_highlight = d.custom_highlight;
        }
        if !UI_FONTS.contains(&self.ui_font.as_str()) {
            self.ui_font = d.ui_font;
        }
        self.ui_scale = if self.ui_scale.is_finite() {
            (self.ui_scale.clamp(UI_SCALE_RANGE.0, UI_SCALE_RANGE.1) * 100.0).round() / 100.0
        } else {
            d.ui_scale
        };
        if !matches!(self.density.as_str(), "compact" | "comfortable" | "relaxed") {
            self.density = d.density;
        }
        if !matches!(self.corner_radius.as_str(), "sharp" | "soft" | "round") {
            self.corner_radius = d.corner_radius;
        }
        if !matches!(self.tab_style.as_str(), "pill" | "flat") {
            self.tab_style = d.tab_style;
        }
        if !matches!(self.motion.as_str(), "system" | "reduce" | "full") {
            self.motion = d.motion;
        }
        if !matches!(
            self.welcome_background.as_str(),
            "orbs" | "plain" | "gradient"
        ) {
            self.welcome_background = d.welcome_background;
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
        self.privacy_exceptions = normalize_privacy_exceptions(self.privacy_exceptions);
        let provider = if let Some(provider) = dive_agent::Provider::parse(&self.agent_provider) {
            provider
        } else {
            self.agent_provider = d.agent_provider;
            dive_agent::Provider::Anthropic
        };
        self.agent_model = self.agent_model.trim().chars().take(256).collect();
        if self.agent_model.is_empty() {
            // The provider's own default, so switching providers never
            // leaves a model name from another provider's naming behind.
            self.agent_model = provider.info().default_model;
        }
        self.agent_reasoning = dive_agent::Effort::parse(&self.agent_reasoning)
            .as_str()
            .to_owned();
        self.agent_max_steps = self.agent_max_steps.clamp(1, 200);
        self.agent_custom_base_url = self
            .agent_custom_base_url
            .trim()
            .trim_end_matches('/')
            .chars()
            .take(2048)
            .collect();
        if !matches!(self.preferred_editor.as_str(), "vscode" | "cursor" | "zed") {
            self.preferred_editor = d.preferred_editor;
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
        self.blocked_patterns
            .iter()
            .map(|p| {
                // A bare host is the common case; widen it so it matches the
                // scheme and path the request actually carries.
                if p.contains('*') || p.contains('/') {
                    p.clone()
                } else {
                    format!("*{p}*")
                }
            })
            .collect()
    }

    /// Whether `DivePrivacy` applies to this document URL.
    pub fn privacy_enabled_for(&self, document_url: &str) -> bool {
        let Some(host) = url::Url::parse(document_url).ok().and_then(|url| {
            url.host().map(|host| match host {
                url::Host::Domain(host) => host.trim_end_matches('.').to_ascii_lowercase(),
                url::Host::Ipv4(host) => host.to_string(),
                url::Host::Ipv6(host) => format!("[{host}]"),
            })
        }) else {
            return true;
        };
        !self
            .privacy_exceptions
            .iter()
            .any(|exception| exception == &host)
    }
}

/// Keep only exact, registrable hostnames or IP literals suitable for disabling `DivePrivacy`.
pub fn normalize_privacy_exceptions(exceptions: Vec<String>) -> Vec<String> {
    let mut normalized = exceptions
        .into_iter()
        .filter_map(|exception| {
            if exception.is_empty()
                || exception.chars().any(char::is_whitespace)
                || exception.contains(['/', '*', '?', '#', '@'])
            {
                return None;
            }
            let host = exception.strip_suffix('.').unwrap_or(&exception);
            if let Some(ipv6) = host
                .strip_prefix('[')
                .and_then(|host| host.strip_suffix(']'))
                .and_then(|host| host.parse::<std::net::Ipv6Addr>().ok())
            {
                return Some(format!("[{ipv6}]"));
            }
            if let Ok(ipv4) = host.parse::<std::net::Ipv4Addr>() {
                return Some(ipv4.to_string());
            }
            if let Ok(ipv6) = host.parse::<std::net::Ipv6Addr>() {
                return Some(format!("[{ipv6}]"));
            }
            if host.is_empty()
                || host.contains([':', '[', ']'])
                || host.split('.').any(str::is_empty)
            {
                return None;
            }
            let url::Host::Domain(host) = url::Host::parse(host).ok()? else {
                return None;
            };
            if psl::suffix(host.as_bytes())
                .is_some_and(|suffix| suffix.is_known() && suffix.as_bytes() == host.as_bytes())
            {
                return None;
            }
            Some(host)
        })
        .collect::<Vec<_>>();
    normalized.sort_unstable();
    normalized.dedup();
    normalized.truncate(MAX_PATTERNS);
    normalized
}

fn is_hex_color(s: &str) -> bool {
    let body = s.strip_prefix('#').unwrap_or_default();
    matches!(body.len(), 3 | 6) && body.chars().all(|c| c.is_ascii_hexdigit())
}

/// Preferences held in memory, loaded from the store on first use.
#[derive(Default)]
pub struct Registry {
    cached: Mutex<Option<Prefs>>,
    updates: tokio::sync::Mutex<()>,
}

impl Registry {
    /// Enter one complete persist-and-apply preference transaction. Commands
    /// keep this guard until every live tab has seen the stored snapshot, so
    /// an older request can never apply after a newer request.
    pub async fn begin_update(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.updates.lock().await
    }

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
    let mut prefs: Prefs = if let (Some(complete), Some(incoming)) =
        (complete.as_object_mut(), incoming.as_object())
    {
        complete.extend(incoming.clone());
        serde_json::from_value(Value::Object(complete.clone()))?
    } else {
        serde_json::from_value(incoming)?
    };
    prefs.privacy_exceptions = normalize_privacy_exceptions(prefs.privacy_exceptions);
    Ok(prefs)
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingClear {
    profiles: Vec<String>,
    what: ClearRequest,
}

fn pending_clear_path() -> std::path::PathBuf {
    crate::state::data_root().join("pending-browser-data-clear.json")
}

fn merge_clear(left: ClearRequest, right: ClearRequest) -> ClearRequest {
    ClearRequest {
        history: left.history || right.history,
        cookies: left.cookies || right.cookies,
        cache: left.cache || right.cache,
        site_data: left.site_data || right.site_data,
    }
}

fn safe_profile(root: &std::path::Path, name: &str) -> AppResult<std::path::PathBuf> {
    let path = std::path::Path::new(name);
    if path.components().count() != 1
        || !matches!(
            path.components().next(),
            Some(std::path::Component::Normal(_))
        )
    {
        return Err(AppError::new("invalid browser profile path"));
    }
    Ok(root.join(path))
}

fn component_targets(profile: &std::path::Path, what: ClearRequest) -> Vec<std::path::PathBuf> {
    let mut targets = Vec::new();
    if what.cookies {
        for relative in [
            "Cookies",
            "Cookies-journal",
            "Network/Cookies",
            "Network/Cookies-journal",
        ] {
            targets.push(profile.join(relative));
        }
    }
    if what.cache {
        for relative in [
            "Cache",
            "Code Cache",
            "GPUCache",
            "Network Cache",
            "Network/Cache",
            "Shared Dictionary",
            "Service Worker/CacheStorage",
        ] {
            targets.push(profile.join(relative));
        }
    }
    if what.site_data {
        for relative in [
            "Local Storage",
            "Session Storage",
            "WebStorage",
            "IndexedDB",
            "CacheStorage",
            "File System",
            "blob_storage",
            "databases",
            "QuotaManager",
            "QuotaManager-journal",
            "Service Worker",
        ] {
            targets.push(profile.join(relative));
        }
    }
    targets.sort();
    targets.dedup();
    targets
}

fn remove_target(path: &std::path::Path) -> AppResult<()> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        std::fs::remove_dir_all(path).map_err(AppError::new)
    } else {
        std::fs::remove_file(path).map_err(AppError::new)
    }
}

/// Finish deferred profile cleanup before CEF opens or locks profile files.
pub fn finish_pending_clear() -> AppResult<()> {
    let pending_path = pending_clear_path();
    if !pending_path.exists() {
        return Ok(());
    }
    let pending: PendingClear = serde_json::from_slice(
        &std::fs::read(&pending_path).map_err(AppError::new)?,
    )
    .map_err(|error| AppError::new(format!("invalid pending browser-data cleanup: {error}")))?;
    let root = crate::state::profiles_root();
    for name in &pending.profiles {
        let profile = safe_profile(&root, name)?;
        for target in component_targets(&profile, pending.what) {
            remove_target(&target)?;
        }
    }
    std::fs::remove_file(pending_path).map_err(AppError::new)
}

fn queue_profile_clear(profiles: &[String], what: ClearRequest) -> AppResult<()> {
    let path = pending_clear_path();
    let existing = if path.exists() {
        serde_json::from_slice::<PendingClear>(&std::fs::read(&path).map_err(AppError::new)?).ok()
    } else {
        None
    };
    let mut profiles = existing.as_ref().map_or(profiles.to_owned(), |pending| {
        let mut names = pending.profiles.clone();
        names.extend_from_slice(profiles);
        names
    });
    profiles.sort();
    profiles.dedup();
    let what = existing.map_or(what, |pending| merge_clear(pending.what, what));
    let pending = PendingClear { profiles, what };
    let tmp = path.with_extension("json.tmp");
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(&pending).map_err(AppError::new)?,
    )
    .map_err(AppError::new)?;
    std::fs::rename(tmp, path).map_err(AppError::new)
}

/// Delete the requested browsing data and describe what went.
///
/// Open profiles clear immediately through Chromium; a component cleanup is
/// also queued for the next launch before CEF locks persistent profile files.
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
            let mut profiles = std::collections::HashMap::new();
            for (id, session) in host.sessions() {
                let Ok(tab) = store.tab(id) else { continue };
                let Some(workspace) = tab
                    .workspace_id
                    .and_then(|workspace| store.workspace(workspace).ok())
                else {
                    continue;
                };
                profiles
                    .entry(workspace.container_id)
                    .or_insert((tab.url, session));
            }
            profiles.into_values().collect()
        })
    };
    let mut first_error = None;
    for (url, session) in &sessions {
        if what.cookies
            && let Err(error) = session.call0("Network.clearBrowserCookies").await
        {
            first_error.get_or_insert(error);
        }
        if what.cache
            && let Err(error) = session.call0("Network.clearBrowserCache").await
        {
            first_error.get_or_insert(error);
        }
        if what.site_data
            && let Some(origin) = origin_of(url)
            && let Err(error) = session
                .call(
                    "Storage.clearDataForOrigin",
                    json!({"origin": origin, "storageTypes": "all"}),
                )
                .await
        {
            first_error.get_or_insert(error);
        }
    }
    if let Some(error) = first_error {
        return Err(AppError::new(format!(
            "Chromium could not clear browser data: {error}"
        )));
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
    if what.cookies || what.cache || what.site_data {
        let profiles: Vec<String> = lock(&state.store)
            .containers()?
            .into_iter()
            .map(|container| container.cache_dir)
            .collect();
        queue_profile_clear(&profiles, what)?;
        Ok(format!(
            "{}; restart Dive to finish every profile",
            summary(&done)
        ))
    } else {
        Ok(summary(&done))
    }
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
    fn profile_cleanup_is_scoped_and_selection_specific() {
        let root = std::path::Path::new("/profiles");
        assert_eq!(
            safe_profile(root, "container-good").unwrap(),
            root.join("container-good")
        );
        assert!(safe_profile(root, "../outside").is_err());
        assert!(safe_profile(root, "/absolute").is_err());
        let targets = component_targets(
            &root.join("container-good"),
            ClearRequest {
                history: false,
                cookies: true,
                cache: false,
                site_data: false,
            },
        );
        assert!(targets.iter().any(|path| path.ends_with("Network/Cookies")));
        assert!(!targets.iter().any(|path| path.ends_with("IndexedDB")));
    }

    #[test]
    fn pending_clear_selections_only_grow() {
        let first = ClearRequest {
            history: true,
            cookies: false,
            cache: true,
            site_data: false,
        };
        let second = ClearRequest {
            history: false,
            cookies: true,
            cache: false,
            site_data: true,
        };
        assert_eq!(
            merge_clear(first, second),
            ClearRequest {
                history: true,
                cookies: true,
                cache: true,
                site_data: true
            }
        );
    }

    #[test]
    fn defaults_survive_a_partial_blob() {
        let prefs = parse_stored(r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(prefs.theme, "dark");
        assert_eq!(prefs.search_engine, "duckduckgo");
        assert!(prefs.javascript);
    }

    #[test]
    fn old_profiles_receive_diveprivacy_defaults() {
        let prefs =
            parse_stored(r#"{"block_trackers":true,"blocked_patterns":["ads.test"]}"#).unwrap();
        assert!(prefs.block_trackers);
        assert_eq!(prefs.blocked_patterns, vec!["ads.test"]);
        assert!(prefs.youtube_protection);
        assert!(prefs.privacy_exceptions.is_empty());
    }

    #[test]
    fn stored_exceptions_are_normalized_without_clamping_legacy_preferences() {
        let prefs = parse_stored(
            r#"{"block_trackers":true,"blocked_patterns":["  ads.test ","   "],"privacy_exceptions":["com","Example.COM.","https://bad.test/path"]}"#,
        )
        .unwrap();
        assert!(prefs.block_trackers);
        assert_eq!(prefs.blocked_patterns, vec!["  ads.test ", "   "]);
        assert_eq!(prefs.privacy_exceptions, vec!["example.com"]);
        assert!(prefs.privacy_enabled_for("https://com/path"));
        assert!(!prefs.privacy_enabled_for("https://example.com/path"));
    }

    #[test]
    fn privacy_exceptions_are_exact_hosts() {
        let prefs = Prefs {
            privacy_exceptions: vec![
                "Example.COM.".into(),
                "https://bad.test/path".into(),
                "*.wide.test".into(),
                "example.com".into(),
            ],
            ..Prefs::default()
        }
        .clamp();
        assert_eq!(prefs.privacy_exceptions, vec!["example.com"]);
        assert!(!prefs.privacy_enabled_for("https://example.com/page"));
        assert!(prefs.privacy_enabled_for("https://sub.example.com/page"));
    }

    #[test]
    fn privacy_exceptions_accept_exact_ip_literals() {
        let normalized = normalize_privacy_exceptions(vec![
            "127.0.0.1".into(),
            "[2001:0DB8:0:0::1]".into(),
            "2001:db8::2".into(),
        ]);

        assert_eq!(
            normalized,
            vec!["127.0.0.1", "[2001:db8::1]", "[2001:db8::2]"]
        );
        let prefs = Prefs {
            privacy_exceptions: normalized,
            ..Prefs::default()
        };
        assert!(!prefs.privacy_enabled_for("http://127.0.0.1:4173/fixture"));
        assert!(!prefs.privacy_enabled_for("https://[2001:db8::1]/page"));
        assert!(!prefs.privacy_enabled_for("https://[2001:db8::2]/page"));
        assert!(prefs.privacy_enabled_for("http://127.0.0.2:4173/fixture"));
    }

    #[test]
    fn privacy_exceptions_reject_broad_hosts_and_cap_the_list() {
        let mut exceptions = vec![
            "com".into(),
            "co.uk".into(),
            "has whitespace.test".into(),
            "double..label.test".into(),
        ];
        exceptions.extend((0..201).map(|index| format!("site{index}.test")));
        let normalized = normalize_privacy_exceptions(exceptions);
        assert_eq!(normalized.len(), 200);
        assert!(!normalized.iter().any(|host| {
            matches!(
                host.as_str(),
                "com" | "co.uk" | "has whitespace.test" | "double..label.test"
            )
        }));
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
            preferred_editor: "notepad".into(),
            ..Prefs::default()
        }
        .clamp();
        assert_eq!(prefs.theme, "system");
        assert_eq!(prefs.accent, Prefs::default().accent);
        assert_eq!(prefs.startup, Prefs::default().startup);
        assert_eq!(prefs.search_engine, "duckduckgo");
        assert!((prefs.default_zoom - 3.0).abs() < f64::EPSILON);
        assert_eq!(prefs.history_days, 0);
        assert_eq!(prefs.blocked_patterns, vec!["ads.dev".to_owned()]);
        assert_eq!(prefs.agent_model, dive_agent::DEFAULT_MODEL);
        assert_eq!(prefs.preferred_editor, "vscode");
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
        let expected = prefs.blocked_urls();
        let blocking = Prefs {
            block_trackers: true,
            ..prefs
        };
        assert_eq!(blocking.blocked_urls(), expected);
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

    #[test]
    fn appearance_fields_default_and_clamp() {
        let prefs = parse_stored(r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(prefs.appearance_preset, "graphite");
        assert!((prefs.ui_scale - 1.0).abs() < f64::EPSILON);
        let wild = Prefs {
            appearance_preset: "neon".into(),
            custom_ground: "not-a-colour".into(),
            ui_font: "comic".into(),
            ui_scale: 9.0,
            density: "cramped".into(),
            corner_radius: "square".into(),
            tab_style: "tabs".into(),
            motion: "lots".into(),
            welcome_background: "video".into(),
            ..Prefs::default()
        }
        .clamp();
        let d = Prefs::default();
        assert_eq!(wild.appearance_preset, d.appearance_preset);
        assert_eq!(wild.custom_ground, d.custom_ground);
        assert_eq!(wild.ui_font, d.ui_font);
        assert!((wild.ui_scale - UI_SCALE_RANGE.1).abs() < f64::EPSILON);
        assert_eq!(wild.density, d.density);
        assert_eq!(wild.corner_radius, d.corner_radius);
        assert_eq!(wild.tab_style, d.tab_style);
        assert_eq!(wild.motion, d.motion);
        assert_eq!(wild.welcome_background, d.welcome_background);
        let fine = Prefs {
            appearance_preset: "custom".into(),
            custom_ground: "#0b0f14".into(),
            ui_scale: 1.126,
            ..Prefs::default()
        }
        .clamp();
        assert_eq!(fine.appearance_preset, "custom");
        assert_eq!(fine.custom_ground, "#0b0f14");
        assert!((fine.ui_scale - 1.13).abs() < 1e-9);
    }

    #[tokio::test]
    async fn preference_update_transactions_enter_in_request_order() {
        let registry = std::sync::Arc::new(Registry::default());
        let first = registry.begin_update().await;
        let second_registry = std::sync::Arc::clone(&registry);
        let (attempting_tx, attempting_rx) = tokio::sync::oneshot::channel();
        let (entered_tx, mut entered_rx) = tokio::sync::oneshot::channel();
        let second = tokio::spawn(async move {
            let _ = attempting_tx.send(());
            let _guard = second_registry.begin_update().await;
            let _ = entered_tx.send(());
        });

        attempting_rx.await.expect("second transaction started");
        assert!(
            matches!(
                entered_rx.try_recv(),
                Err(tokio::sync::oneshot::error::TryRecvError::Empty)
            ),
            "the second persist-and-apply transaction entered before the first completed",
        );
        drop(first);
        entered_rx.await.expect("second transaction entered");
        second.await.expect("second transaction task");
    }
}
