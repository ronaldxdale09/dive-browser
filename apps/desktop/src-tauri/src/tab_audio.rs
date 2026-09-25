//! Which tabs are making a sound, and which ones have been silenced.
//!
//! The engine keeps no signal for this -- CEF exposes audio capture, not
//! Chromium's own "is this tab audible" -- so a page script reports it and the
//! host holds the answer per tab. Muting is native: `SetAudioMuted` on the
//! browser host silences the whole tab whatever the page does, and it is
//! re-applied whenever a view is built again, so a muted tab that was
//! discarded and woken comes back silent.

use std::collections::HashMap;
use std::sync::Mutex;

use dive_cdp::CdpSession;
use dive_core::TabId;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;

use crate::Runtime;

const BINDING: &str = "__diveAudio";

/// What the chrome draws on a tab: a speaker when it is making a sound, a
/// crossed speaker when it has been silenced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct TabAudio {
    pub tab_id: TabId,
    /// The page is playing something a person would hear.
    pub audible: bool,
    /// The host is silencing this tab.
    pub muted: bool,
}

#[derive(Default, Clone, Copy)]
struct State {
    audible: bool,
    muted: bool,
}

static TABS: Mutex<Option<HashMap<TabId, State>>> = Mutex::new(None);

fn with_tabs<T>(f: impl FnOnce(&mut HashMap<TabId, State>) -> T) -> T {
    let mut guard = TABS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    f(guard.get_or_insert_with(HashMap::new))
}

fn state_of(tab_id: TabId) -> State {
    with_tabs(|tabs| tabs.get(&tab_id).copied().unwrap_or_default())
}

/// Whether this tab is silenced. Read when a view is created, so a muted tab
/// that was discarded wakes up muted.
pub fn is_muted(tab_id: TabId) -> bool {
    state_of(tab_id).muted
}

/// Whether this tab is making a sound. The idle sweep asks, so a tab playing
/// something is never discarded out from under it.
pub fn is_audible(tab_id: TabId) -> bool {
    state_of(tab_id).audible
}

/// Forget a tab that is gone.
pub fn forget(tab_id: TabId) {
    with_tabs(|tabs| tabs.remove(&tab_id));
}

fn publish(app: &AppHandle<Runtime>, tab_id: TabId, state: State) {
    let _ = TabAudio {
        tab_id,
        audible: state.audible,
        muted: state.muted,
    }
    .emit(app);
}

/// Silence this tab, or let it be heard again. Native, so it holds whatever
/// the page does with its own players.
pub fn set_muted(
    main: &crate::engine::MainThread,
    app: &AppHandle<Runtime>,
    state: &crate::state::AppState,
    tab_id: TabId,
    muted: bool,
) {
    if let Some(host) = crate::state::lock(&state.host).as_ref() {
        apply(main, host, tab_id, muted);
    }
    let next = with_tabs(|tabs| {
        let entry = tabs.entry(tab_id).or_default();
        entry.muted = muted;
        *entry
    });
    publish(app, tab_id, next);
}

/// Put this tab's mute on its live view. Called when it changes and again
/// whenever the view is rebuilt.
pub fn apply(
    _main: &crate::engine::MainThread,
    host: &crate::engine::TabHost,
    tab_id: TabId,
    muted: bool,
) {
    #[cfg(feature = "cef")]
    {
        let result = host.with_view(tab_id, |view| {
            view.with_webview(move |native| {
                use cef::{ImplBrowser, ImplBrowserHost};
                if let Some(host) = native.browser().host() {
                    host.set_audio_muted(i32::from(muted));
                }
            })
        });
        // A tab with no live view keeps the intent; the next view applies it.
        if let Err(error) = result {
            tracing::debug!(%tab_id, "mute not applied to a view: {error}");
        }
    }
    #[cfg(not(feature = "cef"))]
    let _ = (host, tab_id, muted);
}

/// Report what this tab is doing now, for a chrome that just opened or a tab
/// whose row is being drawn again.
pub fn snapshot(tab_id: TabId) -> TabAudio {
    let state = state_of(tab_id);
    TabAudio {
        tab_id,
        audible: state.audible,
        muted: state.muted,
    }
}

/// What a call to *this* watcher's binding says, if that is what the event is.
///
/// Every page script shares one `Runtime.bindingCalled` stream, so the name
/// has to be checked as well as the nonce: reusing another module's payload
/// reader silently dropped every report, since it only recognised its own
/// binding.
fn reported_audible(event: &dive_cdp::CdpEvent, nonce: &str) -> Option<bool> {
    if event.method != "Runtime.bindingCalled" || event.params["name"] != BINDING {
        return None;
    }
    let encoded = event.params["payload"].as_str()?;
    if encoded.len() > 1024 {
        return None;
    }
    let payload: serde_json::Value = serde_json::from_str(encoded).ok()?;
    if payload["nonce"].as_str() != Some(nonce) {
        return None;
    }
    Some(payload["audible"].as_bool().unwrap_or(false))
}

/// Install the watcher on a tab and follow what it reports.
pub async fn attach(app: AppHandle<Runtime>, tab_id: TabId, session: CdpSession) {
    let nonce = TabId::new().to_string().replace('-', "");
    let source = crate::pagescript::build(
        "audio.js",
        &[
            (
                "__NONCE__",
                serde_json::to_string(&nonce).unwrap_or_else(|_| "null".into()),
            ),
            ("__BINDING__", BINDING.to_owned()),
        ],
    );
    let mut events = session.subscribe();
    let setup = async {
        session
            .call("Runtime.addBinding", json!({"name": BINDING}))
            .await?;
        session
            .call(
                "Page.addScriptToEvaluateOnNewDocument",
                json!({"source": source}),
            )
            .await?;
        let _ = session
            .call("Runtime.evaluate", json!({"expression": source}))
            .await;
        Ok::<(), dive_cdp::CdpError>(())
    };
    if let Err(error) = setup.await {
        crate::cdp_feed::setup_failed(tab_id, "audio state", &error);
        return;
    }
    tauri::async_runtime::spawn(async move {
        while let Some(event) =
            crate::cdp_feed::next_event(&mut events, tab_id, "audio state").await
        {
            let Some(audible) = reported_audible(&event, &nonce) else {
                continue;
            };
            let next = with_tabs(|tabs| {
                let entry = tabs.entry(tab_id).or_default();
                if entry.audible == audible {
                    return None;
                }
                entry.audible = audible;
                Some(*entry)
            });
            if let Some(next) = next {
                publish(&app, tab_id, next);
            }
        }
        // The session is gone: a page that was playing is not playing now.
        // A tab already forgotten (closed) is not put back.
        let next = with_tabs(|tabs| {
            let entry = tabs.get_mut(&tab_id)?;
            if !entry.audible {
                return None;
            }
            entry.audible = false;
            Some(*entry)
        });
        if let Some(next) = next {
            publish(&app, tab_id, next);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_watchers_own_reports_are_read() {
        let event = |name: &str, payload: &str| dive_cdp::CdpEvent {
            method: "Runtime.bindingCalled".into(),
            params: serde_json::json!({"name": name, "payload": payload}),
            navigation_epoch: 0,
        };
        assert_eq!(
            reported_audible(&event(BINDING, r#"{"nonce":"n1","audible":true}"#), "n1"),
            Some(true)
        );
        // Another module's binding shares the stream and must be ignored.
        assert_eq!(
            reported_audible(
                &event("__diveForms", r#"{"nonce":"n1","audible":true}"#),
                "n1"
            ),
            None
        );
        // A page forging a report without the nonce gets nowhere.
        assert_eq!(
            reported_audible(&event(BINDING, r#"{"audible":true}"#), "n1"),
            None
        );
        assert_eq!(reported_audible(&event(BINDING, "not json"), "n1"), None);
    }

    #[test]
    fn a_tab_keeps_its_mute_and_loses_it_when_the_tab_goes() {
        let tab = TabId::new();
        assert!(!is_muted(tab));
        with_tabs(|tabs| tabs.entry(tab).or_default().muted = true);
        assert!(is_muted(tab));
        // Audible and muted are independent: a muted tab still plays, silently.
        with_tabs(|tabs| tabs.entry(tab).or_default().audible = true);
        assert!(is_audible(tab));
        assert_eq!(
            snapshot(tab),
            TabAudio {
                tab_id: tab,
                audible: true,
                muted: true
            }
        );
        forget(tab);
        assert!(!is_muted(tab));
        assert!(!is_audible(tab));
    }
}
