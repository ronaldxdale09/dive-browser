//! Process-wide state: persistence, event bus, command registry, tab host.

use std::path::PathBuf;
use std::sync::Mutex;

use dive_core::{CommandRegistry, Container, EventBus, Store, Workspace, WorkspaceId};
use tauri::{App, Manager};

use crate::Runtime;
use crate::engine::TabHost;

/// Shared state managed by Tauri.
///
/// # Locking
///
/// Every mutex here is a plain `std::sync::Mutex` held for a short sync
/// block and released before any `.await`. When two are needed at once the
/// order is always **`host`, then `store`**; `commands::activate_tab` is the
/// canonical example. Creating or showing a native view additionally needs
/// the main thread, which [`crate::engine::MainThread`] proves, and the
/// MCP server hops there with `AppBrowser::on_main` before touching `host`
/// for anything but a read.
pub struct AppState {
    /// Persistent store; one connection guarded by a mutex.
    pub store: Mutex<Store>,
    /// Broadcast of core changes, forwarded to the chrome as events.
    pub bus: EventBus,
    /// Every user-facing action.
    pub commands: CommandRegistry,
    /// Engine-side tab views; `None` until the main window exists.
    pub host: Mutex<Option<TabHost>>,
    /// Workspace currently shown in the chrome.
    pub active_workspace: Mutex<Option<WorkspaceId>>,
    /// Recent console/network activity per tab.
    pub buffers: crate::buffers::Buffers,
    /// Source map cache for stack frames.
    pub sourcemaps: crate::sourcemaps::Resolver,
    /// Agent actions waiting for the user's decision, by tool call id.
    pub approvals: Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<bool>>>,
    /// Agent runs in flight, so the chrome can stop one.
    pub agent_runs: crate::agent::Runs,
    /// Model listings fetched from providers, reused for a while.
    pub agent_models: crate::agent::ModelCache,
    /// Tab screen recordings in progress.
    pub screencast: crate::screencast::Registry,
    /// Opaque recording export jobs and their owned subprocesses.
    pub(crate) screen_exports: crate::screen::jobs::Registry,
    /// Mock and rewrite rules per workspace.
    pub rules: crate::rules::Registry,
    /// User preferences, cached from the settings table.
    pub prefs: crate::prefs::Registry,
    /// Immutable Dive-owned privacy matchers.
    pub privacy: crate::privacy::DivePrivacy,
    /// Replaceable per-tab document-start privacy preference scripts.
    pub privacy_pages: crate::privacy::PageRegistry,
    /// Dev servers discovered on this machine.
    pub devservers: crate::devservers::Registry,
    /// Element picks and style experiments from the in-page inspector.
    pub inspector: crate::inspect::Registry,
    /// Renderer crash history, so recovery has a budget.
    pub crashes: crate::crash::Registry,
    /// Native receipt generations and pending activity for safe discard.
    pub activity: std::sync::Arc<crate::activity::Registry>,
    /// Native permission requests and page-lifetime decisions.
    pub permissions: crate::permissions::Registry,
    /// Live-subtitle transcription sessions per tab.
    pub subtitles: crate::subtitles::Registry,
}

/// Directory holding every container's Chromium profile.
pub fn profiles_root() -> PathBuf {
    data_root().join("profiles")
}

/// Application data directory, created on demand.
///
/// Computed without an app handle because the CEF runtime needs the root
/// cache path before the app is built.
pub fn data_root() -> PathBuf {
    if crate::private_session::is_private() {
        return crate::private_session::data_root();
    }
    let base = std::env::var_os("DIVE_DATA_DIR").map_or_else(default_data_root, PathBuf::from);
    let _ = std::fs::create_dir_all(&base);
    base
}

/// The normal profile location, without private or automation overrides.
pub(crate) fn default_data_root() -> PathBuf {
    let home = std::env::var_os("HOME").map_or_else(std::env::temp_dir, PathBuf::from);
    #[cfg(target_os = "macos")]
    {
        home.join("Library/Application Support/app.dive.browser")
    }
    #[cfg(target_os = "linux")]
    {
        home.join(".local/share/dive")
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or(home)
            .join("dive")
    }
}

/// Open the store, seed defaults, and register state with the app.
pub fn init(app: &App<Runtime>) -> anyhow::Result<()> {
    let root = data_root();
    let store = if crate::private_session::is_private() {
        Store::in_memory()?
    } else {
        Store::open(root.join("dive.db"))?
    };
    let active = seed_defaults(&store)?;
    if crate::private_session::is_private() {
        for mut container in store.containers()? {
            container.persist_cookies = false;
            store.upsert_container(&container)?;
        }
    }

    let state = AppState {
        store: Mutex::new(store),
        bus: EventBus::new(),
        commands: CommandRegistry::new(),
        host: Mutex::new(None),
        active_workspace: Mutex::new(Some(active)),
        buffers: crate::buffers::Buffers::default(),
        sourcemaps: crate::sourcemaps::Resolver::default(),
        approvals: Mutex::new(std::collections::HashMap::new()),
        agent_runs: Mutex::new(std::collections::HashMap::new()),
        agent_models: Mutex::new(std::collections::HashMap::new()),
        screencast: crate::screencast::Registry::default(),
        screen_exports: crate::screen::jobs::Registry::default(),
        rules: crate::rules::Registry::default(),
        prefs: crate::prefs::Registry::default(),
        privacy: crate::privacy::DivePrivacy::new(),
        privacy_pages: crate::privacy::PageRegistry::default(),
        devservers: crate::devservers::Registry::default(),
        inspector: crate::inspect::Registry::default(),
        crashes: crate::crash::Registry::default(),
        activity: std::sync::Arc::default(),
        permissions: crate::permissions::Registry::default(),
        subtitles: crate::subtitles::Registry::default(),
    };
    crate::commands::register_builtin(&state.commands);
    app.manage(state);
    Ok(())
}

/// Setting keys used for session restore.
pub const ACTIVE_WORKSPACE: &str = "active_workspace";
/// Setting keys used for session restore.
pub const ACTIVE_TAB: &str = "active_tab";

/// Ensure at least one container and workspace exist; return the workspace to
/// show: the last active one if it still exists, else the first.
fn seed_defaults(store: &Store) -> anyhow::Result<WorkspaceId> {
    // Profiles came later than workspaces: an older database gets its
    // "Personal" profile here, adopting every workspace it already had.
    let profile = store.ensure_default_profile()?;
    let workspaces = store.workspaces()?;
    if !workspaces.is_empty() {
        let remembered = store
            .setting(ACTIVE_WORKSPACE)?
            .and_then(|s| s.parse::<WorkspaceId>().ok())
            .filter(|id| workspaces.iter().any(|w| w.id == *id));
        return Ok(remembered.unwrap_or(workspaces[0].id));
    }
    let container = if let Some(c) = store.containers()?.into_iter().next() {
        c
    } else {
        let c = Container::new("Personal");
        store.upsert_container(&c)?;
        c
    };
    let workspace = Workspace::new("Home", container.id, profile.id, 0);
    store.upsert_workspace(&workspace)?;
    tracing::info!(id = %workspace.id, "seeded default workspace");
    Ok(workspace.id)
}

/// Lock helper that tolerates poisoning.
pub fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}
