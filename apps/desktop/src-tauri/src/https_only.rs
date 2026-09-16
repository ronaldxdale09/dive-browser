//! Refusing to load a page in the clear.
//!
//! An address typed without a scheme, or a link from an old bookmark, still
//! goes out over plain http: readable and rewritable by anything between the
//! machine and the server. Every other browser now offers to upgrade those
//! and to stop rather than fall back. Dive did not, while advertising itself
//! on privacy.
//!
//! The rule is narrow on purpose. This is a developer's browser: `localhost`,
//! a private address and the development top-level domains are how the person
//! reaches their own work, they are not reachable over https, and upgrading
//! them would break the product's main use in the name of a padlock. Those
//! are left alone, always, whatever the setting says -- not as an exception
//! the person has to discover, but as part of what the setting means.
//!
//! When an upgraded address will not load, nothing falls back on its own.
//! The page fails, and the chrome offers to continue without encryption for
//! that host, which is a decision rather than a default.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, RwLock};

use dive_core::TabId;

/// The setting, and the hosts excused from it, as the navigation callback
/// sees them.
///
/// The callback runs on the engine's own thread while a navigation is
/// waiting, and this browser has been frozen before by a lock taken on
/// exactly such a path. So the two values the decision needs are mirrored
/// here when preferences are saved, and the hot path reads an atomic and a
/// read lock over a short list rather than the preference store.
static ENABLED: AtomicBool = AtomicBool::new(false);

fn allowed() -> &'static RwLock<Vec<String>> {
    static ALLOWED: std::sync::OnceLock<RwLock<Vec<String>>> = std::sync::OnceLock::new();
    ALLOWED.get_or_init(RwLock::default)
}

/// Mirror the preferences the navigation path reads.
pub fn apply_settings(enabled: bool, hosts: &[String]) {
    ENABLED.store(enabled, Ordering::Relaxed);
    let mut list = allowed()
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    list.clear();
    list.extend(hosts.iter().cloned());
}

/// Whether a navigation should be considered for upgrade at all.
pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// The upgrade for `url` under the mirrored settings, if any.
pub fn upgrade_now(url: &str) -> Option<String> {
    if !enabled() {
        return None;
    }
    let hosts = allowed()
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    upgrade(url, true, &hosts)
}

/// Hosts we upgraded, by tab, so a failure that follows can be explained and
/// offered a way out. One entry per tab: only the newest matters.
///
/// A static rather than a field on the application state: the engine's
/// navigation callback runs before any state handle is in scope, and a second
/// registry that disagreed with the first would be worse than this.
fn upgraded() -> &'static Mutex<HashMap<TabId, String>> {
    static UPGRADED: std::sync::OnceLock<Mutex<HashMap<TabId, String>>> =
        std::sync::OnceLock::new();
    UPGRADED.get_or_init(Mutex::default)
}

/// Whether `host` is somewhere https is not the point.
///
/// Loopback, the private ranges, and the top-level domains reserved for
/// development and local networks. `.onion` is here because it is already
/// end-to-end encrypted and has no certificate authority.
pub fn is_local(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host == "localhost" || host.ends_with(".localhost") || host == "::1" {
        return true;
    }
    for suffix in [".local", ".test", ".internal", ".localdomain", ".onion"] {
        if host.ends_with(suffix) {
            return true;
        }
    }
    let octets: Vec<&str> = host.split('.').collect();
    if octets.len() == 4
        && let Ok(parsed) = host.parse::<std::net::Ipv4Addr>()
    {
        return parsed.is_loopback() || parsed.is_private() || parsed.is_link_local();
    }
    host.parse::<std::net::Ipv6Addr>()
        .is_ok_and(|v6| v6.is_loopback() || v6.segments()[0] & 0xfe00 == 0xfc00)
}

/// The https address this navigation should go to instead, if any.
///
/// `allowed` holds the hosts the person has already decided to reach in the
/// clear; the comparison is exact, so allowing `example.com` says nothing
/// about its subdomains.
pub fn upgrade(url: &str, enabled: bool, allowed: &[String]) -> Option<String> {
    if !enabled {
        return None;
    }
    let mut parsed = url::Url::parse(url).ok()?;
    if parsed.scheme() != "http" {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    if is_local(&host) || allowed.iter().any(|a| a.eq_ignore_ascii_case(&host)) {
        return None;
    }
    // A port that was spelled out for http means nothing over https, and
    // carrying it across would ask for https on the http port.
    if parsed.port() == Some(80) {
        let _ = parsed.set_port(None);
    }
    parsed.set_scheme("https").ok()?;
    Some(parsed.to_string())
}

/// Remember that `tab` was sent to https, so a failure can offer the way out.
pub fn note(tab: TabId, host: &str) {
    lock().insert(tab, host.to_ascii_lowercase());
}

/// The host this tab was upgraded to, if the newest navigation was one.
pub fn upgraded_host(tab: TabId) -> Option<String> {
    lock().get(&tab).cloned()
}

/// Forget the tab: it reached somewhere, or it closed.
pub fn forget(tab: TabId) {
    lock().remove(&tab);
}

fn lock() -> std::sync::MutexGuard<'static, HashMap<TabId, String>> {
    upgraded()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A host added to the allow list, normalised the way `upgrade` compares it.
pub fn normalize_allowed(hosts: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = hosts
        .into_iter()
        .map(|h| h.trim().trim_end_matches('.').to_ascii_lowercase())
        .filter(|h| !h.is_empty() && h.len() <= 253 && !h.contains('/') && !h.contains(' '))
        .collect();
    out.sort();
    out.dedup();
    out.truncate(500);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_page_is_asked_for_over_https_instead() {
        assert_eq!(
            upgrade("http://example.com/path?q=1", true, &[]).as_deref(),
            Some("https://example.com/path?q=1")
        );
        // The default port was about http and does not survive the change.
        assert_eq!(
            upgrade("http://example.com:80/x", true, &[]).as_deref(),
            Some("https://example.com/x")
        );
        // A port that was chosen is kept: it is where the server is.
        assert_eq!(
            upgrade("http://example.com:8080/x", true, &[]).as_deref(),
            Some("https://example.com:8080/x")
        );
    }

    #[test]
    fn the_setting_off_changes_nothing() {
        assert_eq!(upgrade("http://example.com/", false, &[]), None);
    }

    #[test]
    fn a_developers_own_machine_is_never_upgraded() {
        // This is the whole reason the rule is narrow: upgrading these would
        // break the thing the browser is for.
        for url in [
            "http://localhost:3000/",
            "http://127.0.0.1:5173/",
            "http://[::1]:8080/",
            "http://192.168.1.10/",
            "http://10.0.0.5:3000/",
            "http://172.16.4.4/",
            "http://mac.local/",
            "http://api.test/",
            "http://app.localhost:4000/",
            "http://box.internal/",
        ] {
            assert_eq!(upgrade(url, true, &[]), None, "{url} was upgraded");
        }
        // A public address that merely looks similar is still upgraded.
        assert!(upgrade("http://local.example.com/", true, &[]).is_some());
        assert!(upgrade("http://172.32.0.1/", true, &[]).is_some());
    }

    #[test]
    fn a_host_the_person_allowed_stays_in_the_clear_but_only_that_host() {
        let allowed = vec!["old.example.com".to_owned()];
        assert_eq!(upgrade("http://old.example.com/x", true, &allowed), None);
        assert!(upgrade("http://sub.old.example.com/x", true, &allowed).is_some());
        // Case is not a way around the list, in either direction.
        assert_eq!(upgrade("http://OLD.example.com/", true, &allowed), None);
    }

    #[test]
    fn nothing_but_http_is_touched() {
        for url in [
            "https://example.com/",
            "dive://settings",
            "file:///tmp/x.html",
            "about:blank",
            "not a url",
        ] {
            assert_eq!(upgrade(url, true, &[]), None, "{url}");
        }
    }

    #[test]
    fn the_navigation_path_reads_the_mirror_and_never_the_store() {
        apply_settings(false, &[]);
        assert!(!enabled());
        assert_eq!(upgrade_now("http://example.com/"), None);

        apply_settings(true, &["old.example.com".to_owned()]);
        assert!(enabled());
        assert_eq!(
            upgrade_now("http://example.com/").as_deref(),
            Some("https://example.com/")
        );
        assert_eq!(upgrade_now("http://old.example.com/"), None);

        // Turning it off takes effect without anything else being consulted.
        apply_settings(false, &[]);
        assert_eq!(upgrade_now("http://example.com/"), None);
    }

    #[test]
    fn the_upgrade_is_remembered_for_the_failure_that_may_follow() {
        let tab = TabId::new();
        assert_eq!(upgraded_host(tab), None);
        note(tab, "Example.COM");
        assert_eq!(upgraded_host(tab).as_deref(), Some("example.com"));
        forget(tab);
        assert_eq!(upgraded_host(tab), None);
    }

    #[test]
    fn the_allow_list_is_hosts_and_nothing_else() {
        let cleaned = normalize_allowed(vec![
            "  Example.com. ".into(),
            "example.com".into(),
            String::new(),
            "http://x.com/path".into(),
            "has space".into(),
        ]);
        assert_eq!(cleaned, vec!["example.com".to_owned()]);
    }
}
