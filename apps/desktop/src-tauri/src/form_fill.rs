//! Form entries in pages: a script in Dive's isolated world (see
//! `page_world`) asks, as the person types into a named field, what the
//! profile remembers for that field on this site, and reports what a
//! submitted form held so it can be remembered for this site. Private
//! windows are offered entries but never add to them.
//!
//! Entries belong to the site they were typed on, and the site is always the
//! origin of the document that called, asked of its own context -- never
//! anything its payload says. An entry from before sites were kept knows no
//! site and is offered nowhere.

use dive_cdp::{CdpEvent, CdpSession};
use dive_core::TabId;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::Runtime;
use crate::error::AppResult;
use crate::page_world;
use crate::state::AppState;

const BINDING: &str = "__diveForms";
const MAX_PAYLOAD: usize = 64 * 1024;
/// Longer than any entry kept, so overlong values reach the filter intact.
const MAX_FIELD: usize = 256;
/// Matches offered at once.
const LIMIT: usize = 6;

fn script(nonce: &str) -> String {
    crate::pagescript::build(
        "forms.js",
        &[
            (
                "__NONCE__",
                serde_json::to_string(nonce).unwrap_or_else(|_| "null".into()),
            ),
            ("__BINDING__", BINDING.to_owned()),
        ],
    )
}

/// Install the script and binding on a tab and serve its requests.
pub async fn attach(app: AppHandle<Runtime>, tab_id: TabId, session: CdpSession) {
    let nonce = TabId::new().to_string().replace('-', "");
    let source = script(&nonce);
    let mut events = session.subscribe_to(&["Runtime.bindingCalled"]);
    // Registered for every document to come, before the first navigation.
    // The view is still on its blank document, so there is no page to
    // evaluate the script in now.
    if let Err(error) = page_world::install(&session, BINDING, &source).await {
        crate::cdp_feed::setup_failed(tab_id, "remembered form entries", &error);
        return;
    }
    tauri::async_runtime::spawn(async move {
        while let Some(event) =
            crate::cdp_feed::next_event(&mut events, tab_id, "remembered form entries").await
        {
            let Some(payload) = binding_payload(&event, &nonce) else {
                continue;
            };
            let Some(context) = page_world::calling_context(&session, &event) else {
                continue;
            };
            let Some(origin) = page_world::context_origin(&session, context).await else {
                continue;
            };
            let caller = Caller {
                session: &session,
                context,
                origin: &origin,
            };
            if let Err(error) = handle(&app, tab_id, &caller, &nonce, &payload).await {
                tracing::debug!(%tab_id, "form entries request failed: {error}");
            }
        }
    });
}

/// The parsed payload of a call to our binding carrying the right nonce.
pub fn binding_payload(event: &CdpEvent, nonce: &str) -> Option<Value> {
    if event.method != "Runtime.bindingCalled" || event.params["name"] != BINDING {
        return None;
    }
    let encoded = event.params["payload"].as_str()?;
    if encoded.len() > MAX_PAYLOAD {
        return None;
    }
    let payload: Value = serde_json::from_str(encoded).ok()?;
    (payload["nonce"].as_str() == Some(nonce)).then_some(payload)
}

fn text(value: &Value) -> String {
    value
        .as_str()
        .unwrap_or_default()
        .chars()
        .take(MAX_FIELD)
        .collect()
}

/// The `(field, value)` pairs of a submitted form worth remembering.
pub fn submitted_entries(payload: &Value) -> Vec<(String, String)> {
    payload["entries"]
        .as_array()
        .map(|list| {
            list.iter()
                .take(30)
                .map(|e| (text(&e["field"]).to_lowercase(), text(&e["value"])))
                .filter(|(f, v)| crate::browser_import::keep_form_entry(f, v))
                .collect()
        })
        .unwrap_or_default()
}

/// The document that called: its session, the context in Dive's world the
/// call came from (where the answer goes), and that document's origin.
struct Caller<'a> {
    session: &'a CdpSession,
    context: i64,
    origin: &'a str,
}

/// The evaluation that hands the page script its matches. `token` pairs the
/// answer with the question it answers; it is a number whatever was sent.
fn offer_expression(nonce: &str, token: u64, values: &[String]) -> String {
    format!(
        "window.__diveFormsOffer && window.__diveFormsOffer({}, {token}, {})",
        serde_json::to_string(nonce).unwrap_or_default(),
        serde_json::to_string(values).unwrap_or_default()
    )
}

async fn handle(
    app: &AppHandle<Runtime>,
    tab_id: TabId,
    caller: &Caller<'_>,
    nonce: &str,
    payload: &Value,
) -> AppResult<()> {
    let Some(profile) = crate::credential_fill::profile_of_tab(app, tab_id) else {
        return Ok(());
    };
    let state = app.state::<AppState>();
    match payload["kind"].as_str().unwrap_or_default() {
        "query" => {
            let field = text(&payload["field"]);
            let prefix = text(&payload["prefix"]);
            let token = payload["token"].as_u64().unwrap_or_default();
            let values: Vec<String> = {
                let store = crate::state::lock(&state.store);
                store
                    .form_entries_for(profile, caller.origin, &field, &prefix, LIMIT)?
                    .into_iter()
                    .map(|e| e.value)
                    .filter(|v| v != &prefix)
                    .collect()
            };
            // Back into the context that asked, which is in Dive's world:
            // the page's own world never sees the values.
            let expression = offer_expression(nonce, token, &values);
            let _ = page_world::evaluate_in(
                caller.session,
                caller.context,
                json!({"expression": expression}),
            )
            .await;
        }
        "used" | "submitted" if !crate::private_session::is_private() => {
            let entries = if payload["kind"] == "used" {
                vec![(
                    text(&payload["field"]).to_lowercase(),
                    text(&payload["value"]),
                )]
            } else {
                submitted_entries(payload)
            };
            let now = dive_core::Timestamp::now();
            let store = crate::state::lock(&state.store);
            for (field, value) in entries {
                store.record_form_entry(profile, caller.origin, &field, &value, now)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_our_binding_with_the_right_nonce_gets_through() {
        let event = |name: &str, payload: &str| CdpEvent {
            navigation_epoch: 0,
            method: "Runtime.bindingCalled".into(),
            params: json!({"name": name, "payload": payload}),
        };
        let ok = event(BINDING, r#"{"nonce":"n1","kind":"query","field":"email"}"#);
        assert_eq!(binding_payload(&ok, "n1").unwrap()["field"], "email");
        assert!(binding_payload(&ok, "n2").is_none());
        assert!(binding_payload(&event("__diveCredentials", r#"{"nonce":"n1"}"#), "n1").is_none());
    }

    #[test]
    fn the_offer_carries_a_numeric_token_and_encoded_values() {
        assert_eq!(
            offer_expression("n1", 7, &["a\"b".to_owned()]),
            r#"window.__diveFormsOffer && window.__diveFormsOffer("n1", 7, ["a\"b"])"#
        );
    }

    #[test]
    fn submitted_entries_drop_secrets_and_long_values() {
        let payload = json!({"entries": [
            {"field": "Email", "value": "dale@example.com"},
            {"field": "cvv", "value": "123"},
            {"field": "note", "value": "x".repeat(300)},
            {"field": "cc", "value": "4111 1111 1111 1111"},
            {"field": "", "value": "nameless"},
            {"field": "city", "value": "Cebu"}
        ]});
        assert_eq!(
            submitted_entries(&payload),
            vec![
                ("email".to_string(), "dale@example.com".to_string()),
                ("city".to_string(), "Cebu".to_string())
            ]
        );
    }
}
