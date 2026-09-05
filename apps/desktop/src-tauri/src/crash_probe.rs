//! A real renderer crash with separately isolated, unchanged control documents.
//! Runs only within the explicit disposable native lifecycle qualification.

use std::{sync::Arc, time::Duration};

use cef::{ImplBrowser, ImplBrowserHost, ImplRequestContext};
use dive_cdp::{CdpEventReceiver, CdpSession};
use dive_core::{Container, Profile, TabId, Workspace};
use serde_json::{Value, json};
use tauri::{Listener, Manager};
use tauri_specta::Event;

use crate::lifecycle_probe::{chrome_probe_session, on_main, read_probe_value};
use crate::{AppError, Runtime, commands, crash::TabCrashed, engine, state};

const DOCUMENT: &str = "data:text/html,%3Ctitle%3EDive%20crash%20fixture%3C/title%3E%3Cp%3EIsolated%20renderer%20fixture%3C/p%3E";
const SENTINEL: &str = "__diveCrashProbeDocument";

fn configuration_allowed(flag: &str, mock: &str, disposable: bool, overrides: bool) -> bool {
    flag == "1" && mock == "1" && disposable && !overrides
}

struct Page {
    session: CdpSession,
    native: cef::Browser,
    browser_id: i32,
    label: String,
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
struct Document {
    sentinel: Value,
    loader: String,
    isolate: String,
}

async fn evaluate(session: &CdpSession, expression: &str) -> Result<Value, AppError> {
    let response = session
        .call(
            "Runtime.evaluate",
            json!({
                "expression": expression, "returnByValue": true, "awaitPromise": true,
            }),
        )
        .await
        .map_err(AppError::new)?;
    if response.get("exceptionDetails").is_some() {
        return Err(AppError::new("crash probe evaluation threw"));
    }
    Ok(response["result"]["value"].clone())
}

fn required_string(value: &Value, key: &str) -> Result<String, AppError> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| AppError::new(format!("crash probe missing {key}")))
}

async fn document(session: &CdpSession) -> Result<Document, AppError> {
    let sentinel = evaluate(session, &format!("window.{SENTINEL} ?? null")).await?;
    let frame = session
        .call0("Page.getFrameTree")
        .await
        .map_err(AppError::new)?;
    let isolate = session
        .call0("Runtime.getIsolateId")
        .await
        .map_err(AppError::new)?;
    Ok(Document {
        sentinel,
        loader: required_string(&frame["frameTree"]["frame"], "loaderId")?,
        isolate: required_string(&isolate, "id")?,
    })
}

async fn mark(page: &Page) -> Result<Document, AppError> {
    for domain in ["Runtime.enable", "Page.enable", "Inspector.enable"] {
        page.session.call0(domain).await.map_err(AppError::new)?;
    }
    let nonce = serde_json::to_string(&TabId::new().to_string()).map_err(AppError::new)?;
    // Installed once in this document, never as a new-document script or in
    // sessionStorage. A reload cannot silently recreate this control marker.
    evaluate(&page.session, &format!(
        "Object.defineProperty(window, '{SENTINEL}', {{value: Object.freeze({{nonce: {nonce}, timeOrigin: performance.timeOrigin}}), configurable: true}}); true"
    )).await?;
    let marked = document(&page.session).await?;
    if marked.sentinel["nonce"].as_str().is_none()
        || marked.sentinel["timeOrigin"].as_f64().is_none()
    {
        return Err(AppError::new(
            "crash probe failed to install document marker",
        ));
    }
    Ok(marked)
}

async fn page(view: tauri::Webview<Runtime>, session: CdpSession) -> Result<Page, AppError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    view.with_webview(move |native| {
        let _ = tx.send(native.browser());
    })?;
    let native = tokio::time::timeout(Duration::from_secs(5), rx)
        .await
        .map_err(AppError::new)?
        .map_err(AppError::new)?;
    let browser_id = native.identifier();
    Ok(Page {
        label: view.label().to_owned(),
        session,
        native,
        browser_id,
    })
}

fn create_workspace(store: &dive_core::Store, name: &str) -> Result<Workspace, AppError> {
    let container = Container::new(name);
    let profile = Profile::new(name, container.id, 99);
    let workspace = Workspace::new(name, container.id, profile.id, 99);
    store.upsert_container(&container)?;
    store.upsert_profile(&profile)?;
    store.upsert_workspace(&workspace)?;
    Ok(workspace)
}

async fn fixture(
    app: &tauri::AppHandle<Runtime>,
    name: &'static str,
) -> Result<(TabId, Page), AppError> {
    let (id, view, session) = on_main(app, move |app| {
        let state = app.state::<state::AppState>();
        let workspace = create_workspace(&state::lock(&state.store), name)?;
        let main = engine::MainThread::here().ok_or_else(|| AppError::new("not main thread"))?;
        let tab = commands::open_tab(&main, app, &state, workspace.id, DOCUMENT)?;
        let host = state::lock(&state.host);
        let host = host
            .as_ref()
            .ok_or_else(|| AppError::new("crash probe host missing"))?;
        Ok((
            tab.id,
            host.with_view(tab.id, |view| Ok(view.clone()))?,
            host.cdp(tab.id)
                .ok_or_else(|| AppError::new("crash probe CDP missing"))?,
        ))
    })
    .await?;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if read_probe_value(
                &session,
                "document.title === 'Dive crash fixture' && document.readyState === 'complete'",
            )
            .await?
                == true
            {
                return Ok::<_, AppError>(());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(AppError::new)??;
    Ok((id, page(view, session).await?))
}

async fn isolation(
    app: &tauri::AppHandle<Runtime>,
    target: &Page,
    controls: [&Page; 2],
) -> Result<(), AppError> {
    let browsers = [
        target.native.clone(),
        controls[0].native.clone(),
        controls[1].native.clone(),
    ];
    on_main(app, move |_| {
        let contexts = browsers
            .iter()
            .map(|browser| {
                browser
                    .host()
                    .and_then(|host| host.request_context())
                    .ok_or_else(|| AppError::new("crash probe native request context missing"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        for control in &contexts[1..] {
            let mut control = control.clone();
            if contexts[0].is_same(Some(&mut control)) != 0
                || contexts[0].is_sharing_with(Some(&mut control)) != 0
            {
                return Err(AppError::new(
                    "crash target shares a native context with a control",
                ));
            }
        }
        Ok(())
    })
    .await
}

fn control_event(method: &str, params: &Value) -> bool {
    matches!(
        method,
        "Inspector.targetCrashed" | "Inspector.detached" | "Runtime.executionContextsCleared"
    ) || (method == "Page.frameNavigated" && params["frame"]["parentId"].is_null())
}

fn unchanged_events(events: &mut CdpEventReceiver) -> Result<(), AppError> {
    loop {
        match events.try_recv() {
            Ok(event) if control_event(&event.method, &event.params) => {
                return Err(AppError::new(format!(
                    "crash control changed: {}",
                    event.method
                )));
            }
            Ok(_) => {}
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => return Ok(()),
            Err(error) => return Err(AppError::new(error)),
        }
    }
}

async fn unchanged(
    page: &Page,
    before: &Document,
    events: &mut CdpEventReceiver,
) -> Result<(), AppError> {
    unchanged_events(events)?;
    if document(&page.session).await? != *before {
        return Err(AppError::new(format!(
            "crash control document replaced: {}",
            page.label
        )));
    }
    unchanged_events(events)
}

async fn native_unchanged(
    app: &tauri::AppHandle<Runtime>,
    pages: [&Page; 3],
) -> Result<(), AppError> {
    let expected = pages.map(|page| (page.label.clone(), page.browser_id, page.native.clone()));
    on_main(app, move |app| {
        for (label, id, browser) in expected {
            if browser.is_valid() == 0
                || browser.identifier() != id
                || app.get_webview(&label).is_none()
            {
                return Err(AppError::new("crash replaced a native browser or view"));
            }
            if let Some(tab) = engine::tab_from_label(&label) {
                if app
                    .webviews()
                    .keys()
                    .filter(|label| engine::tab_from_label(label) == Some(tab))
                    .count()
                    != 1
                {
                    return Err(AppError::new("crash duplicated a native tab view"));
                }
                let state = app.state::<state::AppState>();
                let host = state::lock(&state.host);
                if !host
                    .as_ref()
                    .ok_or_else(|| AppError::new("host missing"))?
                    .with_view(tab, |view| Ok(view.label() == label))?
                {
                    return Err(AppError::new("crash changed a native view generation"));
                }
            }
        }
        Ok(())
    })
    .await
}

fn one_recovery(notices: &[TabCrashed], target: TabId) -> Result<(), AppError> {
    if notices.len() != 1
        || notices[0].tab_id != target
        || !notices[0].recovering
        || notices[0].attempt != 1
    {
        return Err(AppError::new(
            "one injected crash did not produce exactly one target recovery attempt",
        ));
    }
    Ok(())
}

async fn exercise(
    app: &tauri::AppHandle<Runtime>,
    target_id: TabId,
    target: &Page,
    sibling: &Page,
    chrome: &Page,
) -> Result<(), AppError> {
    isolation(app, target, [sibling, chrome]).await?;
    let target_before = mark(target).await?;
    let sibling_before = mark(sibling).await?;
    let chrome_before = mark(chrome).await?;
    if target_before.isolate == sibling_before.isolate
        || target_before.isolate == chrome_before.isolate
    {
        return Err(AppError::new(
            "crash target shares a renderer isolate with a control",
        ));
    }
    let mut target_events = target.session.subscribe();
    let mut sibling_events = sibling.session.subscribe();
    let mut chrome_events = chrome.session.subscribe();
    let notices = Arc::new(std::sync::Mutex::new(Vec::new()));
    let capture = notices.clone();
    let listener = TabCrashed::listen(app, move |event| state::lock(&capture).push(event.payload));
    // This call may lose its reply with the renderer. It is issued exactly
    // once, and a missing reply never authorizes another destructive attempt.
    let crash_call = target.session.call0("Page.crash");
    let outcome = async {
        let mut crashed = false;
        loop {
            loop {
                match target_events.try_recv() {
                    Ok(event) => crashed |= event.method == "Inspector.targetCrashed",
                    Err(tokio::sync::broadcast::error::TryRecvError::Empty) => break,
                    Err(error) => return Err(AppError::new(error)),
                }
            }
            unchanged(sibling, &sibling_before, &mut sibling_events).await?;
            unchanged(chrome, &chrome_before, &mut chrome_events).await?;
            let recovered = {
                let notices = state::lock(&notices);
                if notices
                    .iter()
                    .any(|event| event.tab_id != target_id || !event.recovering)
                {
                    return Err(AppError::new(
                        "crash recovery affected another tab or exhausted its budget",
                    ));
                }
                notices
                    .iter()
                    .any(|event| event.tab_id == target_id && event.recovering)
            };
            if crashed && recovered {
                // A fresh fixture document must replace the target's marker.
                // Transient target errors are expected only in this bounded
                // read loop; the controls never tolerate replacement/errors.
                if let Ok(after) = document(&target.session).await
                    && after.sentinel.is_null() && after.loader != target_before.loader
                    && evaluate(&target.session, "document.title === 'Dive crash fixture' && document.readyState === 'complete'").await.unwrap_or(Value::Null) == true
                {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // Drain delayed sibling/native reports after the target has settled.
        tokio::time::sleep(Duration::from_millis(300)).await;
        unchanged(sibling, &sibling_before, &mut sibling_events).await?;
        unchanged(chrome, &chrome_before, &mut chrome_events).await?;
        one_recovery(&state::lock(&notices), target_id)?;
        native_unchanged(app, [target, sibling, chrome]).await?;
        if evaluate(
            &chrome.session,
            "window.__TAURI_INTERNALS__.invoke('snapshot', {}).then(value => !!value)",
        )
        .await?
            != true
        {
            return Err(AppError::new("chrome IPC failed after isolated crash"));
        }
        println!(
            "DIVE_CRASH_PROBE_DETAIL: {}",
            json!({
                "target": {"tab_id": target_id, "view": target.label, "browser_id": target.browser_id, "before": target_before, "after": document(&target.session).await?},
                "sibling": {"view": sibling.label, "browser_id": sibling.browser_id, "unchanged": sibling_before},
                "chrome": {"view": chrome.label, "browser_id": chrome.browser_id, "unchanged": chrome_before},
                "crash_commands": 1, "recovery_attempts": 1,
            })
        );
        Ok(())
    };
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        tokio::pin!(crash_call);
        tokio::pin!(outcome);
        tokio::select! {
            result = &mut outcome => result,
            response = &mut crash_call => {
                // Unsupported commands are qualification failures. A crashing
                // target may instead reply with a target-closed error.
                if matches!(response, Err(dive_cdp::CdpError::Protocol { code: -32601, .. })) {
                    return Err(AppError::new("native Page.crash is unavailable"));
                }
                outcome.await
            }
        }
    })
    .await
    .map_err(AppError::new)
    .and_then(|result| result);
    app.unlisten(listener);
    result
}

pub(crate) async fn verify(app: &tauri::AppHandle<Runtime>) -> Result<(), AppError> {
    let overrides = [
        "DIVE_CHROMIUM_FLAGS",
        "DIVE_DEFAULT_PROCESS_MODEL",
        "DIVE_RENDERER_PROCESS_LIMIT",
    ]
    .iter()
    .any(|name| std::env::var_os(name).is_some());
    if !configuration_allowed(
        &std::env::var("DIVE_CRASH_PROBE").unwrap_or_default(),
        &std::env::var("DIVE_USE_MOCK_KEYCHAIN").unwrap_or_default(),
        std::env::var_os("DIVE_DATA_DIR").is_some_and(|path| !path.is_empty()),
        overrides,
    ) {
        return Err(AppError::new(
            "crash probe requires flag=1, mock keychain=1, explicit disposable profile and shipping process settings",
        ));
    }
    let (target_id, target) = fixture(app, "Crash probe target").await?;
    let (sibling_id, sibling) = fixture(app, "Crash probe control").await?;
    let (view, session) = on_main(app, |app| {
        let view = app
            .get_webview(crate::CHROME_LABEL)
            .ok_or_else(|| AppError::new("chrome missing"))?;
        let session = chrome_probe_session(&view)?;
        Ok((view, session))
    })
    .await?;
    let chrome = page(view, session).await?;
    // Activate only the target; the control remains a live background page.
    on_main(app, move |app| {
        commands::tab_activate(app.clone(), target_id)
    })
    .await?;
    let result = exercise(app, target_id, &target, &sibling, &chrome).await;
    chrome.session.close();
    result?;
    on_main(app, move |app| {
        commands::tab_close(app.clone(), target_id)?;
        commands::tab_close(app.clone(), sibling_id)
    })
    .await?;
    println!(
        "DIVE_CRASH_PROBE: Page.crash once, isolated context, in-place recovery and unchanged sibling/chrome documents verified"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crash_qualification_requires_explicit_isolation_and_shipping_process_settings() {
        assert!(configuration_allowed("1", "1", true, false));
        for args in [
            ("", "1", true, false),
            ("1", "0", true, false),
            ("1", "1", false, false),
            ("1", "1", true, true),
        ] {
            assert!(!configuration_allowed(args.0, args.1, args.2, args.3));
        }
    }

    #[test]
    fn control_navigation_and_renderer_loss_cannot_pass_as_unchanged() {
        for method in [
            "Inspector.targetCrashed",
            "Inspector.detached",
            "Runtime.executionContextsCleared",
        ] {
            assert!(control_event(method, &json!({})));
        }
        assert!(control_event(
            "Page.frameNavigated",
            &json!({"frame":{"id":"main"}})
        ));
        assert!(!control_event(
            "Page.frameNavigated",
            &json!({"frame":{"id":"sub","parentId":"main"}})
        ));
        assert!(!control_event("Network.requestWillBeSent", &json!({})));
        assert!(required_string(&json!({}), "loaderId").is_err());
    }
}
