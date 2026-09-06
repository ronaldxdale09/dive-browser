//! Diagnostic only: query real Chromium Settings services in a fresh container.
//! Never migrate an existing Preferences file or request a file/device capability.
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

use cef::{CefString, ImplBrowser, ImplRequestContext};
use dive_core::{TabId, Workspace};
use serde_json::{Value as Json, json};
use tauri::Manager;

use super::{Native, context, native, navigation_ready, on_main, workspace};
use crate::{AppError, Runtime, commands, engine, state};

#[path = "permission_hidden_view.rs"]
mod hidden;

const SETTINGS: &str = "chrome://settings/handlers";
const ORIGIN: &str = "https://chooser.permission-probe.invalid";
const SIBLING: &str = "https://keep.permission-probe.invalid";
const SPEC: &str = "https://handler.permission-probe.invalid/?q=%s";
const APP_SPEC: &str = "https://app.permission-probe.invalid/?q=%s";
const EXT_SPEC: &str = "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/handler?q=%s";
const POLICY_SPEC: &str = "https://policy.permission-probe.invalid/?q=%s";
const MARKER: &str = "DIVE fixture contents must survive permission revocation";
const SCRIPT: &str = include_str!("inject/permission-webui-probe.js");

fn handler(protocol: &str, url: &str) -> Json {
    // Defaults never enter SetDefault/RegisterWithOSAsDefaultClient in this probe.
    json!({"protocol":protocol,"url":url,"default":false})
}
fn preferences(file: &Path) -> Json {
    let mut app = handler("web+diveapp", APP_SPEC);
    app["app_id"] = json!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    let mut extension = handler("ext+divefixture", EXT_SPEC);
    extension["extension_id"] = json!("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    extension["security_level"] = json!(3);
    let object = json!({"chosen-objects":[{"path":file,"is-directory":false,"readable":true,"writable":false}]});
    json!({"profile":{"content_settings":{"exceptions":{"file_system_access_chooser_data":{
        format!("{ORIGIN},*"):{"setting":object.clone()}, format!("{SIBLING},*"):{"setting":object}
    }}}},"custom_handlers":{
        "registered_protocol_handlers":[handler("web+diveordinary",SPEC),app,extension],
        "policy":{"registered_protocol_handlers":[handler("web+divepolicy",POLICY_SPEC)]}
    }})
}
fn seed_new_directory(path: &Path) -> Result<(), AppError> {
    // A newly generated container path must not already exist. This is the only
    // circumstance where this diagnostic can prove the profile is not live.
    fs::create_dir(path).map_err(AppError::new)?;
    let file = path.join("permission-fixture.txt");
    let mut sentinel = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file)
        .map_err(AppError::new)?;
    sentinel
        .write_all(MARKER.as_bytes())
        .map_err(AppError::new)?;
    let mut prefs = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path.join("Preferences"))
        .map_err(AppError::new)?;
    prefs
        .write_all(&serde_json::to_vec(&preferences(&file)).map_err(AppError::new)?)
        .map_err(AppError::new)?;
    prefs.sync_all().map_err(AppError::new)
}
fn create_fixture(app: &tauri::AppHandle<Runtime>) -> Result<(Workspace, PathBuf), AppError> {
    let state = app.state::<state::AppState>();
    let store = state::lock(&state.store);
    let scope = workspace(&store, "Permission WebUI fixture")?;
    let container = store.container(scope.container_id)?;
    let path = state::profiles_root()
        .canonicalize()
        .map_err(AppError::new)?
        .join(container.cache_dir);
    seed_new_directory(&path)?;
    Ok((scope, path))
}
fn fixture() -> Json {
    json!({"origin":ORIGIN,"siblingOrigin":SIBLING,"protocol":"web+diveordinary","spec":SPEC,"protected":[
        {"protocol":"web+diveapp","spec":APP_SPEC,"app_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
        {"protocol":"ext+divefixture","spec":EXT_SPEC},
        {"protocol":"web+divepolicy","spec":POLICY_SPEC}
    ]})
}
fn phase(label: &str, error: impl std::fmt::Display) -> AppError {
    AppError::new(format!("WebUI probe {label}: {error}"))
}
fn document_ready(reply: &Json, expected_prefix: &str) -> Result<bool, AppError> {
    if let Some(error) = reply.get("exceptionDetails") {
        return Err(phase("wait_ready JavaScript exception", error));
    }
    let value = &reply["result"]["value"];
    let Some(href) = value["href"].as_str() else {
        return Err(phase("wait_ready invalid document evidence", reply));
    };
    Ok(href.starts_with(expected_prefix)
        && value["readyState"] == "complete"
        && (!expected_prefix.starts_with("chrome:") || value["chromeSend"] == "function"))
}
async fn native_evidence(app: &tauri::AppHandle<Runtime>, view: &hidden::Hidden) -> Json {
    match tokio::time::timeout(Duration::from_secs(2), view.evidence(app)).await {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => json!({"native_evidence_error":error.to_string()}),
        Err(_) => json!({"native_evidence_error":"UI read timed out after 2s"}),
    }
}
async fn wait_ready(
    session: &dive_cdp::CdpSession,
    expected_prefix: &str,
) -> Result<Json, AppError> {
    const EXPRESSION: &str = "({href:String(location.href).slice(0,512),readyState:document.readyState,chromeSend:typeof globalThis.chrome?.send,title:document.title.slice(0,160)})";
    let mut last = json!({"document":"not sampled"});
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let reply = tokio::time::timeout(
                Duration::from_secs(2),
                session.call(
                    "Runtime.evaluate",
                    json!({"expression":EXPRESSION,"returnByValue":true}),
                ),
            )
            .await
            .map_err(|_| {
                phase(
                    "wait_ready read-only CDP evaluation",
                    format!("2s timeout; last={last}"),
                )
            })?;
            let (ready, evidence) = match reply {
                Ok(reply) => {
                    if session.is_closed() {
                        return Err(phase("wait_ready", "original session closed"));
                    }
                    let ready = document_ready(&reply, expected_prefix)?;
                    (ready, reply["result"]["value"].clone())
                }
                Err(error) => {
                    let evidence = json!({"transport":error.to_string()});
                    navigation_ready(Err(error), session.is_closed())
                        .map_err(|error| phase("wait_ready CDP", error))?;
                    (false, evidence)
                }
            };
            if evidence != last {
                println!(
                    "DIVE_PERMISSION_WEBUI_PHASE: wait_ready expected={expected_prefix} {evidence}"
                );
                last = evidence;
            }
            if ready {
                return Ok(last.clone());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await;
    result.map_err(|_| phase("wait_ready", format!("10s timeout; last={last}")))?
}
async fn exercise(
    app: &tauri::AppHandle<Runtime>,
    tab: TabId,
    view: Native,
    path: PathBuf,
) -> Result<Json, AppError> {
    let session = state::lock(&app.state::<state::AppState>().host)
        .as_ref()
        .and_then(|host| host.cdp(tab))
        .ok_or_else(|| AppError::new("WebUI probe CDP missing"))?;
    wait_ready(&session, super::DOCUMENT)
        .await
        .map_err(|error| phase("inert bootstrap before native navigation", error))?;
    let identity_view = view.clone();
    let context = on_main(app, move |_| {
        let context = context(&identity_view)?;
        let actual = CefString::from(&context.cache_path()).to_string();
        if Path::new(&actual) != path {
            return Err(AppError::new("WebUI probe wrong native context"));
        }
        Ok((context, path))
    })
    .await?;
    let hidden = hidden::Hidden::create(app, context.0, context.1).await?;
    let result = exercise_hidden(app, &hidden).await;
    let cleanup = hidden.close(app).await;
    match (result, cleanup) {
        (Ok(result), Ok(())) => Ok(result),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(cleanup)) => Err(phase(
            "hidden exercise/cleanup",
            format!("{error}; {cleanup}"),
        )),
    }
}
async fn exercise_hidden(
    app: &tauri::AppHandle<Runtime>,
    view: &hidden::Hidden,
) -> Result<Json, AppError> {
    view.navigate(app).await?;
    let session = &view.session;
    println!(
        "DIVE_PERMISSION_WEBUI_PHASE: before_wait {}",
        native_evidence(app, view).await
    );
    let ready = match wait_ready(session, "chrome://settings/").await {
        Ok(ready) => ready,
        Err(error) => {
            return Err(phase(
                "document readiness",
                format!("{error}; native={}", native_evidence(app, view).await),
            ));
        }
    };
    println!("DIVE_PERMISSION_WEBUI_PHASE: service_call begin document={ready}");
    // Pinned cr.js exports the actual C++ event listener and promise transports.
    // Neither registry mutation is retried, including after a navigation error.
    let expression = format!(
        "(async()=>{{const cr=await import('chrome://resources/js/cr.js');return await ({SCRIPT})({{cr,chrome,href:location.href,fixture:{}}});}})()",
        fixture()
    );
    let result = tokio::time::timeout(
        Duration::from_secs(20),
        session.call(
            "Runtime.evaluate",
            json!({"expression":expression,"awaitPromise":true,"returnByValue":true}),
        ),
    )
    .await;
    let reply = match result {
        Ok(Ok(reply)) => reply,
        error => {
            return Err(phase(
                "service_call",
                format!("{error:?}; native={}", native_evidence(app, view).await),
            ));
        }
    };
    println!(
        "DIVE_PERMISSION_WEBUI_PHASE: service_call returned native={}",
        native_evidence(app, view).await
    );
    if session.is_closed()
        || reply.get("exceptionDetails").is_some()
        || reply["result"]["value"]["ok"] != true
    {
        return Err(AppError::new(format!(
            "Native WebUI service probe failed: {reply}"
        )));
    }
    view.evidence(app).await?;
    Ok(reply["result"]["value"].clone())
}
async fn close(app: &tauri::AppHandle<Runtime>, tab: TabId, view: Native) -> Result<(), AppError> {
    on_main(app, move |app| commands::tab_close(app.clone(), tab)).await?;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let view = view.clone();
            if on_main(app, move |_| Ok(view.browser().is_valid() == 0)).await? {
                return Ok::<_, AppError>(());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(AppError::new)?
}
pub(super) async fn verify(app: &tauri::AppHandle<Runtime>) -> Result<(), AppError> {
    println!("DIVE_PERMISSION_WEBUI_PHASE: create_fixture begin");
    let (scope, path) = on_main(app, create_fixture)
        .await
        .map_err(|error| phase("create_fixture", error))?;
    println!("DIVE_PERMISSION_WEBUI_PHASE: open_view begin");
    let tab = on_main(app, move |app| {
        let main =
            engine::MainThread::here().ok_or_else(|| AppError::new("WebUI probe not on UI"))?;
        Ok(commands::open_tab(
            &main,
            app,
            &app.state::<state::AppState>(),
            scope.id,
            super::DOCUMENT,
        )?
        .id)
    })
    .await
    .map_err(|error| phase("open_view", error))?;
    println!("DIVE_PERMISSION_WEBUI_PHASE: get_native begin");
    let view = match native(app, tab).await {
        Ok(view) => view,
        Err(error) => {
            let cleanup = on_main(app, move |app| commands::tab_close(app.clone(), tab)).await;
            return Err(AppError::new(format!(
                "Native WebUI handle failed: {error}; cleanup: {cleanup:?}"
            )));
        }
    };
    let result = exercise(app, tab, view.clone(), path.clone()).await;
    println!("DIVE_PERMISSION_WEBUI_PHASE: close begin");
    let cleanup = close(app, tab, view)
        .await
        .map_err(|error| phase("close", error));
    let result = match (result, cleanup) {
        (Ok(result), Ok(())) => result,
        (Err(error), Ok(())) | (Ok(_), Err(error)) => return Err(error),
        (Err(error), Err(cleanup)) => {
            return Err(AppError::new(format!(
                "WebUI probe: {error}; cleanup: {cleanup}"
            )));
        }
    };
    if fs::read_to_string(path.join("permission-fixture.txt")).map_err(AppError::new)? != MARKER {
        return Err(AppError::new("WebUI probe modified the file fixture"));
    }
    println!("DIVE_PERMISSION_WEBUI_PROBE: effective chooser/protocol services verified {result}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn readiness_keeps_redirected_document_evidence_and_rejects_script_errors() {
        let ready = json!({"result":{"value":{"href":"chrome://settings/handlers","readyState":"complete","chromeSend":"function","title":"Settings"}}});
        assert!(document_ready(&ready, "chrome://settings/").unwrap());
        let mut redirected = ready.clone();
        redirected["result"]["value"]["href"] = json!("chrome-error://chromewebdata/");
        assert!(!document_ready(&redirected, "chrome://settings/").unwrap());
        redirected["exceptionDetails"] = json!({"text":"Cannot access document"});
        assert!(
            document_ready(&redirected, "chrome://settings/")
                .unwrap_err()
                .to_string()
                .contains("Cannot access document")
        );
        assert!(document_ready(&json!({"result":{"value":false}}), "chrome://settings/").is_err());
    }
    #[test]
    fn inert_bootstrap_waits_for_initial_navigation_without_webui_transport() {
        let data = json!({"result":{"value":{"href":super::super::DOCUMENT,"readyState":"complete","chromeSend":"undefined"}}});
        assert!(document_ready(&data, super::super::DOCUMENT).unwrap());
    }
    #[test]
    fn fixture_seeding_refuses_preexisting_directory_and_preserves_contents() {
        let path = std::env::temp_dir().join(format!(
            "dive-webui-probe-{}",
            dive_core::Container::new("probe-test").id
        ));
        seed_new_directory(&path).unwrap();
        let first = fs::read(path.join("Preferences")).unwrap();
        assert!(seed_new_directory(&path).is_err());
        assert_eq!(fs::read(path.join("Preferences")).unwrap(), first);
        assert_eq!(
            fs::read_to_string(path.join("permission-fixture.txt")).unwrap(),
            MARKER
        );
        fs::remove_dir_all(path).unwrap();
    }
}
