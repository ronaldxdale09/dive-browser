//! Dive desktop: Tauri host that owns the CEF engine, the core state and the
//! typed IPC surface used by the React chrome.

mod a11y;
mod agent;
mod agent_tools;
mod ax;
mod buffers;
mod cdp_feed;
mod commands;
mod console;
mod devservers;
mod emulate;
mod engine;
mod error;
mod favicon;
mod find;
mod housekeeping;
mod mcp;
mod meta;
mod network;
mod sourcemaps;
mod state;
mod storage;
mod vitals;

pub use error::AppError;

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

/// Start the application. Under CEF this also serves as the sub-process
/// entry point.
#[cfg_attr(feature = "cef", tauri::cef_entry_point)]
pub fn run() {
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
            .command_line_args([("use-mock-keychain", Some(String::new()))]);
    }

    builder
        .invoke_handler(specta.invoke_handler())
        .setup(move |app| {
            specta.mount_events(app);
            state::init(app)?;
            engine::create_main_window(app)?;
            restore_session(app);
            open_startup_urls(app);
            mcp::start(app.handle().clone());
            housekeeping::start(app.handle().clone());
            smoke_test(app.handle().clone());
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
            Some(id) => commands::capture_tab(&state, id, true).await,
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

/// Re-show the tab that was active when the app last ran, if it still exists
/// in the remembered workspace.
fn restore_session(app: &tauri::App<Runtime>) {
    use tauri::Manager;
    let state = app.state::<state::AppState>();
    let Some(workspace) = *state::lock(&state.active_workspace) else {
        return;
    };
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
