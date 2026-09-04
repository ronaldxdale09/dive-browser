//! Opt-in native lifecycle regression, run only against a disposable profile.
//! Uses the same tab, detach, attach, and native window-close paths as the UI.

use std::time::Duration;

use dive_core::TabId;
use tauri::Manager;

use crate::{AppError, Runtime, commands, engine, state};

async fn on_main<T: Send + 'static>(
    app: &tauri::AppHandle<Runtime>,
    run: impl FnOnce(&tauri::AppHandle<Runtime>) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(run(&handle));
    })?;
    rx.await.map_err(AppError::new)?
}

fn popout(app: &tauri::AppHandle<Runtime>, id: TabId) -> Option<tauri::Window<Runtime>> {
    app.windows()
        .into_values()
        .find(|window| engine::popout_tab(window.label()) == Some(id))
}

async fn run(app: &tauri::AppHandle<Runtime>, mode: &str) -> Result<(), AppError> {
    let ids = on_main(app, |handle| {
        let main = engine::MainThread::here().ok_or_else(|| AppError::new("not main thread"))?;
        let state = handle.state::<state::AppState>();
        let workspace = (*state::lock(&state.active_workspace))
            .ok_or_else(|| AppError::new("no active workspace"))?;
        let first = commands::open_tab(&main, handle, &state, workspace, "about:blank")?;
        let second = commands::open_tab(&main, handle, &state, workspace,
            "data:text/html,%3Ctitle%3EDive%20navigation%20probe%3C/title%3E%3Cp%3EHistory%20fixture%3C/p%3E")?;
        Ok([first.id, second.id])
    })
    .await?;
    // Wait for both real CEF sessions to answer before exercising teardown.
    for id in ids {
        assert_renderer_alive(app, id).await?;
    }
    verify_navigation(app, ids[1]).await?;
    #[cfg(feature = "cef")]
    verify_ipc_boundary(app).await?;
    on_main(app, move |handle| {
        commands::tab_detach(handle.clone(), ids[0], None)?;
        popout(handle, ids[0])
            .ok_or_else(|| AppError::new("detach did not create window"))?
            .close()?;
        Ok(())
    })
    .await?;
    let mut closed = false;
    for _ in 0..100 {
        closed = on_main(app, move |handle| {
            let state = handle.state::<state::AppState>();
            Ok(popout(handle, ids[0]).is_none()
                && !state::lock(&state.host)
                    .as_ref()
                    .is_some_and(|h| h.has(ids[0])))
        })
        .await?;
        if closed {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    if !closed {
        return Err(AppError::new("popout close did not complete"));
    }
    assert_renderer_alive(app, ids[1]).await?;
    on_main(app, move |handle| {
        commands::tab_detach(handle.clone(), ids[1], None)?;
        commands::tab_attach(handle.clone(), ids[1])?;
        let state = handle.state::<state::AppState>();
        if state::lock(&state.host)
            .as_ref()
            .is_none_or(|h| !h.has(ids[1]) || h.is_detached(ids[1]))
        {
            return Err(AppError::new("reattach did not restore main-window tab"));
        }
        Ok(())
    })
    .await?;
    assert_renderer_alive(app, ids[1]).await?;
    println!("DIVE_LIFECYCLE_PROBE: popout close and reattach verified");
    if mode == "quit" {
        // Quit while a detached window and its renderer are still alive.
        on_main(app, move |handle| {
            commands::tab_detach(handle.clone(), ids[1], None)
        })
        .await?;
        println!("DIVE_LIFECYCLE_PROBE: quit requested with detached window");
        app.exit(0);
    } else {
        on_main(app, |handle| {
            handle
                .get_window(crate::MAIN_WINDOW)
                .ok_or_else(|| AppError::new("main window missing"))?
                .close()?;
            Ok(())
        })
        .await?;
        println!("DIVE_LIFECYCLE_PROBE: main window close requested");
    }
    Ok(())
}

#[cfg(feature = "cef")]
fn chrome_probe_session(view: &tauri::Webview<Runtime>) -> Result<dive_cdp::CdpSession, AppError> {
    struct Transport(tauri::Webview<Runtime>);
    impl dive_cdp::Transport for Transport {
        fn send(&self, message: &str) -> Result<(), dive_cdp::CdpError> {
            self.0
                .send_dev_tools_message(message.as_bytes())
                .map_err(|error| dive_cdp::CdpError::Transport(error.to_string()))
        }
    }
    let session = dive_cdp::CdpSession::new(Transport(view.clone()));
    let sink = session.clone();
    view.on_dev_tools_protocol(move |protocol| {
        if let tauri::CefDevToolsProtocol::Message(bytes) = protocol
            && let Ok(text) = std::str::from_utf8(&bytes)
        {
            let _ = sink.handle_incoming(text);
        }
    })?;
    Ok(session)
}

#[cfg(feature = "cef")]
async fn probe_evaluate(
    session: &dive_cdp::CdpSession,
    expression: &str,
) -> Result<serde_json::Value, AppError> {
    let response = session.call("Runtime.evaluate", serde_json::json!({"expression": expression, "returnByValue": true, "awaitPromise": true})).await.map_err(AppError::new)?;
    if response.get("exceptionDetails").is_some() {
        return Err(AppError::new("IPC probe evaluation threw"));
    }
    Ok(response["result"]["value"].clone())
}

#[cfg(feature = "cef")]
async fn wait_ipc_ready(session: &dive_cdp::CdpSession) -> Result<(), AppError> {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if probe_evaluate(session, "location.origin === 'http://tauri.localhost' && typeof window.__TAURI_INTERNALS__?.invoke === 'function'").await? == true {
                return Ok::<_, AppError>(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }).await.map_err(AppError::new)?
}

#[cfg(feature = "cef")]
async fn verify_ipc_boundary(app: &tauri::AppHandle<Runtime>) -> Result<(), AppError> {
    let chrome = on_main(app, |handle| {
        chrome_probe_session(
            &handle
                .get_webview(crate::CHROME_LABEL)
                .ok_or_else(|| AppError::new("chrome missing"))?,
        )
    })
    .await?;
    wait_ipc_ready(&chrome).await?;
    // Positive controls prove both names and arguments are real supported commands.
    let check = "(async () => { const invoke = window.__TAURI_INTERNALS__.invoke; const outcomes = []; for (const [command, args] of [['snapshot', {}], ['plugin:window|is_fullscreen', {label:'main'}]]) { try { await invoke(command, args); outcomes.push('allowed'); } catch { outcomes.push('denied'); } } return outcomes; })()";
    if probe_evaluate(&chrome, check).await? != serde_json::json!(["allowed", "allowed"]) {
        return Err(AppError::new("trusted chrome IPC positive control failed"));
    }
    chrome.close();
    let id = on_main(app, |handle| {
        let main = engine::MainThread::here().ok_or_else(|| AppError::new("not main thread"))?;
        let state = handle.state::<state::AppState>();
        let workspace =
            (*state::lock(&state.active_workspace)).ok_or_else(|| AppError::new("no workspace"))?;
        Ok(commands::open_tab(&main, handle, &state, workspace, "http://tauri.localhost/")?.id)
    })
    .await?;
    let page = state::lock(&app.state::<state::AppState>().host)
        .as_ref()
        .and_then(|host| host.cdp(id))
        .ok_or_else(|| AppError::new("probe tab missing"))?;
    wait_ipc_ready(&page).await?;
    if probe_evaluate(&page, check).await? != serde_json::json!(["denied", "denied"]) {
        return Err(AppError::new(
            "local app content in a page tab received chrome authority",
        ));
    }
    on_main(app, move |handle| commands::tab_close(handle.clone(), id)).await?;
    println!("DIVE_LIFECYCLE_PROBE: chrome IPC boundary verified");
    Ok(())
}

async fn verify_navigation(app: &tauri::AppHandle<Runtime>, id: TabId) -> Result<(), AppError> {
    let session = state::lock(&app.state::<state::AppState>().host)
        .as_ref()
        .and_then(|host| host.cdp(id))
        .ok_or_else(|| AppError::new("missing history probe session"))?;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let ready = session.call("Runtime.evaluate", serde_json::json!({
                "expression": "document.title === 'Dive navigation probe' && document.readyState === 'complete'",
                "returnByValue": true
            })).await.map_err(AppError::new)?;
            if ready["result"]["value"] == true { return Ok::<_, AppError>(()); }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.map_err(AppError::new)??;
    let initial = crate::navigation::tab_history(app.state(), id).await?;
    let result = session.call("Runtime.evaluate", serde_json::json!({
        "expression": "history.pushState({diveProbe:1}, ''); history.pushState({diveProbe:2}, ''); true",
        "returnByValue": true,
        "userGesture": true
    })).await.map_err(AppError::new)?;
    if result["result"]["value"] != true {
        return Err(AppError::new("same-URL history fixture failed"));
    }
    let pushed = crate::navigation::tab_history(app.state(), id).await?;
    if pushed.current_index != initial.current_index + 2 {
        return Err(AppError::new(
            "same-URL entries missing from native history",
        ));
    }
    let middle_index = initial.current_index + 1;
    let middle = &pushed.entries[usize::try_from(middle_index).map_err(AppError::new)?];
    crate::navigation::tab_history_navigate(app.state(), id, pushed.generation.clone(), middle.id)
        .await?;
    wait_history_index(app, &session, id, middle_index, Some(1)).await?;
    on_main(app, move |handle| commands::tab_back(handle.state(), id)).await?;
    wait_history_index(app, &session, id, initial.current_index, None).await?;
    on_main(app, move |handle| commands::tab_forward(handle.state(), id)).await?;
    wait_history_index(app, &session, id, middle_index, Some(1)).await?;
    if crate::navigation::tab_history_navigate(app.state(), id, "replaced-view".into(), middle.id)
        .await
        .is_ok()
    {
        return Err(AppError::new(
            "stale native history generation was accepted",
        ));
    }
    let unchanged = crate::navigation::tab_history(app.state(), id).await?;
    if unchanged.current_index != middle_index {
        return Err(AppError::new("rejected history request still navigated"));
    }
    println!("DIVE_LIFECYCLE_PROBE: native navigation history verified");
    Ok(())
}

async fn wait_history_index(
    app: &tauri::AppHandle<Runtime>,
    session: &dive_cdp::CdpSession,
    id: TabId,
    expected: i32,
    expected_state: Option<i32>,
) -> Result<(), AppError> {
    let state_check = expected_state.map_or_else(
        || "history.state === null".to_owned(),
        |value| format!("history.state?.diveProbe === {value}"),
    );
    let expression = format!(
        "document.title === 'Dive navigation probe' && document.readyState === 'complete' && ({state_check})"
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match crate::navigation::tab_history(app.state(), id).await {
                Ok(history) if history.current_index == expected => {
                    // currentIndex includes a pending entry in Chromium. The
                    // fixture's actual committed state must agree before the
                    // next user action, including same-URL history traversal.
                    let value = session
                        .call(
                            "Runtime.evaluate",
                            serde_json::json!({"expression": expression, "returnByValue": true}),
                        )
                        .await;
                    match value {
                        Ok(value) if value["result"]["value"] == true => {
                            return Ok::<_, AppError>(());
                        }
                        Ok(_) => {}
                        Err(dive_cdp::CdpError::Protocol {
                            code: -32000,
                            message,
                        }) if message == "Not attached to an active page" => {}
                        Err(error) => return Err(AppError::new(error)),
                    }
                }
                Ok(_) => {}
                Err(error)
                    if error.message == "cdp error -32000: Not attached to an active page" => {}
                Err(error) => return Err(error),
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(AppError::new)?
}

async fn assert_renderer_alive(app: &tauri::AppHandle<Runtime>, id: TabId) -> Result<(), AppError> {
    let session = state::lock(&app.state::<state::AppState>().host)
        .as_ref()
        .and_then(|host| host.cdp(id))
        .ok_or_else(|| AppError::new("missing CDP session"))?;
    let value = tokio::time::timeout(
        Duration::from_secs(5),
        session.call(
            "Runtime.evaluate",
            serde_json::json!({"expression": "6 * 7", "returnByValue": true}),
        ),
    )
    .await
    .map_err(AppError::new)?
    .map_err(AppError::new)?;
    if value["result"]["value"] != 42 {
        return Err(AppError::new(
            "renderer did not return expected evaluation result",
        ));
    }
    Ok(())
}

/// After the memory sampling phase, prove discarded views left Tauri's
/// registry and a discarded tab can reopen its persisted page exactly once.
pub(crate) async fn verify_discarded_and_wake(
    app: &tauri::AppHandle<Runtime>,
) -> Result<(), AppError> {
    let (tab, before) = on_main(app, |handle| {
        let state = handle.state::<state::AppState>();
        let workspace = (*state::lock(&state.active_workspace))
            .ok_or_else(|| AppError::new("no active workspace"))?;
        let views = handle.webviews();
        let store = state::lock(&state.store);
        let discarded: Vec<_> = store
            .tabs_for_workspace(workspace)?
            .into_iter()
            .filter(|tab| tab.state == dive_core::TabState::Discarded)
            .collect();
        for tab in &discarded {
            if views
                .keys()
                .any(|label| engine::tab_from_label(label) == Some(tab.id))
            {
                return Err(AppError::new(
                    "discarded tab retained a Tauri webview registration",
                ));
            }
        }
        Ok((
            discarded
                .into_iter()
                .next()
                .ok_or_else(|| AppError::new("no discarded tab to verify wake"))?,
            views.len(),
        ))
    })
    .await?;
    let id = tab.id;
    on_main(app, move |handle| {
        commands::tab_activate(handle.clone(), id)
    })
    .await?;
    let session = state::lock(&app.state::<state::AppState>().host)
        .as_ref()
        .and_then(|host| host.cdp(id))
        .ok_or_else(|| AppError::new("waking tab has no CDP session"))?;
    let expression = format!(
        "location.href === {} && document.readyState === 'complete'",
        serde_json::to_string(&tab.url).map_err(AppError::new)?
    );
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let reply = session
                .call(
                    "Runtime.evaluate",
                    serde_json::json!({"expression": expression, "returnByValue": true}),
                )
                .await
                .map_err(AppError::new)?;
            if reply["result"]["value"] == true {
                return Ok::<_, AppError>(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .map_err(AppError::new)??;
    on_main(app, move |handle| {
        let views = handle.webviews();
        if views.len() != before + 1
            || views
                .keys()
                .filter(|label| engine::tab_from_label(label) == Some(id))
                .count()
                != 1
        {
            return Err(AppError::new(
                "wake did not create exactly one registered view",
            ));
        }
        Ok(())
    })
    .await?;
    println!("stress: lifecycle registry and wake verified");
    Ok(())
}

pub(crate) fn start(app: tauri::AppHandle<Runtime>) {
    let Ok(mode) = std::env::var("DIVE_NATIVE_LIFECYCLE_PROBE") else {
        return;
    };
    if !matches!(mode.as_str(), "quit" | "window-close")
        || std::env::var_os("DIVE_DATA_DIR").is_none()
    {
        tracing::error!(
            "lifecycle probe requires quit/window-close mode and an explicit disposable profile"
        );
        app.exit(2);
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(error) = run(&app, &mode).await {
            tracing::error!(%error, "native lifecycle probe failed");
            app.exit(1);
        }
    });
}
