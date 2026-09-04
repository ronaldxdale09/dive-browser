//! Only Dive's bundled main-frame chrome may call application commands.

use url::Url;

pub(crate) fn trusted_chrome_label(label: &str, window: &str) -> bool {
    if label == crate::CHROME_LABEL {
        return window == crate::MAIN_WINDOW;
    }
    let Some(rest) = window.strip_prefix("pop-") else {
        return false;
    };
    let Some((sequence, tab)) = rest.split_once('-') else {
        return false;
    };
    label.strip_prefix("chrome-") == Some(window)
        && sequence.parse::<u64>().is_ok()
        && tab.parse::<dive_core::TabId>().is_ok()
}

/// Chrome never becomes a web page. Page links belong in tab views, which
/// cannot invoke Dive commands even when displaying a local app URL.
pub(crate) fn allowed_chrome_navigation(url: &Url, dev_url: Option<&Url>) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if !matches!(url.path(), "" | "/" | "/index.html") {
        return false;
    }
    let bundled =
        url.scheme() == "http" && url.host_str() == Some("tauri.localhost") && url.port().is_none();
    // The optional Wry development fallback uses the native custom scheme.
    let bundled = bundled
        || (cfg!(not(feature = "cef"))
            && url.scheme() == "tauri"
            && url.host_str() == Some("localhost")
            && url.port().is_none());
    bundled || dev_url.is_some_and(|dev| url.origin() == dev.origin())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_capabilities_match_chrome_webviews_without_broad_window_grants() {
        // Tauri ORs window and webview selectors: window matches would also
        // authorize a local app document opened in an ordinary tab view.
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert!(
            capability
                .get("windows")
                .is_none_or(|windows| windows.as_array().is_some_and(Vec::is_empty))
        );
        assert_eq!(
            capability["webviews"],
            serde_json::json!(["chrome", "chrome-pop-*"])
        );
        assert!(capability.get("remote").is_none());
    }

    #[test]
    fn only_matching_chrome_window_pairs_are_authorized() {
        let id = dive_core::TabId::new();
        assert!(trusted_chrome_label("chrome", "main"));
        assert!(trusted_chrome_label(
            &format!("chrome-pop-2-{id}"),
            &format!("pop-2-{id}")
        ));
        for (label, window) in [
            ("tab-1", "main"),
            ("chrome", "pop-1"),
            ("chrome-pop-garbage", "pop-garbage"),
            ("chrome-pop-1", "main"),
        ] {
            assert!(!trusted_chrome_label(label, window));
        }
        assert!(!trusted_chrome_label(
            &format!("chrome-pop-2-{id}"),
            &format!("pop-3-{id}")
        ));
    }

    #[test]
    fn chrome_navigation_rejects_remote_lookalikes_and_non_app_documents() {
        for address in [
            "http://tauri.localhost/",
            "http://tauri.localhost/index.html?popout=123#app",
        ] {
            assert!(allowed_chrome_navigation(
                &Url::parse(address).unwrap(),
                None
            ));
        }
        for address in [
            "https://example.com/",
            "http://tauri.localhost.evil.test/",
            "http://tauri.localhost@evil.test/",
            "http://evil@tauri.localhost/",
            "http://tauri.localhost:1234/",
            "http://tauri.localhost/other.html",
            "file:///index.html",
            "data:text/html,hello",
            "about:blank",
        ] {
            assert!(
                !allowed_chrome_navigation(&Url::parse(address).unwrap(), None),
                "{address}"
            );
        }
    }

    #[test]
    fn development_origin_must_match_exactly_and_be_explicit() {
        let dev = Url::parse("http://localhost:1420/").unwrap();
        assert!(allowed_chrome_navigation(&dev, Some(&dev)));
        assert!(!allowed_chrome_navigation(&dev, None));
        for address in [
            "http://localhost:1421/",
            "https://localhost:1420/",
            "http://127.0.0.1:1420/",
        ] {
            assert!(!allowed_chrome_navigation(
                &Url::parse(address).unwrap(),
                Some(&dev)
            ));
        }
    }
}
