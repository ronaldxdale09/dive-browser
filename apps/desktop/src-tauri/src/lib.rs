//! Dive desktop: Tauri host that owns the CEF engine, the core state and the
//! typed IPC surface used by the React chrome.

mod a11y;
mod agent;
mod agent_tools;
mod automation;
mod ax;
mod buffers;
mod cdp_feed;
mod commands;
mod console;
mod crash;
mod devservers;
mod emulate;
mod engine;
mod error;
mod favicon;
mod find;
mod har;
mod housekeeping;
mod inspect;
mod locator;
mod mcp;
mod menu;
mod meta;
mod network;
mod openapi;
mod pagescript;
mod prefs;
mod recorder;
mod replay;
mod report;
mod rules;
mod screencast;
mod snapshot;
mod sourcemaps;
pub mod startup;
mod state;
mod storage;
mod vitals;

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

#[derive(serde::Deserialize)]
struct StartupMilestonePayload {
    milestone: String,
    #[serde(alias = "elapsedMs")]
    elapsed_ms: f64,
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
            startup::record_custom_milestone(&data.milestone, data.elapsed_ms);
            resolver.resolve(());
        }
        Err(err) => {
            resolver.reject(err.to_string());
        }
    }
    true
}

/// Start the application. Under CEF this also serves as the sub-process
/// entry point.
#[cfg_attr(feature = "cef", tauri::cef_entry_point)]
pub fn run() {
    startup::record_launch();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,dive=debug".into()),
        )
        .init();

    agent::init_keychain();
    let specta = commands::specta_builder();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::<Runtime>::new();
    #[cfg(feature = "cef")]
    {
        builder = builder
            .root_cache_path(state::profiles_root())
            // Leading dashes are load-bearing: tauri's CEF handler appends a
            // valueless arg as a positional ARGUMENT unless it starts with "-",
            // and Chromium ignores it. Without the switch every launch asks for
            // the login keychain password to unlock "Chromium Safe Storage".
            // Value form: the runtime turns a bare name into a positional argument and a
            // dashed name into a doubled switch; `--use-mock-keychain=` is honored.
            .command_line_args(startup::build_chromium_args(None));
    }

    let specta_handler = specta.invoke_handler();

    builder
        .invoke_handler(move |invoke: tauri::ipc::Invoke<Runtime>| {
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
                && let Some(tab) = engine::popout_tab(window.label())
            {
                api.prevent_close();
                let app = window.app_handle().clone();
                let state = app.state::<state::AppState>();
                if let Err(e) = commands::close_tab(&app, &state, tab) {
                    tracing::warn!(%tab, "closing popout failed: {e}");
                }
            }
        })
        .setup(move |app| {
            specta.mount_events(app);
            state::init(app)?;
            startup::record_milestone("state_init");
            engine::create_main_window(app)?;
            startup::record_milestone("window_created");
            menu::install(app)?;
            restore_session(app);
            open_startup_urls(app);
            open_startup_panels(app.handle().clone());
            mcp::start(app.handle().clone());
            housekeeping::start(app.handle().clone());
            devservers::start(app.handle().clone());
            smoke_test(app.handle().clone());
            stress_test(app.handle().clone());
            startup::record_milestone("setup_complete");
            startup::on_setup_completed(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run dive");
}

/// Open tabs for URLs given on the command line or in `DIVE_OPEN_URL`
/// (whitespace-separated). Lets `dive https://example.com` work and gives
/// automation a way to drive the app without accessibility permissions.
fn open_startup_urls(app: &tauri::App<Runtime>) {
    use tauri::Manager;
    let from_env = std::env::var("DIVE_OPEN_URL").unwrap_or_default();
    let urls = std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with("--"))
        .chain(from_env.split_whitespace().map(str::to_owned))
        .filter(|u| !u.trim().is_empty())
        .collect::<Vec<_>>();
    if urls.is_empty() {
        return;
    }
    let state = app.state::<state::AppState>();
    let Some(workspace) = *state::lock(&state.active_workspace) else {
        return;
    };
    for url in urls {
        match commands::open_tab(app.handle(), &state, workspace, &url) {
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
                    smoke_gif(&state, id).await.map(|gif| {
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
        let (tx, rx) = tokio::sync::oneshot::channel();
        let on_main = app.clone();
        let _ = app.run_on_main_thread(move || {
            let state = on_main.state::<state::AppState>();
            let workspace = *state::lock(&state.active_workspace);
            let mut opened = 0;
            if let Some(ws) = workspace {
                for i in 0..count {
                    let url = &urls[i % urls.len()];
                    match commands::open_tab(&on_main, &state, ws, url) {
                        Ok(_) => opened += 1,
                        Err(e) => tracing::warn!("stress: open failed: {e}"),
                    }
                }
            }
            let _ = tx.send(opened);
        });
        let opened = rx.await.unwrap_or(0);
        tokio::time::sleep(std::time::Duration::from_secs(settle)).await;
        tracing::info!(tabs = opened, "stress: loaded");
        let discarded = match housekeeping::sweep(&app).await {
            Ok(n) => n,
            Err(e) => {
                tracing::error!("stress: sweep failed: {e}");
                app.exit(1);
                return;
            }
        };
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        tracing::info!(discarded, "stress: swept");
        tracing::info!("stress: done");
        // Give the harness time to sample memory before the process goes.
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        app.exit(if discarded + 1 >= opened { 0 } else { 2 });
    });
}

/// Record three seconds of the tab while scrolling it, then encode the GIF.
async fn smoke_gif(
    state: &state::AppState,
    id: dive_core::TabId,
) -> Result<std::path::PathBuf, AppError> {
    let session = state::lock(&state.host)
        .as_ref()
        .and_then(|h| h.cdp(id))
        .ok_or_else(|| AppError::new("no devtools session"))?;
    state.screencast.start(id, session.clone()).await?;
    for step in 0..6 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let _ = session
            .call(
                "Runtime.evaluate",
                serde_json::json!({"expression": format!("window.scrollTo(0, {})", step * 120)}),
            )
            .await;
    }
    state.screencast.stop(id, &session).await
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
            match commands::open_tab(app.handle(), &state, workspace, url) {
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
            .filter(|t| {
                t.workspace_id == Some(workspace) && t.state != dive_core::TabState::Discarded
            });
        remembered.or_else(|| store.last_active_tab(workspace).ok().flatten())
    };
    if let Some(tab) = candidate {
        match commands::activate_tab(app.handle(), &state, tab.id) {
            Ok(()) => tracing::info!(%tab.id, url = tab.url, "restored session tab"),
            Err(e) => tracing::warn!("failed to restore session tab: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Startup, startup_plan};

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
        assert_eq!(args[0], ("use-mock-keychain", Some(String::new())));
        assert_eq!(args[1], ("--disable-extensions", None));
        assert_eq!(args[2], ("--process-per-site", None));
        assert_eq!(args[3], ("renderer-process-limit", Some("6".to_string())));
        assert!(crate::startup::validate_switch_syntax(&args).is_ok());
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn test_startup_timeline_instrumentation() {
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
