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
            menu::install(app)?;
            restore_session(app);
            open_startup_urls(app);
            open_startup_panels(app.handle().clone());
            mcp::start(app.handle().clone());
            housekeeping::start(app.handle().clone());
            devservers::start(app.handle().clone());
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
}
