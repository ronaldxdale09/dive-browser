//! Turning preferences into `DevTools` calls for each tab.

use dive_cdp::CdpSession;
use serde_json::{Value, json};

use crate::prefs::{Prefs, ThemeMode};

/// What a tab should hear about the colour scheme from [`calls_for`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageScheme {
    /// Tell it the chrome's scheme when the preference asks for that.
    Follow,
    /// "Tell pages the theme" was just turned off: take back what was said,
    /// or every open tab keeps the forced scheme until it is closed.
    Withdraw,
    /// The tab has media overrides from the device menu, which win over the
    /// preference; say nothing, in either direction, so they are kept.
    Leave,
}

/// [`calls_for`] for a tab with no overrides of its own.
#[cfg(test)]
fn calls(prefs: &Prefs, chrome_scheme: Option<&str>) -> Vec<(&'static str, Value)> {
    calls_for(prefs, chrome_scheme, PageScheme::Follow)
}

/// The `DevTools` calls that put `prefs` into force on one tab.
///
/// The emulated color scheme is only sent when the user asked for it, so a
/// preference write never clobbers a per-tab override from the device menu.
/// `chrome_scheme` is what the chrome is actually drawn in; without it the
/// explicit mode is the best guess and System says nothing.
pub fn calls_for(
    prefs: &Prefs,
    chrome_scheme: Option<&str>,
    page: PageScheme,
) -> Vec<(&'static str, Value)> {
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
    let scheme = chrome_scheme.or(match prefs.theme {
        ThemeMode::System => None,
        ThemeMode::Dark => Some("dark"),
        ThemeMode::Light => Some("light"),
    });
    match page {
        PageScheme::Follow => {
            if prefs.tell_pages_theme
                && let Some(scheme) = scheme
            {
                calls.push((
                    "Emulation.setEmulatedMedia",
                    json!({"features": [{"name": "prefers-color-scheme", "value": scheme}]}),
                ));
            }
        }
        // Only when the preference really is off now: a withdrawal that
        // raced a newer "on" must not blank the scheme it asked for.
        PageScheme::Withdraw if !prefs.tell_pages_theme => {
            calls.push((
                "Emulation.setEmulatedMedia",
                json!({"media": "", "features": []}),
            ));
        }
        PageScheme::Withdraw | PageScheme::Leave => {}
    }
    calls
}

/// Apply `prefs` to one tab's session. Failures are logged, not fatal: a tab
/// that has just closed must not fail a settings write.
///
/// The calls are independent of one another, so they go out together and
/// are awaited together: a new tab waits on these before its first
/// navigation, and one round trip after another added up.
pub async fn apply(session: &CdpSession, prefs: &Prefs, chrome_scheme: Option<&str>) {
    apply_for(session, prefs, chrome_scheme, PageScheme::Follow).await;
}

/// [`apply`], with the tab's colour-scheme situation spelled out.
pub async fn apply_for(
    session: &CdpSession,
    prefs: &Prefs,
    chrome_scheme: Option<&str>,
    page: PageScheme,
) {
    let sent =
        calls_for(prefs, chrome_scheme, page)
            .into_iter()
            .map(|(method, params)| async move {
                if let Err(e) = session.call(method, params).await {
                    tracing::debug!("{method} failed: {e}");
                }
            });
    futures_util::future::join_all(sent).await;
}

/// Whether `next` differs from `previous` only in fields the chrome draws
/// itself -- colours, type, layout, motion. None of those reach a page, so a
/// write that changes nothing else skips the per-tab `DevTools` round trips,
/// the interception rebuild and the history prune: dragging a colour or the
/// size slider used to pay for all of it on every step.
pub fn chrome_only_change(previous: &Prefs, next: &Prefs) -> bool {
    let mut masked = next.clone();
    masked.accent.clone_from(&previous.accent);
    masked
        .appearance_preset
        .clone_from(&previous.appearance_preset);
    masked.custom_ground.clone_from(&previous.custom_ground);
    masked.custom_ink.clone_from(&previous.custom_ink);
    masked
        .custom_highlight
        .clone_from(&previous.custom_highlight);
    masked.ui_font.clone_from(&previous.ui_font);
    masked.ui_scale = previous.ui_scale;
    masked.density = previous.density;
    masked.corner_radius = previous.corner_radius;
    masked.tab_style = previous.tab_style;
    masked.motion = previous.motion;
    masked.welcome_background = previous.welcome_background;
    masked.rail_expanded = previous.rail_expanded;
    masked == *previous
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calls_cover_headers_blocking_and_scripts() {
        let prefs = Prefs {
            do_not_track: true,
            javascript: false,
            theme: ThemeMode::Dark,
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
    fn turning_the_theme_off_takes_it_back_except_where_the_device_menu_rules() {
        let off = Prefs::default();
        let withdrawn = calls_for(&off, Some("dark"), PageScheme::Withdraw);
        assert_eq!(withdrawn.len(), 4);
        assert_eq!(withdrawn[3].0, "Emulation.setEmulatedMedia");
        assert_eq!(withdrawn[3].1["features"], json!([]));
        // A tab with its own media overrides keeps them either way.
        assert_eq!(calls_for(&off, Some("dark"), PageScheme::Leave).len(), 3);
        let on = Prefs {
            tell_pages_theme: true,
            ..Prefs::default()
        };
        assert_eq!(calls_for(&on, Some("dark"), PageScheme::Leave).len(), 3);
        // A withdrawal that lost a race with turning it back on says nothing.
        assert_eq!(calls_for(&on, Some("dark"), PageScheme::Withdraw).len(), 3);
    }

    #[test]
    fn an_appearance_change_is_told_apart_from_one_pages_see() {
        let before = Prefs::default();
        let dragged = Prefs {
            custom_ground: "#223344".into(),
            ui_scale: 1.15,
            accent: "#8FB8F0".into(),
            ..before.clone()
        };
        assert!(chrome_only_change(&before, &dragged));
        assert!(chrome_only_change(&before, &before));
        let javascript = Prefs {
            javascript: false,
            ..dragged.clone()
        };
        assert!(!chrome_only_change(&before, &javascript));
        // The mode can reach pages through "Tell pages the theme".
        let theme = Prefs {
            theme: ThemeMode::Light,
            ..before.clone()
        };
        assert!(!chrome_only_change(&before, &theme));
    }
}
