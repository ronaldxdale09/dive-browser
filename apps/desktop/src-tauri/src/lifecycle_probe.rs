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
        let second = commands::open_tab(&main, handle, &state, workspace, "about:blank")?;
        Ok([first.id, second.id])
    })
    .await?;
    // Wait for both real CEF sessions to answer before exercising teardown.
    for id in ids {
        assert_renderer_alive(app, id).await?;
    }
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
