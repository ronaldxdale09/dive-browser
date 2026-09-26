//! User preferences: one JSON blob in the settings table, read on first use
//! and applied to the engine when a tab opens and whenever they change.
//!
//! Only settings this app can actually enforce live here. Appearance keys are
//! read by the chrome (theme, accent); the rest turn into `DevTools` calls,
//! the search template, the download directory or the agent's request.

use std::sync::{Arc, Mutex};

use dive_cdp::CdpSession;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;

use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// Key holding the JSON blob in the settings table.
pub(crate) const KEY: &str = "prefs";

/// A site pinned at the top of the rail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct QuickLink {
    /// Short label under the icon.
    pub name: String,
    /// Where it goes; `http` or `https` only.
    pub url: String,
}

/// The most a rail can pin before it stops being quick.
pub const MAX_QUICK_LINKS: usize = 12;

fn default_quick_links() -> Vec<QuickLink> {
    [
        ("ChatGPT", "https://chatgpt.com/"),
        ("Claude", "https://claude.ai/"),
        ("Gemini", "https://gemini.google.com/"),
    ]
    .into_iter()
    .map(|(name, url)| QuickLink {
        name: name.into(),
        url: url.into(),
    })
    .collect()
}

/// Trim, drop links without a web address or a name, and cap the count.
/// A name longer than a rail row is cut rather than refused.
fn normalize_quick_links(links: Vec<QuickLink>) -> Vec<QuickLink> {
    let mut seen = std::collections::HashSet::new();
    links
        .into_iter()
        .map(|l| QuickLink {
            name: l.name.trim().chars().take(24).collect(),
            url: l.url.trim().to_owned(),
        })
        .filter(|l| {
            !l.name.is_empty()
                && (l.url.starts_with("https://") || l.url.starts_with("http://"))
                && url::Url::parse(&l.url).is_ok_and(|u| u.host_str().is_some())
                && seen.insert(l.url.clone())
        })
        .take(MAX_QUICK_LINKS)
        .collect()
}

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
    /// Sites pinned at the top of the rail: a click switches to their tab or
    /// opens one. Starts as the three assistants people reach for most.
    #[serde(default = "default_quick_links")]
    pub quick_links: Vec<QuickLink>,
    /// Provider the agent talks to; a `dive_agent::Provider` id.
    pub agent_provider: String,
    /// Model the agent talks to, in the provider's naming.
    pub agent_model: String,
    /// Reasoning depth: `default` | `low` | `medium` | `high` | `max`.
    pub agent_reasoning: String,
    /// Most tool calls one message may make before the run is stopped.
    pub agent_max_steps: i32,
    /// Legacy "act without asking" switch, kept only so an existing profile
    /// can be carried over: [`Prefs::clamp`] turns it into
    /// `agent_approvals = "never"` and clears it.
    #[serde(default)]
    pub agent_auto_approve: bool,
    /// When the agent stops to ask before acting: `every` action, only the
    /// ones that look costly (`risk`), or `never`.
    #[serde(default = "default_agent_approvals")]
    pub agent_approvals: String,
    /// Send the current tab's title, URL, console and text with each message.
    pub agent_include_page: bool,
    /// Base URL of the custom OpenAI-compatible endpoint.
    pub agent_custom_base_url: String,
    /// Ask for every page over https, and stop rather than fall back.
    /// Loopback, private addresses and the development top-level domains are
    /// never upgraded: see [`crate::https_only`].
    #[serde(default)]
    pub https_only: bool,
    /// Hosts the person chose to keep reaching in the clear.
    #[serde(default)]
    pub https_only_allowed: Vec<String>,
    /// How DNS is resolved: `system` | `automatic` | `secure`. Applied at the
    /// next launch, because Chromium reads it once when it starts.
    #[serde(default = "default_dns_mode")]
    pub dns_mode: String,
    /// Which resolver: a name from `netconfig::DNS_PROVIDERS`, or `custom`.
    #[serde(default = "default_dns_provider")]
    pub dns_provider: String,
    /// The `DoH` template used when `dns_provider` is `custom`.
    #[serde(default)]
    pub dns_template: String,
    /// Where requests go: `system` | `direct` | `manual` | `pac`.
    #[serde(default = "default_proxy_mode")]
    pub proxy_mode: String,
    /// `host:port` for the manual proxy.
    #[serde(default)]
    pub proxy_server: String,
    /// The PAC script's address.
    #[serde(default)]
    pub proxy_pac_url: String,
    /// Hosts that skip the proxy, comma separated.
    #[serde(default)]
    pub proxy_bypass: String,
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
    /// Offer a hover control that fills the tab with a video, without
    /// leaving the window.
    #[serde(default = "default_true")]
    pub video_fill_tab: bool,
    /// Ask the search engine to complete what is typed in the address bar.
    /// Every keystroke goes to the engine while this is on, so it is a
    /// preference; a private session never asks, whatever it says.
    #[serde(default = "default_true")]
    pub search_suggestions: bool,
    /// Sites allowed to open another app without asking again, written as
    /// `host|scheme` ("claude.ai|claude"). One entry allows one site to open
    /// one scheme; see [`crate::external_link`].
    #[serde(default)]
    pub external_link_allowed: Vec<String>,
    /// Whether the first-run intro and onboarding have been completed.
    /// False only on a fresh install: a stored file that predates the field
    /// belongs to someone who has been using Dive already, so
    /// [`parse_stored`] treats its absence as done.
    #[serde(default = "default_true")]
    pub onboarded: bool,
}

fn default_true() -> bool {
    true
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

/// Ask about the steps that look costly, and let the rest run. Asking about
/// everything is what makes people turn approvals off.
fn default_agent_approvals() -> String {
    "risk".into()
}

/// A preference trimmed and capped, so nothing arrives at the engine longer
/// than it should be.
fn trimmed(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

/// The system resolver, which is what every other browser starts on.
fn default_dns_mode() -> String {
    "system".into()
}

fn default_dns_provider() -> String {
    "cloudflare".into()
}

fn default_proxy_mode() -> String {
    "system".into()
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
            search_engine: default_search_engine(),
            search_template: String::new(),
            default_zoom: 1.0,
            do_not_track: false,
            block_trackers: false,
            blocked_patterns: Vec::new(),
            youtube_protection: default_youtube_protection(),
            privacy_exceptions: Vec::new(),
            search_suggestions: true,
            external_link_allowed: Vec::new(),
            javascript: true,
            history_days: 0,
            download_dir: String::new(),
            devtools_on_open: false,
            rail_expanded: true,
            quick_links: default_quick_links(),
            agent_provider: dive_agent::Provider::Anthropic.id_str().to_owned(),
            agent_model: dive_agent::DEFAULT_MODEL.to_owned(),
            agent_reasoning: "default".into(),
            agent_max_steps: 25,
            agent_auto_approve: false,
            agent_approvals: default_agent_approvals(),
            agent_include_page: true,
            agent_custom_base_url: String::new(),
            https_only: false,
            https_only_allowed: Vec::new(),
            dns_mode: default_dns_mode(),
            dns_provider: default_dns_provider(),
            dns_template: String::new(),
            proxy_mode: default_proxy_mode(),
            proxy_server: String::new(),
            proxy_pac_url: String::new(),
            proxy_bypass: String::new(),
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
            video_fill_tab: true,
            onboarded: false,
        }
    }
}

/// The engine a fresh profile searches with.
fn default_search_engine() -> String {
    "google".into()
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
/// Longest history retention window, in days: ten years.
const MAX_HISTORY_DAYS: i32 = 3650;

impl Prefs {
    /// Fold out-of-range or malformed values back to something usable. Runs
    /// on write, so nothing downstream has to re-validate.
    #[allow(clippy::assigning_clones)] // Trimming in place would complicate Unicode boundaries.
    fn clamp(mut self) -> Self {
        let d = Self::default();
        self = self.clamp_agent(&d);
        self = self.clamp_network(&d);
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
        self = self.clamp_ranges();
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
        self.blocked_patterns = self
            .blocked_patterns
            .into_iter()
            .map(|p| p.trim().chars().take(200).collect::<String>())
            .filter(|p| !p.is_empty())
            .take(MAX_PATTERNS)
            .collect();
        self.privacy_exceptions = normalize_privacy_exceptions(self.privacy_exceptions);
        self.external_link_allowed = normalize_external_link_allowed(self.external_link_allowed);
        self.quick_links = normalize_quick_links(self.quick_links);
        if !matches!(self.preferred_editor.as_str(), "vscode" | "cursor" | "zed") {
            self.preferred_editor = d.preferred_editor;
        }
        self
    }

    /// Bring every number back inside the range the code that uses it was
    /// written for. Kept apart from [`Self::clamp`] because it also runs on
    /// the stored blob: a hand-edited or restored file with a history window
    /// of two billion days otherwise reaches date arithmetic that panics.
    fn clamp_ranges(mut self) -> Self {
        self.ui_scale = if self.ui_scale.is_finite() {
            (self.ui_scale.clamp(UI_SCALE_RANGE.0, UI_SCALE_RANGE.1) * 100.0).round() / 100.0
        } else {
            default_ui_scale()
        };
        self.default_zoom = if self.default_zoom.is_finite() {
            self.default_zoom.clamp(ZOOM_RANGE.0, ZOOM_RANGE.1)
        } else {
            1.0
        };
        self.history_days = self.history_days.clamp(0, MAX_HISTORY_DAYS);
        self.agent_max_steps = self.agent_max_steps.clamp(1, 200);
        self
    }

    /// Where traffic goes. Anything the engine would not accept is put back
    /// to the default here rather than left to be dropped silently at launch,
    /// so the settings screen and the running browser agree.
    fn clamp_network(mut self, d: &Self) -> Self {
        if !crate::netconfig::DNS_MODES.contains(&self.dns_mode.as_str()) {
            self.dns_mode.clone_from(&d.dns_mode);
        }
        let known = crate::netconfig::DNS_PROVIDERS
            .iter()
            .any(|(name, _)| *name == self.dns_provider);
        if !known && self.dns_provider != "custom" {
            self.dns_provider.clone_from(&d.dns_provider);
        }
        if !crate::netconfig::PROXY_MODES.contains(&self.proxy_mode.as_str()) {
            self.proxy_mode.clone_from(&d.proxy_mode);
        }
        self.https_only_allowed =
            crate::https_only::normalize_allowed(std::mem::take(&mut self.https_only_allowed));
        self.dns_template = trimmed(&self.dns_template, 512);
        self.proxy_server = trimmed(&self.proxy_server, 255);
        self.proxy_pac_url = trimmed(&self.proxy_pac_url, 512);
        self.proxy_bypass = trimmed(&self.proxy_bypass, 1024);
        self
    }

    /// The network settings as the next launch will read them.
    pub fn network(&self) -> crate::netconfig::NetworkConfig {
        crate::netconfig::NetworkConfig {
            dns_mode: self.dns_mode.clone(),
            dns_provider: self.dns_provider.clone(),
            dns_template: self.dns_template.clone(),
            proxy_mode: self.proxy_mode.clone(),
            proxy_server: self.proxy_server.clone(),
            proxy_pac_url: self.proxy_pac_url.clone(),
            proxy_bypass: self.proxy_bypass.clone(),
        }
    }

    /// The agent's own settings, kept together because they constrain each
    /// other: the model has to belong to the provider, and the approval mode
    /// has to absorb the boolean it replaced.
    fn clamp_agent(mut self, d: &Self) -> Self {
        let provider = if let Some(provider) = dive_agent::Provider::parse(&self.agent_provider) {
            provider
        } else {
            self.agent_provider.clone_from(&d.agent_provider);
            dive_agent::Provider::Anthropic
        };
        self.agent_model = self.agent_model.trim().chars().take(256).collect();
        if self.agent_model.is_empty() {
            // The provider's own default, so switching providers never
            // leaves a model name from another provider's naming behind.
            self.agent_model = provider.info().default_model;
        }
        let effort = dive_agent::Effort::parse(&self.agent_reasoning);
        effort.as_str().clone_into(&mut self.agent_reasoning);
        if !matches!(self.agent_approvals.as_str(), "every" | "risk" | "never") {
            self.agent_approvals.clone_from(&d.agent_approvals);
        }
        // A profile saved before approvals had modes said "act without
        // asking" with a boolean. Carry the person's answer across once,
        // then stop reading it.
        if self.agent_auto_approve {
            self.agent_approvals = "never".into();
            self.agent_auto_approve = false;
        }
        self.agent_custom_base_url = self
            .agent_custom_base_url
            .trim()
            .trim_end_matches('/')
            .chars()
            .take(2048)
            .collect();
        self
    }

    /// The search URL template in force, with its `{query}` placeholder.
    pub fn search_template(&self) -> &str {
        if self.search_engine == "custom" && self.search_template.contains("{query}") {
            return &self.search_template;
        }
        // Falling back to whatever sits first in the table would make the
        // list's order a second, silent definition of the default; they drift
        // the moment one of them changes. The fallback is the default engine
        // by name, and the table is free to be in whatever order reads best.
        let template = |engine: &str| {
            ENGINES
                .iter()
                .find(|(key, _)| *key == engine)
                .map(|(_, template)| *template)
        };
        template(&self.search_engine)
            .or_else(|| template(&default_search_engine()))
            .unwrap_or(ENGINES[0].1)
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
        self.privacy_enabled_for_host(crate::rules::document_host_of(document_url).as_deref())
    }

    /// [`privacy_enabled_for`](Self::privacy_enabled_for) for a host the
    /// caller already parsed; `None` (no host) means protection applies.
    pub fn privacy_enabled_for_host(&self, host: Option<&str>) -> bool {
        let Some(host) = host else {
            return true;
        };
        !self
            .privacy_exceptions
            .iter()
            .any(|exception| exception == host)
    }
}

/// Keep only well-formed `host|scheme` allowances, deduplicated and bounded.
/// Anything else -- a bare host, an empty scheme, something hand-edited into
/// the file -- is dropped rather than silently allowing more than it names.
pub fn normalize_external_link_allowed(allowed: Vec<String>) -> Vec<String> {
    let mut normalized = allowed
        .into_iter()
        .filter(|entry| {
            let Some((host, scheme)) = entry.split_once('|') else {
                return false;
            };
            !host.is_empty()
                && !scheme.is_empty()
                && host.len() <= 255
                && scheme.len() <= 64
                && !entry.chars().any(char::is_whitespace)
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        })
        .collect::<Vec<_>>();
    normalized.sort_unstable();
    normalized.dedup();
    normalized.truncate(MAX_PATTERNS);
    normalized
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
///
/// The cached value sits behind an `Arc` so hot paths (one call per paused
/// request) can take a [`Registry::snapshot`] without deep-cloning the
/// pattern lists; [`Registry::set`] swaps the `Arc` rather than mutating it.
#[derive(Default)]
pub struct Registry {
    cached: Mutex<Option<Arc<Prefs>>>,
    updates: tokio::sync::Mutex<()>,
    /// The scheme the chrome is drawn in ("dark" | "light"), reported by the
    /// chrome once it has resolved template, mode and the OS. Pages are told
    /// this, never the raw mode, so a light-only template with the mode on
    /// System still gives pages a light scheme.
    chrome_scheme: Mutex<Option<String>>,
}

impl Registry {
    /// The scheme the chrome is drawn in, once it has said.
    pub fn chrome_scheme(&self) -> Option<String> {
        self.chrome_scheme
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Record the chrome's scheme. Returns whether it changed.
    pub fn set_chrome_scheme(&self, scheme: &str) -> bool {
        let mut slot = self
            .chrome_scheme
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if slot.as_deref() == Some(scheme) {
            return false;
        }
        *slot = Some(scheme.to_owned());
        true
    }

    /// Enter one complete persist-and-apply preference transaction. Commands
    /// keep this guard until every live tab has seen the stored snapshot, so
    /// an older request can never apply after a newer request.
    pub async fn begin_update(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.updates.lock().await
    }

    /// Current preferences, reading the store the first time.
    pub fn get(&self, state: &AppState) -> Prefs {
        self.snapshot(state).as_ref().clone()
    }

    /// A shared snapshot of the current preferences, reading the store the
    /// first time. Cheap to take per request.
    pub fn snapshot(&self, state: &AppState) -> Arc<Prefs> {
        if let Some(prefs) = crate::state::lock(&self.cached).as_ref() {
            return Arc::clone(prefs);
        }
        let stored = crate::state::lock(&state.store)
            .setting(KEY)
            .ok()
            .flatten()
            .map_or_else(fresh_profile_prefs, |json| parse_stored(&json));
        let prefs =
            Arc::clone(crate::state::lock(&self.cached).get_or_insert_with(|| Arc::new(stored)));
        // The first read is also where the navigation path's mirror is
        // seeded: without this the setting only takes effect once something
        // saves preferences, which from the person's side is never.
        crate::https_only::apply_settings(prefs.https_only, &prefs.https_only_allowed);
        prefs
    }

    /// Persist `prefs` and return them as stored (clamped).
    pub fn set(&self, state: &AppState, prefs: Prefs) -> AppResult<Prefs> {
        let prefs = prefs.clamp();
        // The engine reads its switches once at launch, before the database
        // is open, so the network settings are mirrored beside the profile as
        // they are saved. A mirror that fails to write is worth a line in the
        // log, not a refused preference change.
        crate::https_only::apply_settings(prefs.https_only, &prefs.https_only_allowed);
        if let Err(error) = crate::netconfig::save(&prefs.network()) {
            tracing::warn!(%error, "could not mirror the network settings for the next launch");
        }
        let json = serde_json::to_string(&prefs).map_err(AppError::new)?;
        crate::state::lock(&state.store).set_setting(KEY, &json)?;
        *crate::state::lock(&self.cached) = Some(Arc::new(prefs.clone()));
        Ok(prefs)
    }
}

/// Defaults for a profile that has never stored preferences. Disposable
/// probe profiles set `DIVE_SKIP_ONBOARDING=1` so the first-run flow does
/// not cover the page they are about to drive.
fn fresh_profile_prefs() -> Prefs {
    fresh_profile_prefs_with(std::env::var_os("DIVE_SKIP_ONBOARDING").is_some_and(|v| v == "1"))
}

fn fresh_profile_prefs_with(skip_onboarding: bool) -> Prefs {
    Prefs {
        onboarded: skip_onboarding,
        ..Prefs::default()
    }
}

/// Rebuild preferences from a stored blob, field by field.
///
/// Known keys are folded into the defaults one at a time; a field the current
/// build cannot read (a renamed value, a wrong type, a hand-edited file) is
/// logged and left at its default instead of throwing every other preference
/// away. The next [`Registry::set`] would otherwise persist that reset.
///
/// A blob that is not a JSON object at all yields the defaults.
pub(crate) fn parse_stored(json: &str) -> Prefs {
    let incoming: Value = match serde_json::from_str(json) {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!("stored preferences are not JSON; using defaults: {error}");
            return Prefs::default();
        }
    };
    let Some(incoming) = incoming.as_object() else {
        tracing::warn!("stored preferences are not an object; using defaults");
        return Prefs::default();
    };
    let Ok(Value::Object(mut merged)) = serde_json::to_value(Prefs::default()) else {
        return Prefs::default();
    };
    // A preferences file exists, so this is not a first launch: someone who
    // upgraded past the onboarding must not be walked through it.
    if !incoming.contains_key("onboarded") {
        merged.insert("onboarded".into(), Value::Bool(true));
    }
    let mut prefs = Prefs::default();
    for (key, value) in incoming {
        if !merged.contains_key(key) {
            // A key from a newer or older build: nothing to fold it into.
            continue;
        }
        let previous = merged.insert(key.clone(), value.clone());
        match serde_json::from_value::<Prefs>(Value::Object(merged.clone())) {
            Ok(parsed) => prefs = parsed,
            Err(error) => {
                tracing::warn!(
                    key,
                    "stored preference rejected; keeping its default: {error}"
                );
                if let Some(previous) = previous {
                    merged.insert(key.clone(), previous);
                }
            }
        }
    }
    prefs.privacy_exceptions = normalize_privacy_exceptions(prefs.privacy_exceptions);
    prefs.external_link_allowed = normalize_external_link_allowed(prefs.external_link_allowed);
    // Only the numbers: the full clamp would also rewrite text fields a
    // stored profile has always been allowed to keep as it wrote them.
    prefs.clamp_ranges()
}

/// The `DevTools` calls that put `prefs` into force on one tab.
///
/// The emulated color scheme is only sent when the user asked for it, so a
/// preference write never clobbers a per-tab override from the device menu.
/// `chrome_scheme` is what the chrome is actually drawn in; without it the
/// explicit mode is the best guess and System says nothing.
pub fn calls(prefs: &Prefs, chrome_scheme: Option<&str>) -> Vec<(&'static str, Value)> {
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
    let scheme =
        chrome_scheme.or_else(|| (prefs.theme != "system").then_some(prefs.theme.as_str()));
    if prefs.tell_pages_theme
        && let Some(scheme) = scheme
    {
        calls.push((
            "Emulation.setEmulatedMedia",
            json!({"features": [{"name": "prefers-color-scheme", "value": scheme}]}),
        ));
    }
    calls
}

/// Apply `prefs` to one tab's session. Failures are logged, not fatal: a tab
/// that has just closed must not fail a settings write.
pub async fn apply(session: &CdpSession, prefs: &Prefs, chrome_scheme: Option<&str>) {
    for (method, params) in calls(prefs, chrome_scheme) {
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
    /// Form entries remembered in the active profile.
    #[serde(default)]
    pub forms: bool,
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
        forms: left.forms || right.forms,
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

/// Finish deferred profile cleanup before CEF opens or locks profile files.
///
/// Each target is moved into the trash rather than deleted here: this runs
/// on the launch path, and deleting a cache of thousands of files held the
/// window back for as long as that took. The trash is emptied in the
/// background once the store is open.
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
    let trash = crate::state::trash_root();
    for name in &pending.profiles {
        let profile = safe_profile(&root, name)?;
        for target in component_targets(&profile, pending.what) {
            crate::state::discard_path(&target, &trash).map_err(AppError::new)?;
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
        let store = crate::state::lock(&state.store);
        let n = store.clear_history()?;
        store.clear_favicons()?;
        drop(store);
        done.push(counted(n, "history entry", "history entries"));
    }
    if what.forms {
        let store = crate::state::lock(&state.store);
        let active = *crate::state::lock(&state.active_workspace);
        let profile = active
            .and_then(|id| store.workspace(id).ok())
            .map(|w| w.profile_id)
            .or_else(|| store.profiles().ok()?.into_iter().next().map(|p| p.id));
        if let Some(profile) = profile {
            let n = store.clear_form_entries(profile)?;
            done.push(counted(n, "form entry", "form entries"));
        }
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
            "{} Restart Dive to finish the profiles that were not open.",
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

/// "3 history entries", "1 form entry": the count first, as a person would say it.
fn counted(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// "Cleared 3 history entries, cookies and cache." — a sentence, not a list dump.
fn summary(done: &[String]) -> String {
    match done {
        [] => "Nothing selected.".to_owned(),
        [only] => format!("Cleared {only}."),
        [head @ .., last] => format!("Cleared {} and {last}.", head.join(", ")),
    }
}

/// Drop visits older than the retention window, in every profile; no-op
/// when history is kept forever. Returns how many rows went.
pub fn prune_history(state: &AppState) -> AppResult<usize> {
    let days = state.prefs.snapshot(state).history_days;
    if days <= 0 {
        return Ok(0);
    }
    // Clamped on the way in, and checked here as well: a window reaching
    // past the calendar's first year panics in a plain subtraction.
    let days = i64::from(days.min(MAX_HISTORY_DAYS));
    let Some(cutoff) = dive_core::Timestamp::now()
        .0
        .checked_sub(time::Duration::days(days))
    else {
        return Ok(0);
    };
    Ok(crate::state::lock(&state.store).prune_history(dive_core::Timestamp(cutoff))?)
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
                forms: false,
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
            forms: false,
        };
        let second = ClearRequest {
            history: false,
            cookies: true,
            cache: false,
            site_data: true,
            forms: false,
        };
        assert_eq!(
            merge_clear(first, second),
            ClearRequest {
                history: true,
                cookies: true,
                cache: true,
                site_data: true,
                forms: false,
            }
        );
    }

    #[test]
    fn defaults_survive_a_partial_blob() {
        let prefs = parse_stored(r#"{"theme":"dark"}"#);
        assert_eq!(prefs.theme, "dark");
        assert_eq!(prefs.search_engine, "google");
        assert!(prefs.javascript);
    }

    #[test]
    fn one_malformed_field_keeps_every_other_preference() {
        // `default_zoom` is a number; a string there used to throw the whole
        // blob away and the next write persisted a full reset.
        let prefs = parse_stored(
            r#"{"theme":"dark","search_engine":"bing","default_zoom":"big","javascript":false,"history_days":"forever"}"#,
        );
        assert_eq!(prefs.theme, "dark");
        assert_eq!(prefs.search_engine, "bing");
        assert!(!prefs.javascript);
        let defaults = Prefs::default();
        assert!((prefs.default_zoom - defaults.default_zoom).abs() < f64::EPSILON);
        assert_eq!(prefs.history_days, defaults.history_days);
        // Unknown keys and junk that is not an object fall back cleanly too.
        assert_eq!(parse_stored(r#"{"theme":"dark","future":1}"#).theme, "dark");
        assert_eq!(parse_stored("[1,2]"), Prefs::default());
        assert_eq!(parse_stored("not json"), Prefs::default());
    }

    #[test]
    fn a_stored_number_out_of_range_is_brought_back_in() {
        let prefs = parse_stored(
            r#"{"history_days":2147483647,"default_zoom":1e300,"ui_scale":-4,"agent_max_steps":0}"#,
        );
        assert_eq!(prefs.history_days, MAX_HISTORY_DAYS);
        assert!((prefs.default_zoom - ZOOM_RANGE.1).abs() < f64::EPSILON);
        assert!((prefs.ui_scale - UI_SCALE_RANGE.0).abs() < f64::EPSILON);
        assert_eq!(prefs.agent_max_steps, 1);
        // The window that comes out is one the calendar can subtract.
        let days = time::Duration::days(i64::from(prefs.history_days));
        assert!(dive_core::Timestamp::now().0.checked_sub(days).is_some());
    }

    #[test]
    fn old_profiles_receive_diveprivacy_defaults() {
        let prefs = parse_stored(r#"{"block_trackers":true,"blocked_patterns":["ads.test"]}"#);
        assert!(prefs.block_trackers);
        assert_eq!(prefs.blocked_patterns, vec!["ads.test"]);
        assert!(prefs.youtube_protection);
        assert!(prefs.privacy_exceptions.is_empty());
    }

    #[test]
    fn stored_exceptions_are_normalized_without_clamping_legacy_preferences() {
        let prefs = parse_stored(
            r#"{"block_trackers":true,"blocked_patterns":["  ads.test ","   "],"privacy_exceptions":["com","Example.COM.","https://bad.test/path"]}"#,
        );
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
    fn the_old_act_without_asking_switch_becomes_the_never_mode_once() {
        let carried = Prefs {
            agent_auto_approve: true,
            ..Prefs::default()
        }
        .clamp();
        assert_eq!(carried.agent_approvals, "never");
        // Cleared, so the next save does not keep overriding a later choice.
        assert!(!carried.agent_auto_approve);
        let back = Prefs {
            agent_approvals: "every".into(),
            ..carried
        }
        .clamp();
        assert_eq!(back.agent_approvals, "every");
    }

    #[test]
    fn network_settings_the_engine_would_not_accept_go_back_to_the_default() {
        let prefs = Prefs {
            dns_mode: "encrypted-ish".into(),
            dns_provider: "my-isp".into(),
            proxy_mode: "socks".into(),
            proxy_server: "  10.0.0.2:8080  ".into(),
            ..Prefs::default()
        }
        .clamp();
        assert_eq!(prefs.dns_mode, "system");
        assert_eq!(prefs.dns_provider, "cloudflare");
        assert_eq!(prefs.proxy_mode, "system");
        assert_eq!(prefs.proxy_server, "10.0.0.2:8080");

        // A custom resolver is a real choice and survives.
        let custom = Prefs {
            dns_mode: "secure".into(),
            dns_provider: "custom".into(),
            dns_template: "https://dns.example/dns-query".into(),
            ..Prefs::default()
        }
        .clamp();
        assert_eq!(custom.dns_provider, "custom");
        assert_eq!(crate::netconfig::flags(&custom.network()).len(), 3);
    }

    #[test]
    fn an_unknown_approval_mode_falls_back_to_the_default() {
        let prefs = Prefs {
            agent_approvals: "sometimes".into(),
            ..Prefs::default()
        }
        .clamp();
        assert_eq!(prefs.agent_approvals, "risk");
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
        assert_eq!(prefs.search_engine, "google");
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
                .starts_with("https://www.google.com/")
        );
        prefs.search_engine = "duckduckgo".into();
        assert!(prefs.search_template().contains("duckduckgo.com"));
        prefs.search_engine = "custom".into();
        prefs.search_template = "https://s.dev/find".into();
        assert!(
            prefs.search_template().contains("google.com"),
            "a custom template without {{query}} is unusable"
        );
        prefs.search_template = "https://s.dev/find?q={query}".into();
        assert_eq!(prefs.search_template(), "https://s.dev/find?q={query}");
    }

    #[test]
    fn cleared_summary_reads_as_a_sentence() {
        assert_eq!(super::summary(&[]), "Nothing selected.");
        assert_eq!(super::summary(&["cookies".to_owned()]), "Cleared cookies.");
        assert_eq!(
            super::summary(&[
                super::counted(3, "history entry", "history entries"),
                "cookies".to_owned(),
                "cache".to_owned()
            ]),
            "Cleared 3 history entries, cookies and cache."
        );
        assert_eq!(
            super::counted(1, "form entry", "form entries"),
            "1 form entry"
        );
    }

    #[test]
    fn onboarding_is_pending_only_on_a_fresh_install() {
        assert!(!Prefs::default().onboarded);
        assert!(!fresh_profile_prefs_with(false).onboarded);
        // A throwaway probe profile can opt out, and only of the flow.
        let probe = fresh_profile_prefs_with(true);
        assert!(probe.onboarded);
        assert_eq!(
            Prefs {
                onboarded: false,
                ..probe
            },
            Prefs::default()
        );
        assert!(parse_stored(r#"{"theme":"dark"}"#).onboarded);
        assert!(!parse_stored(r#"{"onboarded":false}"#).onboarded);
        assert!(parse_stored(r#"{"onboarded":true}"#).onboarded);
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
        let sent = calls(&prefs, None);
        assert_eq!(sent[0].1["headers"]["DNT"], "1");
        assert_eq!(sent[2].1["value"], true);
        assert_eq!(sent[3].0, "Emulation.setEmulatedMedia");
        assert_eq!(sent[3].1["features"][0]["value"], "dark");
        // Following the system theme says nothing until the chrome reports
        // what it is drawn in; then pages get that, whatever the mode.
        let system = Prefs {
            tell_pages_theme: true,
            ..Prefs::default()
        };
        assert_eq!(calls(&system, None).len(), 3);
        assert_eq!(calls(&system, None)[0].1["headers"], json!({}));
        let told = calls(&system, Some("light"));
        assert_eq!(told[3].1["features"][0]["value"], "light");
        // A light-only template under a dark mode: the chrome's word wins.
        assert_eq!(
            calls(&prefs, Some("light"))[3].1["features"][0]["value"],
            "light"
        );
        // Nobody asked: nothing is sent even when the chrome has reported.
        assert_eq!(calls(&Prefs::default(), Some("light")).len(), 3);
    }

    #[test]
    fn appearance_fields_default_and_clamp() {
        let prefs = parse_stored(r#"{"theme":"dark"}"#);
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

#[cfg(test)]
mod quick_link_tests {
    use super::*;

    #[test]
    fn quick_links_start_as_the_three_assistants_and_are_cleaned_on_save() {
        assert_eq!(
            Prefs::default()
                .quick_links
                .iter()
                .map(|l| l.name.as_str())
                .collect::<Vec<_>>(),
            ["ChatGPT", "Claude", "Gemini"]
        );
        let cleaned = normalize_quick_links(vec![
            QuickLink {
                name: "  Linear ".into(),
                url: " https://linear.app/ ".into(),
            },
            QuickLink {
                name: String::new(),
                url: "https://nameless.test/".into(),
            },
            QuickLink {
                name: "File".into(),
                url: "file:///etc/passwd".into(),
            },
            QuickLink {
                name: "Again".into(),
                url: "https://linear.app/".into(),
            },
        ]);
        assert_eq!(cleaned.len(), 1);
        assert_eq!(cleaned[0].name, "Linear");
        assert_eq!(cleaned[0].url, "https://linear.app/");
    }

    #[test]
    fn an_older_blob_without_quick_links_gets_the_defaults() {
        let loaded: Prefs = serde_json::from_value(
            serde_json::to_value(Prefs::default())
                .map(|mut v| {
                    v.as_object_mut().unwrap().remove("quick_links");
                    v
                })
                .unwrap(),
        )
        .unwrap();
        assert_eq!(loaded.quick_links.len(), 3);
    }
}
