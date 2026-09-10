//! Dive desktop: Tauri host that owns the CEF engine, the core state and the
//! typed IPC surface used by the React chrome.

mod a11y;
mod activity;
mod agent;
mod agent_tools;
mod automation;
mod ax;
mod browser_import;
mod buffers;
mod capture_scope;
mod cdp_feed;
mod color;
mod commands;
mod console;
mod crash;
#[cfg(feature = "cef")]
mod crash_probe;
mod credential_fill;
mod default_browser;
mod devservers;
mod emulate;
mod engine;
mod error;
mod extensions;
mod favicon;
mod filltab;
mod find;
mod form_fill;
mod har;
mod housekeeping;
mod inspect;
mod ipc_security;
#[cfg(feature = "cef")]
mod js_dialog;
mod lifecycle_probe;
mod loading;
mod locator;
mod mcp;
mod memory_probe;
mod menu;
mod meta;
mod navigation;
mod network;
#[cfg(feature = "cef")]
mod network_probe;
mod normal_window;
mod openapi;
mod overlay_geometry;
mod page_menu;
mod pagescript;
mod passwords;
#[cfg(feature = "cef")]
mod permission_probe;
mod permissions;
mod prefs;
/// Dive-owned network privacy matching.
pub mod privacy;
#[cfg(feature = "cef")]
mod private_probe;
mod private_session;
mod recorder;
mod replay;
mod report;
mod rules;
mod screen;
mod screencast;
mod snapshot;
mod sourcemaps;
mod stack;
pub mod startup;
mod state;
mod storage;
mod subtitles;
mod titlebar;
#[cfg(feature = "cef")]
mod ui_probe;
mod vitals;
mod webapp;

pub use error::AppError;
pub use startup::StartupTimeline;

/// The Tauri runtime in use: Chromium (CEF) for the product, the system
/// webview as a UI-only fallback.
#[cfg(feature = "cef")]
pub type Runtime = tauri::Cef;
/// The Tauri runtime in use: Chromium (CEF) for the product, the system
/// webview as a UI-only fallback.
#[cfg(not(feature = "cef"))]
pub type Runtime = tauri::Wry;

/// Label of the React chrome webview.
pub const CHROME_LABEL: &str = "chrome";
/// Label of the main window.
pub const MAIN_WINDOW: &str = "main";

/// Which window a Dock click should bring back, given the labels that exist.
///
/// The main window when it is still around, otherwise any other — a torn-off
/// tab or an installed app's window is better than nothing. `None` means
/// there is nothing to raise and a fresh window has to be opened.
#[cfg(target_os = "macos")]
fn window_for_dock_click<'a>(labels: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    let mut first = None;
    for label in labels {
        if label == MAIN_WINDOW {
            return Some(label);
        }
        first = first.or(Some(label));
    }
    first
}

/// Bring a window back for a Dock click: unminimize the main window (or the
/// first one still around), else open a fresh one.
#[cfg(target_os = "macos")]
fn reopen_window(app: &tauri::AppHandle<Runtime>) {
    use tauri::Manager as _;
    let windows = app.windows();
    let window = window_for_dock_click(windows.keys().map(String::as_str))
        .and_then(|label| windows.get(label))
        .cloned();
    tracing::info!(found = window.is_some(), "dock reopen");
    match window {
        Some(window) => {
            // Unconditional: the getter can lag the actual state, and
            // unminimizing a window that is not minimized is harmless.
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        None => {
            if let Err(error) = commands::window_open_local(app.clone()) {
                tracing::warn!(%error, "could not open a window for the Dock click");
            }
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct StartupMilestonePayload {
    milestone: String,
}

fn handle_startup_invoke(invoke: tauri::ipc::Invoke<Runtime>) -> bool {
    let tauri::ipc::Invoke {
        message, resolver, ..
    } = invoke;
    let payload = match message.payload() {
        tauri::ipc::InvokeBody::Json(json) => {
            serde_json::from_value::<StartupMilestonePayload>(json.clone())
        }
        tauri::ipc::InvokeBody::Raw(bytes) => {
            serde_json::from_slice::<StartupMilestonePayload>(bytes)
        }
    };
    match payload {
        Ok(data) => {
            let webview = message.webview();
            match startup::observe_renderer_milestone(
                webview.label(),
                webview.window().label(),
                &data.milestone,
            ) {
                Ok(()) => resolver.resolve(()),
                Err(error) => resolver.reject(error),
            }
        }
        Err(err) => {
            resolver.reject(err.to_string());
        }
    }
    true
}

/// Keep CEF responsive while owned export children stop; only reissue Quit
/// after background cleanup confirms they have exited.
fn drain_export_exit(app: tauri::AppHandle<Runtime>, registry: screen::jobs::Registry, code: i32) {
    tauri::async_runtime::spawn(async move {
        let worker = registry.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            worker.drain_shutdown(std::time::Duration::from_secs(15))
        })
        .await
        .map_err(AppError::new)
        .and_then(std::convert::identity);
        match result {
            Ok(()) => {
                registry.finish_exit(true);
                app.exit(code);
            }
            Err(error) => {
                tracing::error!(%error, "export cleanup prevented application exit");
                rfd::AsyncMessageDialog::new().set_title("Dive could not finish quitting")
                    .set_description("An export has not stopped yet. Dive is still open to protect your files. Try Quit again after closing this message.")
                    .set_level(rfd::MessageLevel::Error).set_buttons(rfd::MessageButtons::Ok).show().await;
                registry.finish_exit(false);
            }
        }
    });
}

/// Start the application. Under CEF this also serves as the sub-process
/// entry point.
#[cfg_attr(feature = "cef", tauri::cef_entry_point)]
pub fn run() {
    // Claim the normal profile before logging, SQLite, or CEF touches it.
    let normal_broker = if private_session::is_private() {
        None
    } else {
        let root = state::data_root();
        match normal_window::claim(&root) {
            Ok(Some(broker)) => Some(broker),
            Ok(None) => {
                let urls = startup_urls(
                    std::env::args().skip(1),
                    &std::env::var("DIVE_OPEN_URL").unwrap_or_default(),
                );
                let id = dive_core::TabId::new().to_string();
                if let Err(error) = normal_window::request(&root, &id, &urls) {
                    eprintln!(
                        "Dive is already running but did not accept this window request: {error}"
                    );
                }
                return;
            }
            Err(error) => {
                eprintln!("Could not claim the normal Dive profile: {error}");
                return;
            }
        }
    };
    let normal_broker = std::sync::Arc::new(normal_broker);
    let setup_broker = normal_broker.clone();
    startup::record_launch();

    let log_guard = init_logging();
    install_panic_hook();

    if let Err(error) = prefs::finish_pending_clear() {
        tracing::error!(%error, "deferred browser-data cleanup failed");
    }

    engine::mark_main_thread();
    agent::init_keychain();
    let specta = commands::specta_builder();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::<Runtime>::new();
    #[cfg(feature = "cef")]
    {
        let mut chromium_args = startup::build_chromium_args(None);
        match lifecycle_probe::fetch_filter_probe::chromium_args() {
            Ok(probe_args) => chromium_args.extend(probe_args),
            Err(error) => {
                tracing::error!(%error, "Fetch probe admission rejected before native launch");
                drop(log_guard);
                std::process::exit(2);
            }
        }
        builder = builder
            .root_cache_path(state::profiles_root())
            // Leading dashes are load-bearing for valueless switches in the
            // CEF adapter. Normal launches use the operating system keychain;
            // isolated automation may explicitly opt into its mock backend.
            .command_line_args(chromium_args);
    }

    #[cfg(target_os = "macos")]
    {
        // CEF's own word that a tab's web content process died, alongside
        // the DevTools signal; the crash registry folds the two together.
        builder = builder.on_web_content_process_terminate(crash::on_native_terminate);
    }
    builder = builder.on_permission_request(|webview, kind| permissions::decide(&webview, kind));
    // Signed updates need the release public key compiled in; a build
    // without one (development, CI checks) simply has no updater.
    if commands::updater_configured(option_env!("DIVE_UPDATER_PUBKEY")) {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    let specta_handler = specta.invoke_handler();

    let app = builder
        .invoke_handler(move |invoke: tauri::ipc::Invoke<Runtime>| {
            let caller = invoke.message.webview_ref();
            if !ipc_security::trusted_chrome_label(caller.label(), caller.window_ref().label()) {
                invoke
                    .resolver
                    .reject("application commands are only available to Dive chrome");
                return true;
            }
            if private_session::is_private() && !private_session::allows_command(invoke.message.command()) {
                invoke.resolver.reject("This action is available in a normal window. Private Mode keeps this session separate.");
                return true;
            }
            if invoke.message.command() == "report_startup_milestone" {
                handle_startup_invoke(invoke)
            } else {
                specta_handler(invoke)
            }
        })
        .on_window_event(|window, event| {
            // Closing a popout window closes the tab in it, the way closing
            // any browser window does. The tab tears the window down itself,
            // so the request is cancelled here.
            use tauri::Manager;
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && private_session::close_main(window) {
                api.prevent_close();
                return;
            }
            if window.label() == MAIN_WINDOW {
                match event {
                    tauri::WindowEvent::CloseRequested { .. }
                    | tauri::WindowEvent::Focused(false) => {
                        engine::remember_window_bounds(window);
                    }
                    // Resizes and moves arrive in bursts; a throttled save keeps
                    // the frame current without a store write per pixel. The
                    // final frame is caught by blur, close or quit.
                    tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                        engine::remember_window_bounds_throttled(window);
                    }
                    _ => {}
                }
            }
            // Closing the main window with popouts open would leave a headless
            // app: the tab host's window is gone but its views and the popouts
            // stay. Quit instead, the way a browser does when its primary
            // window goes away.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && window.label() == MAIN_WINDOW
                && !window
                    .app_handle()
                    .windows()
                    .keys()
                    .all(|label| label == MAIN_WINDOW)
            {
                api.prevent_close();
                window.app_handle().exit(0);
                return;
            }
            if let Some(tab) = engine::popout_tab(window.label())
                && matches!(
                    event,
                    tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Focused(false)
                )
            {
                webapp::remember_app_window(window, tab);
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && let Some(tab) = engine::popout_tab(window.label())
            {
                api.prevent_close();
                // On the main thread this runs inline, inside the window's own
                // close callback; the engine only sends messages on this path,
                // so no synchronous getter re-enters the runtime mid-event.
                let app = window.app_handle().clone();
                let _ = app.clone().run_on_main_thread(move || {
                    let Some(main) = engine::MainThread::here() else {
                        tracing::warn!(%tab, "closing popout was requested off the main thread");
                        return;
                    };
                    let state = app.state::<state::AppState>();
                    // Bringing a tab back destroys its popout window, and
                    // that destroy arrives here as a close request too. By
                    // then the tab is the main window's again; closing it
                    // would delete the very tab that was just brought back.
                    let still_detached = state::lock(&state.host)
                        .as_ref()
                        .is_some_and(|host| host.is_detached(tab));
                    if !still_detached {
                        tracing::debug!(%tab, "popout window closing after reattach; tab stays");
                        return;
                    }
                    if let Err(e) = commands::close_tab(&main, &app, &state, tab) {
                        tracing::warn!(%tab, "closing popout failed: {e}");
                    }
                });
            }
        })
        .setup(move |app| {
            specta.mount_events(app);
            #[cfg(feature = "cef")]
            if private_session::is_private() && cef::crash_reporting_enabled() != 0 {
                return Err("Private Mode requires native crash reporting to be disabled".into());
            }
            state::init(app)?;
            capture_scope::install(app)?;
            startup::record_milestone("state_init");
            engine::create_main_window(app)?;
            startup::record_milestone("window_created");
            menu::install(app)?;
            if std::env::var_os("DIVE_NORMAL_FRESH_WINDOW").is_none() {
                restore_session(app);
                open_startup_urls(app);
            }
            if let Some(broker) = setup_broker.as_ref() { broker.start(app.handle().clone())?; }
            open_startup_panels(app.handle().clone());
            if !private_session::is_private() { mcp::start(app.handle().clone()); }
            private_session::start_window_channel(app.handle().clone());
            private_session::ready();
            housekeeping::start(app.handle().clone());
            devservers::start(app.handle().clone());
            smoke_test(app.handle().clone());
            stress_test(app.handle().clone());
            cdp_bench(app.handle().clone());
            startup::record_milestone("setup_complete");
            startup::on_setup_completed(app.handle().clone());
            lifecycle_probe::start(app.handle().clone());
            #[cfg(feature = "cef")]
            private_probe::start(app.handle().clone());
            #[cfg(feature = "cef")]
            ui_probe::start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            tracing::error!(%error, "failed to build Dive");
            drop(log_guard);
            std::process::exit(1);
        }
    };
    let exit_code = app.run_return(|app, event| match event {
        // Why the process is going away is the first question after an
        // unexpected exit; say so in the log.
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            use tauri::Manager as _;
            tracing::info!(?code, "exit requested");
            // Quitting from the menu or Cmd+Q never sends the window a close
            // request, so the frame is saved here as well.
            if let Some(window) = app.get_window(MAIN_WINDOW) {
                engine::remember_window_bounds(&window);
            }
            let registry = app.state::<state::AppState>().screen_exports.clone();
            match registry.prepare_exit() {
                screen::jobs::ExitAction::Immediate => {}
                screen::jobs::ExitAction::InProgress => api.prevent_exit(),
                screen::jobs::ExitAction::Drain => {
                    api.prevent_exit();
                    drain_export_exit(app.clone(), registry, code.unwrap_or(0));
                }
            }
        }
        // A Dock click always brings a window back. macOS reports
        // `has_visible_windows` as true for a window that is only minimized,
        // so the guard that used to sit here — reopen only when there are no
        // visible windows — meant clicking the Dock icon of a minimized Dive
        // did nothing at all. Measured on macOS 27 by minimizing the window
        // and firing the same delegate method a Dock click does (`open -a`):
        // the event arrives, the flag is true, and the window stayed down.
        // Raising a window that is already up merely focuses it, which is what
        // a Dock click should do anyway.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => reopen_window(app),
        tauri::RunEvent::Exit => tracing::info!("event loop exited"),
        // Links the system hands us once Dive is the default browser (or a
        // file dropped on the Dock icon).
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => {
            let urls: Vec<String> = urls.into_iter().map(|u| u.to_string()).collect();
            open_handed_urls(app, urls);
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } => {
            tracing::info!(%label, "window destroyed");
            private_session::window_destroyed(app);
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { .. },
            ..
        } => tracing::info!(%label, "window close requested"),
        _ => {}
    });
    // Flush the asynchronous file logger after CEF and the app have drained,
    // then preserve the exit status for launchers and runtime probes.
    drop(log_guard);
    private_session::cleanup();
    if exit_code != 0 {
        std::process::exit(exit_code);
    }
}

fn startup_urls(mut args: impl Iterator<Item = String>, from_env: &str) -> Vec<String> {
    let mut urls = Vec::new();
    while let Some(arg) = args.next() {
        if matches!(
            arg.as_str(),
            "-ApplePersistenceIgnoreState" | "-ApplePersistence"
        ) {
            // AppKit's per-launch preference consumes its own value. Neither
            // token is a destination handed to the browser.
            let _ = args.next();
        } else if let Some(id) = arg.strip_prefix("--app=") {
            // An installed web app's launcher asks for its window by manifest
            // id. It travels the handoff as a pseudo-URL so the protocol and
            // its tests stay as they are.
            if !id.trim().is_empty() {
                urls.push(format!("{}{}", webapp::LAUNCH_PREFIX, id.trim()));
            }
        } else if !arg.starts_with("--") && !arg.starts_with("-psn_") && !arg.trim().is_empty() {
            urls.push(arg);
        }
    }
    urls.extend(from_env.split_whitespace().map(str::to_owned));
    urls
}

/// Open tabs for URLs given on the command line or in `DIVE_OPEN_URL`
/// (whitespace-separated). Lets `dive https://example.com` work and gives
/// automation a way to drive the app without accessibility permissions.
fn open_startup_urls(app: &tauri::App<Runtime>) {
    use tauri::Manager;
    let from_env = std::env::var("DIVE_OPEN_URL").unwrap_or_default();
    let urls = startup_urls(std::env::args().skip(1), &from_env);
    if urls.is_empty() {
        return;
    }
    let state = app.state::<state::AppState>();
    let Some(workspace) = *state::lock(&state.active_workspace) else {
        return;
    };
    let Some(main) = engine::MainThread::here() else {
        tracing::error!("startup tabs requested off the main thread");
        return;
    };
    for url in urls {
        if let Some(id) = url.strip_prefix(webapp::LAUNCH_PREFIX) {
            match webapp::open_by_id(&main, app.handle(), &state, id) {
                Ok(tab) => {
                    tracing::info!(%tab, id, "opened an installed app at startup");
                }
                Err(e) => {
                    tracing::warn!(id, "could not open an installed app at startup: {e}");
                }
            }
            continue;
        }
        match commands::open_tab(&main, app.handle(), &state, workspace, &url) {
            Ok(tab) => tracing::info!(%tab.id, url, "opened startup tab"),
            Err(e) => tracing::warn!(url, "failed to open startup tab: {e}"),
        }
    }
}

/// `DIVE_OPEN_PANEL=sidecar,dock`: toggle chrome panels once the chrome is
/// listening, exactly as the matching menu item would. Same purpose as
/// `DIVE_OPEN_URL`: automation without accessibility permission has no other
/// way to reach the panels.
fn open_startup_panels(app: tauri::AppHandle<Runtime>) {
    use tauri_specta::Event as _;
    let Ok(panels) = std::env::var("DIVE_OPEN_PANEL") else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        // The chrome subscribes to menu commands as it mounts; an event sent
        // before that is lost, and a toggle cannot be safely repeated.
        tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
        for panel in panels.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            let id = format!("{panel}.toggle");
            match menu::MenuCommand(id.clone()).emit_to(&app, CHROME_LABEL) {
                Ok(()) => tracing::info!(command = id, "opened startup panel"),
                Err(e) => tracing::warn!(command = id, "failed to open startup panel: {e}"),
            }
        }
    });
}

/// Console output plus a daily-rotated log file under the data directory,
/// so a report from the field carries what happened before the failure.
/// The guard flushes the file writer; it lives as long as `run`.
fn init_logging() -> Option<tracing_appender::non_blocking::WorkerGuard> {
    use tracing_subscriber::Layer as _;
    use tracing_subscriber::layer::SubscriberExt as _;
    use tracing_subscriber::util::SubscriberInitExt as _;
    if private_session::is_private() {
        return None;
    }
    let filter = || {
        tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "info,dive=debug".into())
    };
    let logs = state::data_root().join("logs");
    let file = std::fs::create_dir_all(&logs).ok().and_then(|()| {
        tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix("dive")
            .filename_suffix("log")
            .max_log_files(7)
            .build(&logs)
            .ok()
    });
    let (file_layer, guard) = match file {
        Some(appender) => {
            let (writer, guard) = tracing_appender::non_blocking(appender);
            let layer = tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(writer)
                .with_filter(filter());
            (Some(layer), Some(guard))
        }
        None => (None, None),
    };
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer().with_filter(filter()))
        .with(file_layer)
        .init();
    guard
}

/// Write every panic in the browser process to `crashes/` in the data
/// directory with the build version, then carry on to the default hook.
fn install_panic_hook() {
    if private_session::is_private() {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let dir = state::data_root().join("crashes");
        if std::fs::create_dir_all(&dir).is_ok() {
            let stamp = time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default()
                .replace(':', "-");
            let body = format!(
                "dive {} ({})\n{}\nthread: {}\n{}\n",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
                stamp,
                std::thread::current().name().unwrap_or("?"),
                info
            );
            let _ = std::fs::write(dir.join(format!("panic-{stamp}.txt")), body);
        }
        tracing::error!("{info}");
        previous(info);
    }));
}

/// Open URLs the OS handed to the app, each in its own tab of the active
/// workspace, and bring the window forward.
#[cfg(target_os = "macos")]
fn open_handed_urls(app: &tauri::AppHandle<Runtime>, urls: Vec<String>) {
    use tauri::Manager;
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(main) = engine::MainThread::here() else {
            return;
        };
        let state = handle.state::<state::AppState>();
        let Some(workspace) = *state::lock(&state.active_workspace) else {
            return;
        };
        for url in urls {
            if let Some(id) = url.strip_prefix(webapp::LAUNCH_PREFIX) {
                match webapp::open_by_id(&main, &handle, &state, id) {
                    Ok(tab) => {
                        tracing::info!(%tab, id, "opened an installed app from its launcher");
                    }
                    Err(e) => {
                        tracing::warn!(id, "could not open an installed app: {e}");
                    }
                }
                continue;
            }
            match commands::open_tab(&main, &handle, &state, workspace, &url) {
                Ok(tab) => tracing::info!(%tab.id, url, "opened a link handed by the system"),
                Err(e) => tracing::warn!(url, "could not open a handed link: {e}"),
            }
        }
        if let Some(window) = handle.get_window(MAIN_WINDOW) {
            let _ = window.show();
            let _ = window.set_focus();
        }
    });
}

/// `DIVE_CDP_BENCH=1`: once the first tab is up, time a burst of trivial
/// `DevTools` round trips on it and log the distribution. The in-process
/// bridge is the reason the agent tools are fast; this keeps that honest.
fn cdp_bench(app: tauri::AppHandle<Runtime>) {
    use tauri::Manager;
    if std::env::var_os("DIVE_CDP_BENCH").is_none() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(6)).await;
        let state = app.state::<state::AppState>();
        let session = state::lock(&state.host)
            .as_ref()
            .and_then(|h| h.active().and_then(|id| h.cdp(id)));
        let Some(session) = session else {
            tracing::warn!("cdp bench: no active tab");
            return;
        };
        let mut samples = Vec::with_capacity(100);
        for _ in 0..100 {
            let started = std::time::Instant::now();
            let ok = session
                .call(
                    "Runtime.evaluate",
                    serde_json::json!({"expression": "1", "returnByValue": true}),
                )
                .await
                .is_ok();
            if ok {
                samples.push(started.elapsed());
            }
        }
        if samples.is_empty() {
            tracing::warn!("cdp bench: every call failed");
            return;
        }
        samples.sort();
        let ms = |d: std::time::Duration| d.as_secs_f64() * 1000.0;
        let p50 = ms(samples[samples.len() / 2]);
        let p95 = ms(samples[samples.len() * 95 / 100]);
        let max = ms(*samples.last().unwrap_or(&std::time::Duration::ZERO));
        tracing::info!(
            "cdp bench: n={} p50_ms={p50:.3} p95_ms={p95:.3} max_ms={max:.3}",
            samples.len()
        );
    });
}

/// `DIVE_SMOKE=1`: a few seconds after start, capture the active tab to a
/// PNG, log the path, and exit. Used by CI and by automation that cannot
/// drive the UI.
fn smoke_test(app: tauri::AppHandle<Runtime>) {
    use tauri::Manager;
    if std::env::var_os("DIVE_SMOKE").is_none() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        let state = app.state::<state::AppState>();
        let active = state::lock(&state.host)
            .as_ref()
            .and_then(crate::engine::TabHost::active);
        let outcome = match active {
            Some(id) => match commands::capture_tab(&state, id, true).await {
                Ok(path) if std::env::var_os("DIVE_SMOKE_GIF").is_some() => {
                    smoke_gif(&app, &state, id).await.map(|gif| {
                        tracing::info!(path = %gif.display(), "smoke: gif ok");
                        path
                    })
                }
                other => other,
            },
            None => Err(AppError::new("no active tab")),
        };
        let code = match outcome {
            Ok(path) => {
                tracing::info!(path = %path.display(), "smoke: capture ok");
                0
            }
            Err(e) => {
                tracing::error!("smoke: capture failed: {e}");
                1
            }
        };
        app.exit(code);
    });
}

/// `DIVE_STRESS_TABS=<n>`: open `n` tabs cycling through the URLs in
/// `DIVE_STRESS_URLS`, wait for them to settle, force a discard sweep, and
/// exit. Logs `stress:` markers the memory harness samples resident memory
/// at. Run with `DIVE_MAX_IDLE_SECS=0` so every background tab is a
/// candidate, and give distinct sites: same-site tabs share one renderer.
fn stress_test(app: tauri::AppHandle<Runtime>) {
    use tauri::Manager;
    let Some(count) = std::env::var("DIVE_STRESS_TABS")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
    else {
        return;
    };
    let settle = std::env::var("DIVE_STRESS_SETTLE_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(15);
    let mut urls: Vec<String> = std::env::var("DIVE_STRESS_URLS")
        .ok()
        .map(|v| v.split_whitespace().map(str::to_owned).collect())
        .unwrap_or_default();
    if urls.is_empty() {
        urls.push("https://example.com".into());
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(settle)).await;
        tracing::info!(pid = std::process::id(), "stress: baseline");
        // Let the harness sample the baseline before the tabs start opening.
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let mut opened = 0;
        for i in 0..count {
            let (tx, rx) = tokio::sync::oneshot::channel();
            let on_main = app.clone();
            let url = urls[i % urls.len()].clone();
            if let Err(error) = app.run_on_main_thread(move || {
                let state = on_main.state::<state::AppState>();
                let workspace = *state::lock(&state.active_workspace);
                let result = match (workspace, engine::MainThread::here()) {
                    (Some(ws), Some(main)) => {
                        commands::open_tab(&main, &on_main, &state, ws, &url).map(|_| ())
                    }
                    _ => Err(AppError::new("stress: browser has no active workspace")),
                };
                let _ = tx.send(result);
            }) {
                tracing::warn!(%error, "stress: queuing tab open failed");
                continue;
            }
            match rx.await {
                Ok(Ok(())) => opened += 1,
                Ok(Err(error)) => tracing::warn!(%error, "stress: open failed"),
                Err(error) => tracing::warn!(%error, "stress: tab result dropped"),
            }
            // Let the newly active fixture parse before the next view hides it.
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        tokio::time::sleep(std::time::Duration::from_secs(settle)).await;
        if let Err(error) = memory_probe::record(&app, "loaded").await {
            tracing::error!(%error, "stress: heap diagnostics failed");
            app.exit(1);
            return;
        }
        tracing::info!(tabs = opened, "stress: loaded");
        // Keep the loaded phase alive long enough for the external harness to
        // sample it before discard begins reclaiming renderer memory.
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let discarded = match housekeeping::sweep(&app).await {
            Ok(n) => n,
            Err(e) => {
                tracing::error!("stress: sweep failed: {e}");
                app.exit(1);
                return;
            }
        };
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        if let Err(error) = memory_probe::record(&app, "swept").await {
            tracing::error!(%error, "stress: heap diagnostics failed");
            app.exit(1);
            return;
        }
        tracing::info!(discarded, "stress: swept");
        tracing::info!("stress: done");
        // Give the harness time to sample memory before the process goes.
        tokio::time::sleep(std::time::Duration::from_secs(8)).await;
        tracing::info!("stress: exiting");
        if let Err(error) = memory_probe::record(&app, "settled").await {
            tracing::error!(%error, "stress: heap diagnostics failed");
            app.exit(1);
            return;
        }
        // Sampling has stopped; reopening a discarded tab must not contaminate
        // the reclaim measurement, but still has to succeed before this passes.
        if let Err(error) = lifecycle_probe::verify_discarded_and_wake(&app).await {
            tracing::error!(%error, "stress: lifecycle registry or wake failed");
            app.exit(1);
            return;
        }
        app.exit(if discarded + 1 >= opened { 0 } else { 2 });
    });
}

/// Record three seconds of the tab while scrolling it, then encode the GIF.
async fn smoke_gif(
    app: &tauri::AppHandle<Runtime>,
    state: &state::AppState,
    id: dive_core::TabId,
) -> Result<std::path::PathBuf, AppError> {
    let session = state::lock(&state.host)
        .as_ref()
        .and_then(|h| h.cdp(id))
        .ok_or_else(|| AppError::new("no devtools session"))?;
    state
        .screencast
        .start(
            app.clone(),
            id,
            session.clone(),
            screencast::RecordOptions::default(),
            None,
            "about:blank",
        )
        .await?;
    for step in 0..6 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let _ = session
            .call(
                "Runtime.evaluate",
                serde_json::json!({"expression": format!("window.scrollTo(0, {})", step * 120)}),
            )
            .await;
    }
    let result = state.screencast.stop(id, &session).await?;
    Ok(std::path::PathBuf::from(result.path))
}

/// Open what the startup preference asks for: the tab that was active when
/// the app last ran, the home page, or nothing.
/// What a launch opens, from the `startup` preference.
#[derive(Debug, PartialEq, Eq)]
enum Startup<'a> {
    /// The welcome screen: no tab is activated, though the session's tabs are
    /// still listed in the strip.
    Welcome,
    /// The home page, in a new tab.
    Home(&'a str),
    /// The tab the last session ended on.
    Restore,
}

/// A home page that was never set means the welcome screen, not a silent
/// fallback to the last session: someone who chose to start fresh should not
/// be handed yesterday's tab because the field was left blank.
fn startup_plan<'a>(startup: &str, homepage: &'a str) -> Startup<'a> {
    match startup {
        "none" => Startup::Welcome,
        "home" => match homepage.trim() {
            "" => Startup::Welcome,
            url => Startup::Home(url),
        },
        _ => Startup::Restore,
    }
}

fn restore_session(app: &tauri::App<Runtime>) {
    use tauri::Manager;
    let state = app.state::<state::AppState>();
    let Some(workspace) = *state::lock(&state.active_workspace) else {
        return;
    };
    let prefs = state.prefs.get(&state);
    match startup_plan(&prefs.startup, &prefs.homepage) {
        Startup::Welcome => return,
        Startup::Home(url) => {
            let Some(main) = engine::MainThread::here() else {
                return;
            };
            match commands::open_tab(&main, app.handle(), &state, workspace, url) {
                Ok(tab) => tracing::info!(%tab.id, url = tab.url, "opened home page"),
                Err(e) => tracing::warn!("failed to open home page: {e}"),
            }
            return;
        }
        Startup::Restore => {}
    }
    let candidate = {
        let store = state::lock(&state.store);
        let remembered = store
            .setting(state::ACTIVE_TAB)
            .ok()
            .flatten()
            .and_then(|s| s.parse::<dive_core::TabId>().ok())
            .and_then(|id| store.tab(id).ok())
            .filter(|t| t.workspace_id == Some(workspace));
        remembered.or_else(|| store.last_active_tab(workspace).ok().flatten())
    };
    if let (Some(tab), Some(main)) = (candidate, engine::MainThread::here()) {
        match commands::activate_tab(&main, app.handle(), &state, tab.id) {
            Ok(()) => tracing::info!(%tab.id, url = tab.url, "restored session tab"),
            Err(e) => tracing::warn!("failed to restore session tab: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn dock_click_prefers_the_main_window_then_anything_else() {
        use super::window_for_dock_click;
        assert_eq!(window_for_dock_click(["pop-1-abc", "main"]), Some("main"));
        assert_eq!(window_for_dock_click(["main"]), Some("main"));
        // A torn-off tab or an installed app's window is better than nothing.
        assert_eq!(window_for_dock_click(["pop-1-abc"]), Some("pop-1-abc"));
        // Nothing left to raise: the caller opens a fresh window.
        assert_eq!(window_for_dock_click([]), None);
    }

    #[test]
    fn startup_urls_turn_an_app_flag_into_a_launch_url() {
        let urls = startup_urls(
            [
                "--app=https://mail.example/app",
                "https://x.example",
                "--app=",
                "--other",
            ]
            .map(String::from)
            .into_iter(),
            "",
        );
        assert_eq!(
            urls,
            vec![
                "dive-app://https://mail.example/app".to_owned(),
                "https://x.example".to_owned()
            ]
        );
    }

    #[test]
    fn startup_urls_ignore_appkit_override_pairs_and_launch_services_tokens() {
        let args = [
            "-ApplePersistenceIgnoreState",
            "YES",
            "-ApplePersistence",
            "NO",
            "https://first.test/",
            "-psn_0_42",
            "--disable-gpu",
            "https://second.test/",
        ];
        assert_eq!(
            super::startup_urls(args.into_iter().map(str::to_owned), "https://env.test/"),
            [
                "https://first.test/",
                "https://second.test/",
                "https://env.test/"
            ]
        );
    }

    #[test]
    fn startup_urls_accept_normal_urls_and_explicit_environment_values() {
        assert_eq!(
            super::startup_urls(
                ["https://test/", "", "data:text/plain,hello"]
                    .into_iter()
                    .map(str::to_owned),
                "https://env-a/ https://env-b/"
            ),
            [
                "https://test/",
                "data:text/plain,hello",
                "https://env-a/",
                "https://env-b/"
            ]
        );
    }
    use super::{Startup, startup_plan, startup_urls};

    #[test]
    fn a_home_start_with_no_home_page_lands_on_the_welcome_screen() {
        assert_eq!(startup_plan("home", ""), Startup::Welcome);
        assert_eq!(startup_plan("home", "   "), Startup::Welcome);
        assert_eq!(
            startup_plan("home", " https://dive.dev "),
            Startup::Home("https://dive.dev")
        );
        assert_eq!(startup_plan("none", "https://dive.dev"), Startup::Welcome);
        assert_eq!(
            startup_plan("restore", "https://dive.dev"),
            Startup::Restore
        );
    }

    #[test]
    fn test_chromium_switches_configuration() {
        let args = crate::startup::build_chromium_args(None);
        assert_eq!(args.len(), 4);
        assert_eq!(args[0], ("--process-per-site", None));
        assert_eq!(args[1], ("renderer-process-limit", Some("6".to_string())));
        assert_eq!(
            args[2],
            (
                "disable-features",
                Some("ImmersiveReadAnything,SpareRendererForSitePerProcess".to_string())
            )
        );
        assert_eq!(
            args[3],
            (
                "js-flags",
                Some(
                    "--gc-memory-reducer-start-delay-ms=1000 --memory-reducer-delay-ms=1000"
                        .to_string()
                )
            )
        );
        assert!(crate::startup::validate_switch_syntax(&args).is_ok());
    }

    #[test]
    fn startup_ipc_rejects_renderer_clock_payloads() {
        assert!(
            serde_json::from_value::<super::StartupMilestonePayload>(
                serde_json::json!({"milestone":"chrome_first_paint", "elapsedMs": 1.0})
            )
            .is_err()
        );
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn test_startup_timeline_instrumentation() {
        let _serial = crate::startup::test_lock();
        crate::startup::reset_for_test(None);
        crate::startup::record_custom_milestone("state_init", 12.0);
        crate::startup::record_custom_milestone("window_created", 35.0);
        crate::startup::record_custom_milestone("setup_complete", 50.0);

        let timeline = crate::startup::get_timeline();
        assert_eq!(timeline.state_init_ms, 12.0);
        assert_eq!(timeline.window_created_ms, 35.0);
        assert_eq!(timeline.setup_complete_ms, 50.0);
        assert_eq!(timeline.chrome_paint_ms, None);
    }
}
