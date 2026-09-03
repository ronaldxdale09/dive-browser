//! Dive desktop: Tauri host that owns the CEF engine, the core state and the
//! typed IPC surface used by the React chrome.

mod commands;
mod engine;
mod error;
mod state;

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

    let specta = commands::specta_builder();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::<Runtime>::new();
    #[cfg(feature = "cef")]
    {
        builder = builder
            .root_cache_path(state::profiles_root())
            .command_line_args([("use-mock-keychain", None::<String>)]);
    }

    builder
        .invoke_handler(specta.invoke_handler())
        .setup(move |app| {
            specta.mount_events(app);
            state::init(app)?;
            engine::create_main_window(app)?;
            open_startup_urls(app);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run dive");
}

/// Open tabs for URLs given on the command line or in `DIVE_OPEN_URL`
/// (comma-separated). Lets `dive https://example.com` work and gives
/// automation a way to drive the app without accessibility permissions.
fn open_startup_urls(app: &tauri::App<Runtime>) {
    use tauri::Manager;
    let from_env = std::env::var("DIVE_OPEN_URL").unwrap_or_default();
    let urls = std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with("--"))
        .chain(from_env.split(',').map(str::to_owned))
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
