//! Device-free native permission cache qualification, disposable profiles only.
//! Seeds content settings directly; never asks Chromium/OS for a capability.
use std::{sync::Arc, time::Duration};

use cef::{
    CefString, ContentSettingTypes, ImplBrowser, ImplBrowserHost, ImplRequestContext,
    JsonParserOptions, JsonWriterOptions, RequestContext,
};
use dive_core::{Container, Profile, TabId, Workspace};
use serde_json::{Value as Json, json};
use tauri::Manager;

use crate::{AppError, Runtime, commands, engine, permissions, state};

type Native = Arc<tauri::webview::PlatformWebview<Runtime>>;
const ORIGIN: &str = "https://permission-probe.invalid";
const SIBLING: &str = "https://permission-sibling.invalid";
const DOCUMENT: &str = "data:text/html,%3Ctitle%3EPermission%20cache%20probe%3C/title%3E";

async fn on_main<T: Send + 'static>(
    app: &tauri::AppHandle<Runtime>,
    run: impl FnOnce(&tauri::AppHandle<Runtime>) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(run(&handle));
    })?;
    tokio::time::timeout(Duration::from_secs(10), rx)
        .await
        .map_err(AppError::new)?
        .map_err(AppError::new)?
}

async fn native(app: &tauri::AppHandle<Runtime>, tab: TabId) -> Result<Native, AppError> {
    on_main(app, move |app| {
        let view = state::lock(&app.state::<state::AppState>().host)
            .as_ref()
            .ok_or_else(|| AppError::new("permission probe host missing"))?
            .with_view(tab, |view| Ok(view.clone()))?;
        let output = Arc::new(std::sync::Mutex::new(None));
        let target = output.clone();
        view.with_webview(move |native| {
            *state::lock(&target) = Some(Arc::new(native));
        })?;
        state::lock(&output)
            .take()
            .ok_or_else(|| AppError::new("native permission probe did not run inline"))
    })
    .await
}
fn context(native: &Native) -> Result<RequestContext, AppError> {
    native
        .browser()
        .host()
        .and_then(|host| host.request_context())
        .ok_or_else(|| AppError::new("native context missing"))
}
fn read(
    context: &RequestContext,
    origin: &str,
    kind: ContentSettingTypes,
) -> Result<Json, AppError> {
    let origin = CefString::from(origin);
    let mut value = context
        .website_setting(Some(&origin), Some(&origin), kind)
        .ok_or_else(|| AppError::new("native setting missing"))?;
    serde_json::from_str(
        &CefString::from(&cef::write_json(
            Some(&mut value),
            JsonWriterOptions::DEFAULT,
        ))
        .to_string(),
    )
    .map_err(AppError::new)
}
fn seed(
    context: &RequestContext,
    origin: &str,
    kind: ContentSettingTypes,
    value: &Json,
) -> Result<(), AppError> {
    let mut native = cef::parse_json(
        Some(&value.to_string().as_str().into()),
        JsonParserOptions::RFC,
    )
    .ok_or_else(|| AppError::new("native seed JSON failed"))?;
    let origin_string = CefString::from(origin);
    context.set_website_setting(
        Some(&origin_string),
        Some(&origin_string),
        kind,
        Some(&mut native),
    );
    expect(&read(context, origin, kind)?, value, "seed readback")
}
fn expect(actual: &Json, expected: &Json, label: &str) -> Result<(), AppError> {
    if actual != expected {
        return Err(AppError::new(format!(
            "{label}: expected {expected}, got {actual}"
        )));
    }
    Ok(())
}
fn navigation_ready(
    reply: Result<Json, dive_cdp::CdpError>,
    closed: bool,
) -> Result<bool, AppError> {
    if closed {
        return Err(AppError::new("permission probe session closed"));
    }
    match reply {
        Ok(reply) => Ok(reply["result"]["value"] == true),
        Err(dive_cdp::CdpError::Protocol {
            code: -32000,
            message,
        }) if matches!(
            message.as_str(),
            "Inspected target navigated or closed" | "Not attached to an active page"
        ) =>
        {
            Ok(false)
        }
        Err(error) => Err(AppError::new(error)),
    }
}
async fn open(
    app: &tauri::AppHandle<Runtime>,
    workspace: dive_core::WorkspaceId,
) -> Result<TabId, AppError> {
    let tab = on_main(app, move |app| {
        let main = engine::MainThread::here().ok_or_else(|| AppError::new("not UI"))?;
        Ok(commands::open_tab(
            &main,
            app,
            &app.state::<state::AppState>(),
            workspace,
            DOCUMENT,
        )?
        .id)
    })
    .await?;
    let session = state::lock(&app.state::<state::AppState>().host)
        .as_ref()
        .and_then(|host| host.cdp(tab))
        .ok_or_else(|| AppError::new("probe CDP missing"))?;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let reply = session
                .call(
                    "Runtime.evaluate",
                    json!({"expression":"location.href.startsWith('data:')","returnByValue":true}),
                )
                .await;
            if navigation_ready(reply, session.is_closed())? {
                return Ok::<_, AppError>(());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(AppError::new)??;
    Ok(tab)
}
fn workspace(store: &dive_core::Store, name: &str) -> Result<Workspace, AppError> {
    let container = Container::new(name);
    let profile = Profile::new(name, container.id, 99);
    let workspace = Workspace::new(name, container.id, profile.id, 99);
    store.upsert_container(&container)?;
    store.upsert_profile(&profile)?;
    store.upsert_workspace(&workspace)?;
    Ok(workspace)
}
fn settings_ask(app: &tauri::AppHandle<Runtime>, workspace: &Workspace) -> Result<(), AppError> {
    let state = app.state::<state::AppState>();
    let old = state::lock(&state.active_workspace).replace(workspace.id);
    let scope = permissions::Scope {
        profile_id: workspace.profile_id,
        container_id: workspace.container_id,
    };
    let result = permissions::set(
        app,
        &state,
        &scope,
        ORIGIN,
        "notifications",
        permissions::Decision::Ask,
    );
    *state::lock(&state.active_workspace) = old;
    result
}

pub(crate) async fn verify(app: &tauri::AppHandle<Runtime>) -> Result<(), AppError> {
    let (first_scope, other_scope) = on_main(app, |app| {
        let state = app.state::<state::AppState>();
        let store = state::lock(&state.store);
        Ok((
            workspace(&store, "Permission probe A")?,
            workspace(&store, "Permission probe B")?,
        ))
    })
    .await?;
    let first = open(app, first_scope.id).await?;
    // Keep the platform handle alive after close, reproducing the native timeout
    // task's ContextLease retention without invoking any permission API.
    let retained = native(app, first).await?;
    seed_and_verify_geolocation(app, retained.clone()).await?;
    let second = open(app, first_scope.id).await?;
    let other = open(app, other_scope.id).await?;
    verify_isolation(app, second, other).await?;
    on_main(app, move |app| {
        commands::tab_close(app.clone(), first)?;
        commands::tab_close(app.clone(), second)?;
        Ok(())
    })
    .await?;
    let retained_closed = retained.clone();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let view = retained_closed.clone();
            if on_main(app, move |app| {
                let state = app.state::<state::AppState>();
                Ok(view.browser().is_valid() == 0
                    && !state.permissions.has_session(first)
                    && !state.permissions.has_session(second))
            })
            .await?
            {
                return Ok::<_, AppError>(());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(AppError::new)??;
    let scope = first_scope.clone();
    on_main(app, move |app| settings_ask(app, &scope)).await?;
    let reopened = open(app, first_scope.id).await?;
    let check = native(app, reopened).await?;
    on_main(app, move |_| {
        let context = context(&check)?;
        expect(
            &read(&context, ORIGIN, ContentSettingTypes::NOTIFICATIONS)?,
            &json!(3),
            "closed-context Settings Ask/reopen",
        )?;
        expect(
            &read(&context, SIBLING, ContentSettingTypes::NOTIFICATIONS)?,
            &json!(1),
            "sibling grant preserved",
        )
    })
    .await?;
    on_main(app, move |app| {
        commands::tab_close(app.clone(), reopened)?;
        commands::tab_close(app.clone(), other)?;
        Ok(())
    })
    .await?;
    drop(retained);
    println!(
        "DIVE_PERMISSION_PROBE: native scalar/structured reset, shared-context reuse, container isolation and closed-context Ask/reopen verified"
    );
    Ok(())
}
async fn verify_isolation(
    app: &tauri::AppHandle<Runtime>,
    same: TabId,
    other: TabId,
) -> Result<(), AppError> {
    let same = native(app, same).await?;
    let other = native(app, other).await?;
    on_main(app, move |_| {
        expect(
            &read(&context(&same)?, ORIGIN, ContentSettingTypes::NOTIFICATIONS)?,
            &json!(1),
            "shared context retains remembered grant",
        )?;
        expect(
            &read(
                &context(&other)?,
                ORIGIN,
                ContentSettingTypes::NOTIFICATIONS,
            )?,
            &json!(3),
            "distinct container starts Ask",
        )
    })
    .await
}

async fn seed_and_verify_geolocation(
    app: &tauri::AppHandle<Runtime>,
    seed_view: Native,
) -> Result<(), AppError> {
    on_main(app, move |_| {
        let context = context(&seed_view)?;
        seed(
            &context,
            ORIGIN,
            ContentSettingTypes::NOTIFICATIONS,
            &json!(1),
        )?;
        seed(
            &context,
            SIBLING,
            ContentSettingTypes::NOTIFICATIONS,
            &json!(1),
        )?;
        seed(
            &context,
            ORIGIN,
            ContentSettingTypes::GEOLOCATION_WITH_OPTIONS,
            &json!({"approximate":1,"precise":1}),
        )?;
        seed_view
            .reset_permission_cache(ORIGIN, "geolocation")
            .map_err(AppError::new)?;
        expect(
            &read(
                &context,
                ORIGIN,
                ContentSettingTypes::GEOLOCATION_WITH_OPTIONS,
            )?,
            &json!({"approximate":3,"precise":3}),
            "structured geolocation reset",
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn transition() -> dive_cdp::CdpError {
        dive_cdp::CdpError::Protocol {
            code: -32000,
            message: "Inspected target navigated or closed".into(),
        }
    }
    #[test]
    fn navigation_wait_retries_only_known_transition_on_open_original_session() {
        assert!(!navigation_ready(Err(transition()), false).unwrap());
        assert!(navigation_ready(Err(transition()), true).is_err());
        assert!(
            navigation_ready(
                Err(dive_cdp::CdpError::Protocol {
                    code: -32000,
                    message: "real failure".into()
                }),
                false
            )
            .is_err()
        );
        assert!(navigation_ready(Ok(json!({"result":{"value":true}})), false).unwrap());
    }
}
