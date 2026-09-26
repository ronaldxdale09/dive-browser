//! Links that belong to another app.
//!
//! `claude://`, `zoom://`, `slack://`, `mailto:` -- a page navigating to a
//! scheme the engine does not speak used to end at Chromium's
//! `ERR_UNKNOWN_URL_SCHEME` page, which is how a Google sign-in that hands
//! back to a desktop app dead-ended in Dive.
//!
//! Such a navigation is cancelled and the person is asked instead: this is the
//! one place where a page can start another program, so it never happens on
//! the page's say-so alone. Saying yes hands the URL to the system; ticking
//! "always" records the site and scheme so the same site stops asking.
//!
//! The URL itself never crosses into the chrome's control: the card answers
//! with a token, and the host opens what that token stands for.
//!
//! A few schemes are never handed over, asked or not (see `BLOCKED`), and a
//! site that was told no waits a moment before it may ask again.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use dive_core::TabId;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::Runtime;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Schemes the engine loads itself; everything else belongs to another app.
/// `javascript` and `data` are deliberately absent: they are not another
/// app's, and handing them to the system would be worse than dropping them.
const INTERNAL: &[&str] = &[
    "http",
    "https",
    "about",
    "blob",
    "data",
    "file",
    "javascript",
    "devtools",
    "chrome",
    "chrome-error",
    "chrome-extension",
    "chrome-untrusted",
    "view-source",
    "ws",
    "wss",
    "dive",
];

/// Schemes a page never gets to hand to the system, whatever the person
/// answers. They mount a network share (`smb:`, `afp:`, `nfs:`, `ftp:` and
/// `WebDAV` all end in a Finder or Explorer mount), connect to a remote screen
/// (`vnc:`), or open system settings, search or diagnostic tools with
/// arguments of the page's choosing -- the shapes attacks from web pages have
/// taken on both systems -- and no sign-in or meeting link needs any of them.
const BLOCKED: &[&str] = &[
    "smb",
    "afp",
    "nfs",
    "cifs",
    "ftp",
    "ftps",
    "dav",
    "davs",
    "webdav",
    "webdavs",
    "vnc",
    "x-apple.systempreferences",
    "x-apple-helpbasic",
    "help",
    "applescript",
    "ms-settings",
    "ms-msdt",
    "ms-officecmd",
    "search",
    "search-ms",
];

/// The longest URL worth showing or opening.
const MAX_URL: usize = 4096;

/// How long a site that was told no waits before it may ask again. A page
/// that navigates to the link in a loop otherwise raised the card again the
/// instant it was cancelled, and the person could never get back to the page.
const COOLDOWN: Duration = Duration::from_secs(5);

/// What the chrome asks the person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct ExternalLinkAsked {
    pub tab_id: TabId,
    /// Handle for answering; the URL stays in the host.
    pub token: String,
    /// The app the system would open, when it could be named ("Claude").
    pub app: Option<String>,
    /// The scheme being opened, without the colon ("claude").
    pub scheme: String,
    /// Where the link points, as far as the card says: `scheme://host`, or
    /// `scheme:` for a link with no host (`mailto:`). The rest of the URL can
    /// carry codes and tokens and stays in the host.
    pub target: String,
    /// The site that asked, as a host ("claude.ai"); empty when there is none.
    pub origin: String,
}

/// A question no window needs to show any more: answered, let go, or
/// replaced by a newer one from the same tab. Every window hears it, so a
/// card answered in a torn-off tab's window does not linger in the main
/// window's store and come back when the tab does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct ExternalLinkClosed {
    pub tab_id: TabId,
    pub token: String,
}

struct Pending {
    tab_id: TabId,
    url: String,
    scheme: String,
    origin: String,
}

static PENDING: Mutex<Option<HashMap<String, Pending>>> = Mutex::new(None);

/// Who was told no, and until when they may not ask again.
static REFUSED: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

fn with_pending<T>(f: impl FnOnce(&mut HashMap<String, Pending>) -> T) -> T {
    let mut guard = PENDING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    f(guard.get_or_insert_with(HashMap::new))
}

fn with_refused<T>(f: impl FnOnce(&mut HashMap<String, Instant>) -> T) -> T {
    let mut guard = REFUSED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    f(guard.get_or_insert_with(HashMap::new))
}

/// Whether this URL is another app's to open.
pub fn is_external(url: &url::Url) -> bool {
    !INTERNAL.contains(&url.scheme())
}

/// Whether this scheme is never handed to the system.
fn is_blocked(scheme: &str) -> bool {
    BLOCKED.contains(&scheme)
}

/// The link as the card names it; see `ExternalLinkAsked::target`.
fn display_target(url: &url::Url) -> String {
    match url.host_str().filter(|host| !host.is_empty()) {
        Some(host) => format!("{}://{host}", url.scheme()),
        None => format!("{}:", url.scheme()),
    }
}

/// Who a refusal holds back: the site, or the tab when there is no site.
fn asker(origin: &str, tab_id: TabId) -> String {
    if origin.is_empty() {
        format!("tab:{tab_id}")
    } else {
        origin.to_owned()
    }
}

/// Whether `asker` was told no too recently to ask again, forgetting the
/// refusals that have run out.
fn cooling(refused: &mut HashMap<String, Instant>, asker: &str, now: Instant) -> bool {
    refused.retain(|_, until| *until > now);
    refused.contains_key(asker)
}

/// How a remembered permission is written down: the asking site and the
/// scheme it may open, so allowing `claude.ai` to open `claude://` says
/// nothing about any other site or any other app.
pub fn allowance(origin: &str, scheme: &str) -> String {
    format!("{origin}|{scheme}")
}

/// Handle a navigation to another app's URL: open it when this site is
/// already allowed to, otherwise ask. Returns whether the navigation was
/// taken over, which is always -- the engine must not try to load it.
pub fn intercept(app: &AppHandle<Runtime>, tab_id: TabId, url: &url::Url, page_origin: &str) {
    let scheme = url.scheme().to_owned();
    let target = url.as_str();
    if target.len() > MAX_URL {
        tracing::warn!(%scheme, "external link too long to open");
        return;
    }
    if is_blocked(&scheme) {
        tracing::warn!(%scheme, "refused an external link to a blocked scheme");
        return;
    }
    let origin = page_origin.to_owned();
    if with_refused(|refused| cooling(refused, &asker(&origin, tab_id), Instant::now())) {
        tracing::debug!(%scheme, "external link asked again too soon after a no");
        return;
    }
    let state = app.state::<AppState>();
    let prefs = state.prefs.snapshot(&state);
    let allowed = !origin.is_empty()
        && prefs
            .external_link_allowed
            .contains(&allowance(&origin, &scheme));
    if allowed {
        // This runs on the main thread, and handing over waits on the
        // system; nobody is waiting on an answer to report a failure to.
        let target = target.to_owned();
        std::thread::spawn(move || {
            if let Err(error) = open(&target) {
                tracing::warn!(%error, "opening an allowed external link failed");
            }
        });
        return;
    }
    let token = TabId::new().to_string();
    let replaced = with_pending(|pending| {
        // One question per tab: a page that fires several is asked about
        // the newest, and the ones it replaces stop waiting in the host.
        let replaced = superseded(pending, tab_id);
        // A page that navigates in a loop must not grow this without bound.
        if pending.len() >= 32 {
            pending.clear();
        }
        pending.insert(
            token.clone(),
            Pending {
                tab_id,
                url: target.to_owned(),
                scheme: scheme.clone(),
                origin: origin.clone(),
            },
        );
        replaced
    });
    for old in replaced {
        closed(app, tab_id, old);
    }
    let _ = ExternalLinkAsked {
        tab_id,
        token,
        app: app_name_for(target),
        scheme,
        target: display_target(url),
        origin,
    }
    .emit(app);
}

/// Open what `token` stands for, and remember the site when asked to.
pub fn answer(app: &AppHandle<Runtime>, token: &str, always: bool) -> AppResult<()> {
    let Some(pending) = with_pending(|pending| pending.remove(token)) else {
        return Err(AppError::new("that link is no longer waiting"));
    };
    closed(app, pending.tab_id, token.to_owned());
    // Opened first: a site is remembered only for a link that could be.
    open(&pending.url)?;
    if always && !pending.origin.is_empty() {
        remember(app, &pending.origin, &pending.scheme)?;
    }
    Ok(())
}

/// Forget a link the person said no to, and hold its site back for a moment.
pub fn dismiss(app: &AppHandle<Runtime>, token: &str) {
    if let Some(pending) = with_pending(|pending| pending.remove(token)) {
        let key = asker(&pending.origin, pending.tab_id);
        with_refused(|refused| refused.insert(key, Instant::now() + COOLDOWN));
        closed(app, pending.tab_id, token.to_owned());
    }
}

/// Take out every question `tab` is still waiting on, returning their tokens.
fn superseded(pending: &mut HashMap<String, Pending>, tab: TabId) -> Vec<String> {
    let tokens: Vec<String> = pending
        .iter()
        .filter(|(_, p)| p.tab_id == tab)
        .map(|(token, _)| token.clone())
        .collect();
    for token in &tokens {
        pending.remove(token);
    }
    tokens
}

fn closed(app: &AppHandle<Runtime>, tab_id: TabId, token: String) {
    let _ = ExternalLinkClosed { tab_id, token }.emit(app);
}

fn remember(app: &AppHandle<Runtime>, origin: &str, scheme: &str) -> AppResult<()> {
    let state = app.state::<AppState>();
    let mut prefs = state.prefs.get(&state);
    let entry = allowance(origin, scheme);
    if !prefs.external_link_allowed.contains(&entry) {
        prefs.external_link_allowed.push(entry);
        state.prefs.set(&state, prefs)?;
    }
    Ok(())
}

/// Hand the URL to the system, which starts whichever app claims the scheme.
/// Waits until the system has taken it or refused it, so a link no app
/// claims is reported rather than silently dropped; keep it off the main
/// thread.
fn open(url: &str) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    return crate::commands::open_with_shell(std::ffi::OsStr::new(url), "the link");
    #[cfg(not(target_os = "windows"))]
    {
        #[cfg(target_os = "macos")]
        let status = std::process::Command::new("/usr/bin/open")
            .arg(url)
            .status();
        #[cfg(not(target_os = "macos"))]
        let status = std::process::Command::new("xdg-open").arg(url).status();
        match status {
            Ok(status) if status.success() => Ok(()),
            Ok(_) => Err(AppError::new("no app on this computer opens that link")),
            Err(error) => Err(AppError::new(format!("could not open the link: {error}"))),
        }
    }
}

/// The name of the app the system would open, for the card to say.
#[cfg(target_os = "macos")]
mod mac {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};

    pub(super) fn app_name_for(url: &str) -> Option<String> {
        let url = NSURL::URLWithString(&NSString::from_str(url))?;
        let app = NSWorkspace::sharedWorkspace().URLForApplicationToOpenURL(&url)?;
        let name = app.lastPathComponent()?.to_string();
        Some(name.strip_suffix(".app").unwrap_or(&name).to_owned())
    }
}

#[cfg(target_os = "macos")]
use mac::app_name_for;

#[cfg(not(target_os = "macos"))]
fn app_name_for(_url: &str) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_another_apps_scheme_is_external() {
        let external = |raw: &str| is_external(&url::Url::parse(raw).unwrap());
        assert!(external("claude://login/google-auth?code=abc"));
        assert!(external("mailto:someone@example.com"));
        assert!(external("zoommtg://zoom.us/join?confno=1"));
        // The engine's own schemes stay with the engine.
        assert!(!external("https://example.com"));
        assert!(!external("http://example.com"));
        assert!(!external("about:blank"));
        assert!(!external("file:///etc/hosts"));
        assert!(!external("data:text/html,hi"));
        assert!(!external("javascript:alert(1)"));
    }

    #[test]
    fn an_allowance_names_one_site_and_one_scheme() {
        assert_eq!(allowance("claude.ai", "claude"), "claude.ai|claude");
        assert_ne!(
            allowance("claude.ai", "claude"),
            allowance("evil.example", "claude")
        );
    }

    #[test]
    fn network_mounts_and_settings_are_never_handed_over() {
        for scheme in [
            "smb",
            "afp",
            "nfs",
            "ftp",
            "vnc",
            "x-apple.systempreferences",
            "search-ms",
            "ms-msdt",
        ] {
            let url = url::Url::parse(&format!("{scheme}://host/x")).unwrap();
            assert!(is_external(&url), "{scheme}");
            assert!(is_blocked(url.scheme()), "{scheme}");
        }
        for scheme in ["claude", "zoommtg", "mailto", "slack", "msteams"] {
            assert!(!is_blocked(scheme), "{scheme}");
        }
    }

    #[test]
    fn the_card_names_the_scheme_and_host_only() {
        let target = |raw: &str| display_target(&url::Url::parse(raw).unwrap());
        assert_eq!(
            target("claude://login/google-auth?code=secret"),
            "claude://login"
        );
        assert_eq!(
            target("zoommtg://zoom.us/join?confno=1&pwd=x"),
            "zoommtg://zoom.us"
        );
        assert_eq!(target("mailto:someone@example.com"), "mailto:");
    }

    #[test]
    fn a_site_told_no_waits_before_asking_again() {
        let now = Instant::now();
        let mut refused = HashMap::new();
        refused.insert("loop.example".to_owned(), now + COOLDOWN);
        assert!(cooling(&mut refused, "loop.example", now));
        // Another site is not held back by it.
        assert!(!cooling(&mut refused, "claude.ai", now));
        // Once the moment has passed the site may ask, and the entry goes.
        assert!(!cooling(&mut refused, "loop.example", now + COOLDOWN));
        assert!(refused.is_empty());
        // A page with no site is held back by its tab instead.
        let tab = TabId::new();
        assert_eq!(asker("", tab), format!("tab:{tab}"));
        assert_eq!(asker("claude.ai", tab), "claude.ai");
    }

    #[test]
    fn a_newer_question_from_a_tab_replaces_its_older_one() {
        let tab = TabId::new();
        let other = TabId::new();
        let question = |tab_id| Pending {
            tab_id,
            url: "claude://x".into(),
            scheme: "claude".into(),
            origin: "claude.ai".into(),
        };
        let mut pending = HashMap::new();
        pending.insert("old".to_owned(), question(tab));
        pending.insert("elsewhere".to_owned(), question(other));
        assert_eq!(superseded(&mut pending, tab), vec!["old".to_owned()]);
        // Another tab's question is its own and keeps waiting.
        assert!(pending.contains_key("elsewhere"));
        assert!(!pending.contains_key("old"));
        assert!(superseded(&mut pending, tab).is_empty());
    }
}
