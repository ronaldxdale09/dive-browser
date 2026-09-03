//! Record the person's own clicks and typing in a tab as steps with
//! accessibility-style locators, so a manual flow can become a Playwright
//! test or a macro. A small script in the page reports events through a
//! CDP binding; this module turns them into steps.

use dive_cdp::{CdpEvent, CdpSession};
use dive_core::TabId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::Runtime;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Name of the binding the page script calls.
const BINDING: &str = "__diveRecord";

/// One recorded interaction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct RecordedStep {
    /// `click` | `type` | `navigate`.
    pub kind: String,
    /// ARIA role of the target.
    pub role: String,
    /// Accessible name of the target.
    pub name: String,
    /// Typed text for `type`; URL for `navigate`.
    pub value: String,
    /// Milliseconds since the epoch.
    pub at: f64,
}

/// Emitted to the chrome for each recorded step.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct RecorderEvent {
    /// Tab being recorded.
    pub tab_id: TabId,
    /// The step.
    pub step: RecordedStep,
}

/// Injected into the page: reports clicks on interactive elements and
/// committed text input. Names follow the accessible-name heuristics
/// Playwright's `getByRole` resolves against.
const SCRIPT: &str = r"(function(){
  if (window.__diveRecorderInstalled) return; window.__diveRecorderInstalled = true;
  const send = (payload) => { try { window.__diveRecord(JSON.stringify(payload)); } catch (e) {} };
  const text = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const nameOf = (el) => {
    const aria = el.getAttribute && (el.getAttribute('aria-label') || '');
    if (aria) return aria;
    const labelled = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelled) { const l = document.getElementById(labelled); if (l) return text(l); }
    if (el.labels && el.labels.length) return text(el.labels[0]);
    if (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button')) return el.value || '';
    if (el.placeholder) return el.placeholder;
    if (el.tagName === 'IMG') return el.alt || '';
    return text(el);
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute && el.getAttribute('role'); if (explicit) return explicit;
    const t = el.tagName; const type = (el.type || '').toLowerCase();
    if (t === 'A' && el.hasAttribute('href')) return 'link';
    if (t === 'BUTTON' || (t === 'INPUT' && (type === 'submit' || type === 'button' || type === 'reset'))) return 'button';
    if (t === 'INPUT' && type === 'checkbox') return 'checkbox';
    if (t === 'INPUT' && type === 'radio') return 'radio';
    if (t === 'INPUT' && type === 'search') return 'searchbox';
    if (t === 'INPUT' || t === 'TEXTAREA') return 'textbox';
    if (t === 'SELECT') return 'combobox';
    if (t === 'OPTION') return 'option';
    return '';
  };
  const target = (el) => { while (el && el !== document.body) { if (roleOf(el)) return el; el = el.parentElement; } return null; };
  document.addEventListener('click', (e) => {
    const el = target(e.target); if (!el) return;
    const role = roleOf(el); if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return;
    send({ kind: 'click', role, name: nameOf(el), value: '', at: Date.now() });
  }, true);
  document.addEventListener('change', (e) => {
    const el = e.target; const role = roleOf(el); if (!role) return;
    if (role === 'checkbox' || role === 'radio') { send({ kind: 'click', role, name: nameOf(el), value: '', at: Date.now() }); return; }
    send({ kind: 'type', role, name: nameOf(el), value: String(el.value || ''), at: Date.now() });
  }, true);
})()";

/// Install the binding and script, and forward events while recording.
pub async fn start(app: AppHandle<Runtime>, tab_id: TabId, session: CdpSession) -> AppResult<()> {
    session
        .call("Runtime.addBinding", json!({"name": BINDING}))
        .await
        .map_err(AppError::new)?;
    session
        .call("Page.enable", json!({}))
        .await
        .map_err(AppError::new)?;
    session
        .call(
            "Page.addScriptToEvaluateOnNewDocument",
            json!({"source": SCRIPT}),
        )
        .await
        .map_err(AppError::new)?;
    session
        .call("Runtime.evaluate", json!({"expression": SCRIPT}))
        .await
        .map_err(AppError::new)?;
    let state = app.state::<AppState>();
    state.buffers.set_recording(tab_id, Some(Vec::new()));

    tauri::async_runtime::spawn(async move {
        let mut events = session.subscribe();
        loop {
            match events.recv().await {
                Ok(event) => {
                    let state = app.state::<AppState>();
                    if !state.buffers.is_recording(tab_id) {
                        break;
                    }
                    if let Some(step) = map_event(&event) {
                        state.buffers.push_recorded(tab_id, step.clone());
                        let _ = RecorderEvent { tab_id, step }.emit(&app);
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    Ok(())
}

/// A `Runtime.bindingCalled` for our binding, or a main-frame navigation.
pub fn map_event(event: &CdpEvent) -> Option<RecordedStep> {
    match event.method.as_str() {
        "Runtime.bindingCalled" if event.params["name"] == BINDING => {
            let payload: Value = serde_json::from_str(event.params["payload"].as_str()?).ok()?;
            Some(RecordedStep {
                kind: payload["kind"].as_str()?.to_owned(),
                role: payload["role"].as_str().unwrap_or_default().to_owned(),
                name: payload["name"].as_str().unwrap_or_default().to_owned(),
                value: payload["value"].as_str().unwrap_or_default().to_owned(),
                at: payload["at"].as_f64().unwrap_or_default(),
            })
        }
        "Page.frameNavigated" if event.params["frame"]["parentId"].is_null() => {
            Some(RecordedStep {
                kind: "navigate".into(),
                role: String::new(),
                name: String::new(),
                value: event.params["frame"]["url"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                at: 0.0,
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_binding_and_navigation_events() {
        let ev = CdpEvent {
            method: "Runtime.bindingCalled".into(),
            params: json!({"name": BINDING, "payload": "{\"kind\":\"click\",\"role\":\"button\",\"name\":\"Save\",\"value\":\"\",\"at\":5}"}),
        };
        let s = map_event(&ev).unwrap();
        assert_eq!(
            (s.kind.as_str(), s.role.as_str(), s.name.as_str()),
            ("click", "button", "Save")
        );
        let other = CdpEvent {
            method: "Runtime.bindingCalled".into(),
            params: json!({"name": "other", "payload": "{}"}),
        };
        assert!(map_event(&other).is_none());
        let nav = CdpEvent {
            method: "Page.frameNavigated".into(),
            params: json!({"frame": {"id": "1", "url": "https://a.dev/x"}}),
        };
        assert_eq!(map_event(&nav).unwrap().value, "https://a.dev/x");
        let child = CdpEvent {
            method: "Page.frameNavigated".into(),
            params: json!({"frame": {"id": "2", "parentId": "1", "url": "https://ad.example"}}),
        };
        assert!(map_event(&child).is_none());
    }
}
