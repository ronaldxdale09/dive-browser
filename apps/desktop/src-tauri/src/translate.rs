//! Translating a page, on the machine it is read on.
//!
//! Chromium 151 carries an on-device translator: the engine downloads a
//! language pair once and runs it locally, so a translated page is never a
//! page posted to a translation service. The work happens in the page -- the
//! script walks its text nodes and keeps every original -- and the host only
//! starts it and reports how it went.
//!
//! The first translation for a pair downloads a model, which the API refuses
//! without a user gesture. The person asking is a click in the chrome, not in
//! the page, so the call carries `userGesture` to say so.

use dive_cdp::CdpSession;
use dive_core::TabId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;

use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// How a translation went, as the chrome reports it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Translation {
    /// The page is now translated.
    pub ok: bool,
    /// Why not, when it is not: `unsupported` (no translator in this build),
    /// `unsupported-pair`, `unavailable` (no model, or it would not download),
    /// `unknown-language`, `already` (the page is in that language), `empty`.
    pub reason: Option<String>,
    /// The language the page was in.
    pub from: Option<String>,
    /// The language it was translated to.
    pub target: Option<String>,
    /// How many pieces of text changed.
    pub changed: Option<f64>,
}

/// What a tab could be translated from, and whether it already has been.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct TranslateState {
    pub translated: bool,
    pub target: Option<String>,
    /// The page's own language, as it declares or reads.
    pub language: Option<String>,
    /// Whether this build can translate at all.
    pub supported: bool,
}

/// A language tag Dive will pass to the engine: two letters, so nothing
/// typed by a page or a stale preference reaches the API unchecked.
pub fn normalize_language(tag: &str) -> Option<String> {
    let base: String = tag
        .trim()
        .chars()
        .take_while(char::is_ascii_alphabetic)
        .collect::<String>()
        .to_lowercase();
    (base.len() == 2).then_some(base)
}

fn session_for(state: &AppState, tab_id: TabId) -> AppResult<CdpSession> {
    let host = lock(&state.host);
    host.as_ref()
        .and_then(|host| {
            host.sessions()
                .into_iter()
                .find_map(|(id, session)| (id == tab_id).then_some(session))
        })
        .ok_or_else(|| AppError::new("this tab is not loaded"))
}

async fn run(session: &CdpSession, expression: &str, gesture: bool) -> AppResult<Value> {
    let source = crate::pagescript::build("translate.js", &[]);
    // The script installs itself once; re-evaluating it is a no-op, and a
    // page that has navigated since needs it again.
    let _ = session
        .call(
            "Runtime.evaluate",
            json!({"expression": source, "userGesture": gesture}),
        )
        .await;
    let result = session
        .call(
            "Runtime.evaluate",
            json!({
                "expression": expression,
                "awaitPromise": true,
                "returnByValue": true,
                "userGesture": gesture,
            }),
        )
        .await
        .map_err(|error| AppError::new(format!("this page could not be translated: {error}")))?;
    if let Some(details) = result.get("exceptionDetails")
        && !details.is_null()
    {
        return Err(AppError::new("this page could not be translated"));
    }
    Ok(result["result"]["value"].clone())
}

/// Translate the tab's page into `target`.
pub async fn translate(state: &AppState, tab_id: TabId, target: &str) -> AppResult<Translation> {
    let target = normalize_language(target)
        .ok_or_else(|| AppError::new("that is not a language Dive can ask for"))?;
    let session = session_for(state, tab_id)?;
    let value = run(
        &session,
        &format!("window.__diveTranslate({})", json!(target)),
        true,
    )
    .await?;
    Ok(Translation {
        ok: value["ok"].as_bool().unwrap_or(false),
        reason: value["reason"].as_str().map(str::to_owned),
        from: value["from"].as_str().map(str::to_owned),
        target: Some(target),
        changed: value["changed"].as_f64(),
    })
}

/// Put the page's own words back.
pub async fn restore(state: &AppState, tab_id: TabId) -> AppResult<()> {
    let session = session_for(state, tab_id)?;
    run(&session, "window.__diveTranslateRestore()", false).await?;
    Ok(())
}

/// Whether this page could be translated, and whether it already is.
pub async fn state_of(state: &AppState, tab_id: TabId) -> AppResult<TranslateState> {
    let session = session_for(state, tab_id)?;
    let value = run(&session, "window.__diveTranslateState()", false).await?;
    Ok(TranslateState {
        translated: value["translated"].as_bool().unwrap_or(false),
        target: value["target"].as_str().map(str::to_owned),
        language: value["language"]
            .as_str()
            .filter(|tag| !tag.is_empty())
            .map(str::to_owned),
        supported: value["supported"].as_bool().unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_plain_language_tag_reaches_the_engine() {
        assert_eq!(normalize_language("en"), Some("en".into()));
        assert_eq!(normalize_language("EN"), Some("en".into()));
        // A region or a script is dropped; the API takes the base language.
        assert_eq!(normalize_language("pt-BR"), Some("pt".into()));
        assert_eq!(normalize_language("zh_Hans"), Some("zh".into()));
        // Anything else is refused rather than passed through.
        assert_eq!(normalize_language(""), None);
        assert_eq!(normalize_language("english"), None);
        assert_eq!(normalize_language("e"), None);
        assert_eq!(normalize_language("'); alert(1); //"), None);
    }
}
