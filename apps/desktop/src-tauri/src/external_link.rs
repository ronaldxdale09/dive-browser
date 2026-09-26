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

use std::collections::HashMap;
use std::sync::Mutex;

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

/// The longest URL worth showing or opening.
const MAX_URL: usize = 4096;

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

fn with_pending<T>(f: impl FnOnce(&mut HashMap<String, Pending>) -> T) -> T {
    let mut guard = PENDING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    f(guard.get_or_insert_with(HashMap::new))
}

/// Whether this URL is another app's to open.
pub fn is_external(url: &url::Url) -> bool {
    !INTERNAL.contains(&url.scheme())
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
    let origin = page_origin.to_owned();
    let state = app.state::<AppState>();
    let prefs = state.prefs.snapshot(&state);
    let allowed = !origin.is_empty()
        && prefs
            .external_link_allowed
            .contains(&allowance(&origin, &scheme));
    if allowed {
        open(target);
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
    if always && !pending.origin.is_empty() {
        remember(app, &pending.origin, &pending.scheme)?;
    }
    open(&pending.url);
    Ok(())
}

/// Forget a link the person said no to.
pub fn dismiss(app: &AppHandle<Runtime>, token: &str) {
    if let Some(pending) = with_pending(|pending| pending.remove(token)) {
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
fn open(url: &str) {
    #[cfg(target_os = "macos")]
    {
        if let Err(error) = std::process::Command::new("/usr/bin/open").arg(url).spawn() {
            tracing::warn!(%error, "opening an external link failed");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = url;
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
