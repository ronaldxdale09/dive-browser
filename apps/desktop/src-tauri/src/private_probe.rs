//! Disposable, opt-in regression for the real CEF private-session boundary.
use crate::lifecycle_probe::{on_main, read_probe_value};
use crate::{AppError, Runtime, commands, engine, state};
use dive_core::TabId;
use serde_json::{Value, json};
use std::time::Duration;
use tauri::Manager;

async fn open(
    app: &tauri::AppHandle<Runtime>,
    url: String,
) -> Result<(TabId, dive_cdp::CdpSession), AppError> {
    on_main(app, move |app| {
        let state = app.state::<state::AppState>();
        let main = engine::MainThread::here().ok_or_else(|| AppError::new("not main thread"))?;
        let workspace =
            (*state::lock(&state.active_workspace)).ok_or_else(|| AppError::new("no workspace"))?;
        let tab = commands::open_tab(&main, app, &state, workspace, &url)?;
        let session = state::lock(&state.host)
            .as_ref()
            .and_then(|host| host.cdp(tab.id))
            .ok_or_else(|| AppError::new("no page session"))?;
        Ok((tab.id, session))
    })
    .await
}

async fn value(session: &dive_cdp::CdpSession, expression: &str) -> Result<Value, AppError> {
    let result = session
        .call(
            "Runtime.evaluate",
            json!({"expression":expression,"returnByValue":true,"awaitPromise":true}),
        )
        .await
        .map_err(AppError::new)?;
    if result.get("exceptionDetails").is_some() {
        return Err(AppError::new(format!(
            "private probe JavaScript failed: {result}"
        )));
    }
    Ok(result["result"]["value"].clone())
}

async fn loaded(session: &dive_cdp::CdpSession) -> Result<(), AppError> {
    tokio::time::timeout(Duration::from_secs(12), async {
        loop {
            if read_probe_value(session, "document.title === 'Private session fixture' && document.readyState === 'complete'").await? == true { return Ok(()); }
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
    }).await.map_err(AppError::new)?
}

async fn storage(session: &dive_cdp::CdpSession) -> Result<Value, AppError> {
    value(
        session,
        "({cookie:document.cookie, storage:localStorage.getItem('dive_private_probe')})",
    )
    .await
}

async fn private_context_paths(app: &tauri::AppHandle<Runtime>) -> Result<Vec<String>, AppError> {
    // Check the context itself, not just files appearing absent after quit.
    let paths = on_main(app, |app| {
        use cef::{ImplBrowser, ImplBrowserHost, ImplRequestContext};
        let (tx, rx) = std::sync::mpsc::channel();
        for view in app.webviews().into_values() {
            let tx = tx.clone();
            view.with_webview(move |native| {
                let context = native
                    .browser()
                    .host()
                    .and_then(|host| host.request_context())
                    .expect("context");
                let _ = tx.send(cef::CefStringUtf16::from(&context.cache_path()).to_string());
            })?;
        }
        drop(tx);
        Ok(rx.into_iter().collect::<Vec<_>>())
    })
    .await?;
    if paths.len() < 3 || paths.iter().any(|path| !path.is_empty()) {
        return Err(AppError::new(format!(
            "private context is disk-backed: {paths:?}"
        )));
    }
    Ok(paths)
}

async fn run(
    app: &tauri::AppHandle<Runtime>,
    url: String,
    expected: String,
) -> Result<(), AppError> {
    let private = crate::private_session::is_private();
    let (first, session) = open(app, url.clone()).await?;
    loaded(&session).await?;
    let before = storage(&session).await?;
    let wanted = if expected == "empty" {
        json!({"cookie":"", "storage":null})
    } else {
        json!({"cookie":"dive_private_probe=normal", "storage":"normal"})
    };
    if before != wanted {
        return Err(AppError::new(format!(
            "storage isolation failed: expected {wanted}, got {before}"
        )));
    }
    let marker = if private { "private" } else { "normal" };
    value(&session, &format!("document.cookie='dive_private_probe={marker}; path=/; max-age=3600; SameSite=Lax'; localStorage.setItem('dive_private_probe','{marker}'); true")).await?;
    let (second, other) = open(app, url.clone()).await?;
    loaded(&other).await?;
    let shared = storage(&other).await?;
    let expected_shared =
        json!({"cookie":format!("dive_private_probe={marker}"), "storage":marker});
    if shared != expected_shared {
        return Err(AppError::new(format!("session not shared: {shared}")));
    }
    if private {
        let paths = private_context_paths(app).await?;
        // Close a newer view: the shared-context registry must still find the
        // older chrome, then retain storage with no page tabs open.
        on_main(app, move |app| {
            let main = engine::MainThread::here().unwrap();
            let state = app.state::<state::AppState>();
            commands::close_tab(&main, app, &state, second)?;
            commands::close_tab(&main, app, &state, first)?;
            Ok(())
        })
        .await?;
        let (third, remaining) = open(app, url).await?;
        loaded(&remaining).await?;
        if storage(&remaining).await? != expected_shared {
            return Err(AppError::new("storage lost when all page tabs closed"));
        }
        on_main(app, move |app| {
            commands::tab_detach(app.clone(), third, None)?;
            app.get_window(crate::MAIN_WINDOW)
                .ok_or_else(|| AppError::new("main missing"))?
                .close()?;
            Ok(())
        })
        .await?;
        tokio::time::sleep(Duration::from_millis(300)).await;
        if storage(&remaining).await? != expected_shared {
            return Err(AppError::new("storage lost on primary-window close"));
        }
        let main_visible = on_main(app, |app| {
            Ok(app.get_window(crate::MAIN_WINDOW).unwrap().is_visible()?)
        })
        .await?;
        if main_visible {
            return Err(AppError::new("private main window did not close"));
        }
        let state = app.state::<state::AppState>();
        if !state::lock(&state.store)
            .search_history("", 100)?
            .is_empty()
            || state::data_root().join("dive.db").exists()
            || state::data_root().join("logs").exists()
        {
            return Err(AppError::new("private history/database/logging persisted"));
        }
        println!(
            "DIVE_PRIVATE_PROBE: {}",
            json!({"private":true,"before":before,"shared":shared,"contextCachePaths":paths,"primaryClosed":true,"historyEmpty":true,"root":state::data_root()})
        );
        // Closing this actual remaining native window must terminate the process.
        on_main(app, move |app| {
            app.windows()
                .into_values()
                .find(|window| engine::popout_tab(window.label()) == Some(third))
                .ok_or_else(|| AppError::new("last window missing"))?
                .close()?;
            Ok(())
        })
        .await?;
    } else {
        println!(
            "DIVE_PRIVATE_PROBE: {}",
            json!({"private":false,"before":before,"shared":shared})
        );
        app.exit(0);
    }
    Ok(())
}

pub(crate) fn start(app: tauri::AppHandle<Runtime>) {
    let Ok(url) = std::env::var("DIVE_PRIVATE_STORAGE_PROBE") else {
        return;
    };
    if std::env::var_os("DIVE_DATA_DIR").is_none()
        || std::env::var("DIVE_USE_MOCK_KEYCHAIN").as_deref() != Ok("1")
        || !url.starts_with("http://127.0.0.1:")
    {
        eprintln!(
            "private probe requires a disposable profile, mock keychain, and loopback fixture"
        );
        app.exit(2);
        return;
    }
    let expected = std::env::var("DIVE_PRIVATE_STORAGE_EXPECT").unwrap_or_else(|_| "empty".into());
    tauri::async_runtime::spawn(async move {
        let result = tokio::time::timeout(Duration::from_secs(40), run(&app, url, expected)).await;
        if !matches!(result, Ok(Ok(()))) {
            eprintln!("DIVE_PRIVATE_PROBE_FAILED: {result:?}");
            app.exit(1);
        }
    });
}
