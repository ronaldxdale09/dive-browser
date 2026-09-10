//! Opt-in diagnostics for a disposable, interactive native UI run.
//! No keyboard contents, form values, page URLs, or snapshot data are recorded.

#[path = "ui_media_probe.rs"]
mod media_probe;
#[path = "ui_network_probe.rs"]
mod network_probe;

use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

use base64::Engine as _;
use cef::ImplBrowser;
use serde_json::{Value, json};
use tauri::Manager;

use crate::{
    AppError, Runtime,
    lifecycle_probe::{chrome_probe_session, on_main},
};

const DOCUMENT: &str = r#"(() => {
  if (!window.__diveUiProbe) {
    const counts = Object.create(null);
    window.__diveUiProbe = counts;
    for (const type of ['pointerdown', 'pointerup', 'click', 'keydown', 'focus', 'blur'])
      window.addEventListener(type, () => { counts[type] = (counts[type] || 0) + 1; }, {capture:true, passive:true});
  }
  const root = document.getElementById('root');
  const style = root && getComputedStyle(root);
  const rect = root?.getBoundingClientRect();
  const box = element => { const r = element?.getBoundingClientRect(); return r && {x:r.x,y:r.y,width:r.width,height:r.height}; };
  const tablist = document.querySelector('[role="tablist"][aria-label="Tabs"]');
  const mediaEvents = ['lease_setup','lease_release','media_error','export_begin','export_seek_failed','export_seek_timeout','export_seek_cancelled','export_end'];
  const mediaPhases = ['idle','preparing','seeking','rendering','draining','flushing','uploading','finishing','done'];
  const mediaFields = ['atMs','generation','exporting','frame','targetMs','code','currentTime','seeking','paused','readyState','networkState'];
  const screenMedia = Array.isArray(window.__diveScreenMediaProbe) ? window.__diveScreenMediaProbe.slice(-64).flatMap(row => {
    if (!row || !mediaEvents.includes(row.event) || !mediaPhases.includes(row.phase)) return [];
    const safe = {event:row.event,phase:row.phase};
    for (const key of mediaFields) safe[key] = typeof row[key] === 'number' && Number.isFinite(row[key]) ? row[key] : null;
    return [safe];
  }) : null;
  return {ready:document.readyState, visibility:document.visibilityState, focused:document.hasFocus(),
    now:performance.now(), timeOrigin:performance.timeOrigin, children:root?.childElementCount,
    rect:rect && {x:rect.x,y:rect.y,width:rect.width,height:rect.height},
    style:style && {display:style.display,visibility:style.visibility,opacity:style.opacity},
    activeTag:document.activeElement?.tagName, centerTag:document.elementFromPoint(innerWidth/2,innerHeight/2)?.tagName,
    tablist:box(tablist), tabs:Array.from(tablist?.querySelectorAll('.tab-item') || []).slice(0,100).map(element => ({...box(element),pinned:element.hasAttribute('data-pinned'),sleeping:element.hasAttribute('data-sleeping')})),
    newTabButton:box(document.querySelector('button[aria-label="New tab"]')),
    alerts:document.querySelectorAll('[role="alert"]').length,
    dialogs:document.querySelectorAll('[role="dialog"]').length,
    newTab:!!document.querySelector('[role="dialog"][aria-label="New tab"]'),
    loading:!!document.querySelector('[aria-label="Loading dialog"]'), input:window.__diveUiProbe,
    inputTiming:window.__diveInputTimingProbe?.snapshot(), screenMedia};
})()"#;

fn enabled(flag: &str, mock: &str, profile: bool, competing_probe: bool) -> bool {
    flag == "1" && mock == "1" && profile && !competing_probe
}

/// Fixed launcher receipts only; never log arbitrary native menu IDs.
// Only the native menu bar reports these, and Windows installs none.
#[cfg(not(target_os = "windows"))]
pub(crate) fn native_input_receipt(stage: &'static str, command: &str) {
    use std::io::Write as _;
    use std::sync::{OnceLock, atomic::AtomicUsize};
    static ADMITTED: OnceLock<bool> = OnceLock::new();
    static SEQUENCE: AtomicUsize = AtomicUsize::new(0);
    if !matches!(command, "tab.new" | "palette.open" | "tabs.search") {
        return;
    }
    if !ADMITTED.get_or_init(|| {
        std::env::var("DIVE_UI_INPUT_NATIVE_TRACE").as_deref() == Ok("1")
            && enabled(
                &std::env::var("DIVE_UI_PROBE").unwrap_or_default(),
                &std::env::var("DIVE_USE_MOCK_KEYCHAIN").unwrap_or_default(),
                std::env::var_os("DIVE_DATA_DIR").is_some_and(|value| !value.is_empty()),
                [
                    "DIVE_NATIVE_LIFECYCLE_PROBE",
                    "DIVE_STRESS_TABS",
                    "DIVE_SMOKE",
                    "DIVE_CDP_BENCH",
                ]
                .iter()
                .any(|key| std::env::var_os(key).is_some()),
            )
    }) {
        return;
    }
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    if sequence >= 256 {
        return;
    }
    let unix_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |time| time.as_secs_f64() * 1000.0);
    let _ = writeln!(
        std::io::stdout().lock(),
        "DIVE_INPUT_NATIVE_APP: {}",
        json!({"sequence":sequence,"unix_ms":unix_ms,"stage":stage,"command":command})
    );
}

fn check_running(stop: &AtomicBool) -> Result<(), AppError> {
    if stop.load(Ordering::Acquire) {
        Err(AppError::new("UI diagnostic canceled by watchdog"))
    } else {
        Ok(())
    }
}

async fn checked<T, F: std::future::Future<Output = Result<T, AppError>>>(
    stop: &AtomicBool,
    operation: impl FnOnce() -> F,
) -> Result<T, AppError> {
    check_running(stop)?;
    operation().await
}

async fn evaluate(session: &dive_cdp::CdpSession, expression: &str) -> Result<Value, AppError> {
    let reply = session
        .call(
            "Runtime.evaluate",
            json!({
                "expression":expression, "returnByValue":true, "awaitPromise":true,
            }),
        )
        .await
        .map_err(AppError::new)?;
    if reply.get("exceptionDetails").is_some() {
        return Err(AppError::new("UI probe evaluation threw"));
    }
    Ok(reply["result"]["value"].clone())
}

async fn wait_for_request(
    directory: &std::path::Path,
    stop: &AtomicBool,
    progress: &mpsc::Sender<()>,
) -> Result<(), AppError> {
    // Only local file I/O and this worker's timer run while waiting. In
    // particular, do not attach CDP or enqueue a native callback before the
    // operator has observed the uninstrumented window and requests a sample.
    loop {
        check_running(stop)?;
        let request = directory.join("sample.request");
        if request.is_file() {
            std::fs::remove_file(request).map_err(AppError::new)?;
            return Ok(());
        }
        let _ = progress.send(());
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn enable_media_and_network(
    session: &dive_cdp::CdpSession,
    stop: Arc<AtomicBool>,
) -> Option<tokio::task::JoinHandle<()>> {
    // Subscribe before enable: Chromium may replay errors during its reply.
    // Reuse this session's existing native observer, never install another.
    let mut events = session.subscribe();
    let worker_stop = stop.clone();
    let task = tokio::spawn(async move {
        let mut capture = media_probe::MediaErrors::new(true);
        let mut sequence = 0;
        let mut network = network_probe::NetworkFacts::new(true);
        let mut network_sequence = 0;
        let mut lag_reported = false;
        while !(worker_stop.load(Ordering::Acquire) || capture.full() && network.full()) {
            match events.recv().await {
                Ok(event) => {
                    if let Some(mut fact) = network.collect(&event.method, &event.params) {
                        network_sequence += 1;
                        let unix_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map_or(0.0, |time| time.as_secs_f64() * 1000.0);
                        fact["sequence"] = json!(network_sequence);
                        fact["unix_ms"] = json!(unix_ms);
                        println!("DIVE_UI_PROBE_NETWORK: {fact}");
                    }
                    for error in capture.collect(&event.method, &event.params) {
                        sequence += 1;
                        let unix_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map_or(0.0, |time| time.as_secs_f64() * 1000.0);
                        println!(
                            "DIVE_UI_PROBE_MEDIA_ERROR: {}",
                            json!({
                                "sequence":sequence,"unix_ms":unix_ms,
                                "errorType":error.error_type,"code":error.code
                            })
                        );
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    if !lag_reported {
                        println!("DIVE_UI_PROBE_MEDIA_LAG: {skipped}");
                        println!("DIVE_UI_PROBE_NETWORK_LAG: {skipped}");
                        lag_reported = true;
                    }
                }
            }
        }
    });
    // Both enables share one bounded interval and the existing observer. An
    // unsupported domain is diagnostic status, not a failed basic UI sample.
    let enable = |method| {
        let stop = &stop;
        async move {
            !stop.load(Ordering::Acquire)
                && matches!(
                    tokio::time::timeout(Duration::from_secs(10), session.call0(method)).await,
                    Ok(Ok(_))
                )
        }
    };
    let (media_enabled, network_enabled) =
        tokio::join!(enable("Media.enable"), enable("Network.enable"));
    println!(
        "DIVE_UI_PROBE_MEDIA_STATUS: {}",
        if media_enabled {
            "enabled"
        } else {
            "unavailable"
        }
    );
    println!(
        "DIVE_UI_PROBE_NETWORK_STATUS: {}",
        if network_enabled {
            "enabled"
        } else {
            "unavailable"
        }
    );
    if media_enabled || network_enabled {
        Some(task)
    } else {
        task.abort();
        None
    }
}

async fn run(
    app: tauri::AppHandle<Runtime>,
    directory: PathBuf,
    stop: Arc<AtomicBool>,
    progress: mpsc::Sender<()>,
    manual: bool,
) -> Result<(), AppError> {
    if manual {
        println!("DIVE_UI_PROBE: waiting for sample.request without native or CDP polling");
        wait_for_request(&directory, &stop, &progress).await?;
    }
    println!("DIVE_UI_PROBE: attaching");
    let chrome = app
        .get_webview(crate::CHROME_LABEL)
        .ok_or_else(|| AppError::new("chrome missing"))?;
    check_running(&stop)?;
    let session = chrome_probe_session(&chrome)?;
    let mut media_task = None;
    let result = async {
        let mut sequence = 0;
        let mut media_attempted = false;
        while !stop.load(Ordering::Acquire) {
            if manual && sequence > 0 {
                wait_for_request(&directory, &stop, &progress).await?;
            }
            sequence += 1;
            println!("DIVE_UI_PROBE_BEGIN: {sequence} native");
            let native_stop = stop.clone();
            let native = on_main(&app, move |handle| {
                check_running(&native_stop)?;
                let window = handle.get_window(crate::MAIN_WINDOW).ok_or_else(|| AppError::new("window missing"))?;
                let chrome = handle.get_webview(crate::CHROME_LABEL).ok_or_else(|| AppError::new("chrome missing"))?;
                let bounds = chrome.bounds()?;
                let monitor = window.current_monitor()?.map(|monitor| json!({
                    "position":monitor.position(), "size":monitor.size(), "scale":monitor.scale_factor()
                }));
                Ok(json!({"visible":window.is_visible()?, "minimized":window.is_minimized()?,
                    "focused":window.is_focused()?, "size":window.inner_size()?,
                    "position":window.outer_position()?, "scale":window.scale_factor()?, "monitor":monitor,
                    "chromeBounds":{"position":bounds.position,"size":bounds.size}}))
            }).await?;
            check_running(&stop)?;
            let (tx, rx) = tokio::sync::oneshot::channel();
            let browser_stop = stop.clone();
            chrome.with_webview(move |view| {
                if browser_stop.load(Ordering::Acquire) { return; }
                let browser = view.browser();
                let _ = tx.send(json!({"id":browser.identifier(),"valid":browser.is_valid()!=0}));
            })?;
            println!("DIVE_UI_PROBE_NATIVE: {}", json!({"sequence":sequence,"window":native,"browser":rx.await.map_err(AppError::new)?}));
            if stop.load(Ordering::Acquire) { break; }
            println!("DIVE_UI_PROBE_BEGIN: {sequence} identity");
            let frame = checked(&stop, || async { session.call0("Page.getFrameTree").await.map_err(AppError::new) }).await?;
            println!("DIVE_UI_PROBE_IDENTITY: {}",json!({"sequence":sequence,"frame":frame["frameTree"]["frame"]["id"],"loader":frame["frameTree"]["frame"]["loaderId"]}));
            if directory.join("input-timing.request").is_file() {
                std::fs::remove_file(directory.join("input-timing.request")).map_err(AppError::new)?;
                println!("DIVE_UI_PROBE_BEGIN: {sequence} input-timing-enable");
                let started = checked(&stop, || evaluate(&session, "(() => { window.__diveUiInputTimingEnabled = true; return window.__diveInputTimingProbe?.start() === true; })()")).await?;
                if started != json!(true) { return Err(AppError::new("input timing diagnostic is unavailable")); }
                if !media_attempted {
                    check_running(&stop)?;
                    media_attempted = true;
                    media_task = enable_media_and_network(&session, stop.clone()).await;
                }
            }
            println!("DIVE_UI_PROBE_BEGIN: {sequence} document");
            let mut document = checked(&stop, || evaluate(&session, DOCUMENT)).await?;
            if let Some(document) = document.as_object_mut() {
                let safe = media_probe::screen_media(document.get("screenMedia").unwrap_or(&Value::Null));
                document.insert("screenMedia".into(), safe);
            }
            println!("DIVE_UI_PROBE_DOCUMENT: {}",json!({"sequence":sequence,"document":document}));
            if stop.load(Ordering::Acquire) { break; }
            println!("DIVE_UI_PROBE_BEGIN: {sequence} ipc");
            let ipc = checked(&stop, || evaluate(&session, "window.__TAURI_INTERNALS__.invoke('snapshot', {}).then(value => !!value)")).await?;
            println!("DIVE_UI_PROBE_IPC: {}",json!({"sequence":sequence,"answered":ipc}));
            if stop.load(Ordering::Acquire) { break; }
            if directory.join("capture.request").is_file() {
                std::fs::remove_file(directory.join("capture.request")).map_err(AppError::new)?;
                println!("DIVE_UI_PROBE_BEGIN: {sequence} capture");
                let frame = checked(&stop, || async { session.call0("Page.getFrameTree").await.map_err(AppError::new) }).await?;
                let screenshot = checked(&stop, || async { session.call("Page.captureScreenshot",json!({"format":"png"})).await.map_err(AppError::new) }).await?;
                let data = screenshot["data"].as_str().filter(|s| s.len() <= 32 * 1024 * 1024).ok_or_else(|| AppError::new("missing or oversized screenshot"))?;
                let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(AppError::new)?;
                let path = directory.join(format!("chrome-{sequence}.png"));
                std::fs::write(&path, bytes).map_err(AppError::new)?;
                println!("DIVE_UI_PROBE_CAPTURE: {}",json!({"sequence":sequence,"path":path,"loader":frame["frameTree"]["frame"]["loaderId"]}));
            }
            let _ = progress.send(());
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        Ok(())
    }.await;
    session.close();
    if let Some(task) = media_task {
        task.abort();
    }
    result
}

pub(crate) fn start(app: tauri::AppHandle<Runtime>) {
    let flag = std::env::var("DIVE_UI_PROBE").unwrap_or_default();
    if flag.is_empty() {
        return;
    }
    let mock = std::env::var("DIVE_USE_MOCK_KEYCHAIN").unwrap_or_default();
    let profile = std::env::var_os("DIVE_DATA_DIR").filter(|value| !value.is_empty());
    let competing_probe = [
        "DIVE_NATIVE_LIFECYCLE_PROBE",
        "DIVE_STRESS_TABS",
        "DIVE_SMOKE",
        "DIVE_CDP_BENCH",
    ]
    .iter()
    .any(|key| std::env::var_os(key).is_some());
    if !enabled(&flag, &mock, profile.is_some(), competing_probe) {
        tracing::error!(
            "UI diagnostic requires DIVE_UI_PROBE=1, explicit disposable profile, mock keychain and no competing native probe"
        );
        return;
    }
    let directory = PathBuf::from(profile.expect("validated profile")).join("ui-probe");
    if let Err(error) = std::fs::create_dir_all(&directory) {
        tracing::error!(%error,"cannot create UI diagnostic directory");
        return;
    }
    println!("DIVE_UI_PROBE_DIRECTORY: {}", directory.display());
    let manual = std::env::var("DIVE_UI_PROBE_ON_DEMAND").as_deref() == Ok("1");
    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = stop.clone();
    let (tx, rx) = mpsc::channel();
    // CDP's native transport can synchronously block. Keep both the worker and
    // its watchdog off the application's executor; never queue a second worker.
    std::thread::spawn(move || {
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(AppError::new)
            .and_then(|runtime| runtime.block_on(run(app, directory, worker_stop, tx, manual)));
        if let Err(error) = result {
            tracing::error!(%error,"UI diagnostic stopped");
        }
    });
    std::thread::spawn(move || {
        loop {
            match rx.recv_timeout(Duration::from_secs(15)) {
                Ok(()) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    stop.store(true, Ordering::Release);
                    tracing::error!(
                        "UI diagnostic exceeded 15 seconds; last BEGIN identifies the stalled boundary; no further samples will be issued"
                    );
                    return;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn manual_sample_requires_its_marker_and_honors_cancellation() {
        let directory = std::env::temp_dir().join(format!(
            "dive-ui-marker-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir(&directory).expect("fixture directory");
        let stop = AtomicBool::new(false);
        let (tx, rx) = mpsc::channel();
        let waiting = wait_for_request(&directory, &stop, &tx);
        tokio::pin!(waiting);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut waiting)
                .await
                .is_err()
        );
        assert!(rx.try_recv().is_ok(), "idle worker sends a heartbeat");
        let capture = directory.join("capture.request");
        std::fs::write(&capture, []).expect("capture marker");
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut waiting)
                .await
                .is_err()
        );
        let sample = directory.join("sample.request");
        std::fs::write(&sample, []).expect("sample marker");
        tokio::time::timeout(Duration::from_secs(2), &mut waiting)
            .await
            .expect("marker noticed")
            .expect("sample admitted");
        assert!(!sample.exists(), "sample marker is consumed");
        assert!(
            capture.exists(),
            "capture marker does not trigger or get consumed by sample admission"
        );
        std::fs::write(&sample, []).expect("next sample marker");
        stop.store(true, Ordering::Release);
        assert!(wait_for_request(&directory, &stop, &tx).await.is_err());
        assert!(
            sample.exists(),
            "canceled worker does not consume a later request"
        );
        std::fs::remove_dir_all(&directory).expect("fixture cleanup");
    }

    #[tokio::test]
    async fn canceled_blocked_step_does_not_dispatch_followup() {
        let stop = Arc::new(AtomicBool::new(false));
        let (began_tx, began_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let worker_stop = stop.clone();
        let followup = Arc::new(AtomicBool::new(false));
        let worker_followup = followup.clone();
        let worker = tokio::spawn(async move {
            checked(&worker_stop, || async {
                let _ = began_tx.send(());
                release_rx.await.map_err(AppError::new)
            })
            .await?;
            checked(&worker_stop, || async {
                worker_followup.store(true, Ordering::Release);
                Ok(())
            })
            .await
        });
        began_rx.await.expect("first operation started");
        stop.store(true, Ordering::Release);
        release_tx.send(()).expect("release blocked operation");
        assert!(worker.await.expect("worker joined").is_err());
        assert!(!followup.load(Ordering::Acquire));
    }

    #[test]
    fn diagnostic_requires_explicit_mock_profile() {
        assert!(enabled("1", "1", true, false));
        assert!(!enabled("1", "1", true, true));
        for (flag, mock, profile) in [
            ("0", "1", true),
            ("1", "0", true),
            ("1", "1", false),
            ("true", "1", true),
        ] {
            assert!(!enabled(flag, mock, profile, false));
        }
    }
}
