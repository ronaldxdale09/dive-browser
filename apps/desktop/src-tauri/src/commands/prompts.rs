//! prompts commands.

// Tauri commands receive their arguments by value; that is the IPC contract.
#![allow(clippy::needless_pass_by_value)]

use dive_core::TabId;
use tauri::AppHandle;
use tauri_specta::Event;

use super::on_main;
use crate::Runtime;
use crate::error::AppResult;

/// Remember or forget a permission in the selected profile and real container.
#[tauri::command]
#[specta::specta]
pub(crate) fn permission_set(
    app: AppHandle<Runtime>,
    webview: tauri::Webview<Runtime>,
    scope: crate::permissions::Scope,
    origin: String,
    kind: String,
    decision: crate::permissions::Decision,
) -> AppResult<()> {
    on_main(&app, move |_, app, state| {
        crate::permissions::require_chrome(&webview)?;
        crate::permissions::set(app, state, &scope, &origin, &kind, decision)
    })
}

/// Resolve the original native request; its opaque ID carries trusted provenance.
#[tauri::command]
#[specta::specta]
pub(crate) fn permission_reply(
    app: AppHandle<Runtime>,
    webview: tauri::Webview<Runtime>,
    tab_id: TabId,
    request_id: String,
    decision: crate::permissions::Decision,
    duration: crate::permissions::Duration,
) -> AppResult<()> {
    on_main(&app, move |_, app, state| {
        crate::permissions::require_chrome(&webview)?;
        crate::permissions::reply(state, tab_id, &request_id, decision, duration)?;
        // Every window's chrome holds the question, not only the one that
        // answered it: a torn-off tab's window answers for the page, and the
        // main window must not keep a stale copy to show when the tab comes
        // back. `reply` has let go of the host and the store by now.
        let _ = crate::permissions::PermissionDismissed { request_id, tab_id }.emit(app);
        Ok(())
    })
}

/// Recover dialogs opened before this chrome subscribed to native events.
#[tauri::command]
#[specta::specta]
pub(crate) fn js_dialog_pending(
    app: AppHandle<Runtime>,
    webview: tauri::Webview<Runtime>,
    tab_id: TabId,
) -> AppResult<Vec<crate::js_dialog::JsDialogAsked>> {
    on_main(&app, move |_, _, state| {
        crate::permissions::require_chrome(&webview)?;
        Ok(state.js_dialogs.pending(tab_id))
    })
}

/// Answer a page's JavaScript dialog (`JsDialogAsked`); the page's script resumes.
#[tauri::command]
#[specta::specta]
pub(crate) fn js_dialog_answer(
    app: AppHandle<Runtime>,
    webview: tauri::Webview<Runtime>,
    tab_id: TabId,
    dialog_id: String,
    accept: bool,
    text: Option<String>,
) -> AppResult<()> {
    on_main(&app, move |_, app, state| {
        crate::permissions::require_chrome(&webview)?;
        crate::js_dialog::answer(app, state, tab_id, &dialog_id, accept, text).map(|_| ())
    })
}

/// Challenges opened before this chrome subscribed to native events.
#[tauri::command]
#[specta::specta]
pub(crate) fn http_auth_pending(
    app: AppHandle<Runtime>,
    webview: tauri::Webview<Runtime>,
    tab_id: TabId,
) -> AppResult<Vec<crate::http_auth::HttpAuthAsked>> {
    on_main(&app, move |_, _, state| {
        crate::permissions::require_chrome(&webview)?;
        Ok(state.http_auth.for_tab(tab_id))
    })
}

/// Answer a server's sign-in request (`HttpAuthAsked`). Without a username
/// the challenge is cancelled and the page sees the server's refusal.
#[tauri::command]
#[specta::specta]
pub(crate) async fn http_auth_answer(
    app: AppHandle<Runtime>,
    webview: tauri::Webview<Runtime>,
    tab_id: TabId,
    request_id: String,
    username: Option<String>,
    password: Option<String>,
) -> AppResult<()> {
    crate::permissions::require_chrome(&webview)?;
    let credentials = username.map(|user| (user, password.unwrap_or_default()));
    crate::http_auth::answer(&app, tab_id, &request_id, credentials).await
}

/// Remembered permissions in the active profile and container.
#[tauri::command]
#[specta::specta]
pub(crate) fn permissions_list(
    app: AppHandle<Runtime>,
    webview: tauri::Webview<Runtime>,
) -> AppResult<crate::permissions::PermissionList> {
    on_main(&app, move |_, _, state| {
        crate::permissions::require_chrome(&webview)?;
        Ok(crate::permissions::all(state)?)
    })
}

/// Answer a certificate question: `proceed` loads the page anyway and trusts
/// this certificate for this host until Dive quits; otherwise the navigation
/// fails and the page stays where it was. False when it was no longer waiting.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri hands command arguments over by value.
pub(crate) fn cert_error_answer(
    app: AppHandle<Runtime>,
    id: TabId,
    request_id: String,
    proceed: bool,
) -> AppResult<bool> {
    // On the main thread: the engine's callback belongs to its UI thread,
    // and continuing a request there is how every other answer is given.
    on_main(&app, move |_, app, _| {
        Ok(crate::cert_error::answer(app, id, &request_id, proceed))
    })
}

/// The certificate question waiting in tab `id`, for a chrome that has just
/// loaded and missed the event.
#[tauri::command]
#[specta::specta]
pub(crate) fn cert_error_pending(id: TabId) -> Option<crate::cert_error::CertErrorAsked> {
    crate::cert_error::pending(id)
}

/// Answer a page that stopped responding: `end` ends its renderer (the tab
/// then shows the crash banner with a reload), otherwise Dive keeps waiting.
/// False when the page had already recovered or was answered.
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_unresponsive_answer(
    app: AppHandle<Runtime>,
    id: TabId,
    end: bool,
) -> AppResult<bool> {
    #[cfg(feature = "cef")]
    return on_main(&app, move |_, app, _| {
        Ok(crate::crash::answer_hang(app, id, end))
    });
    #[cfg(not(feature = "cef"))]
    {
        let _ = (app, id, end);
        Ok(false)
    }
}
