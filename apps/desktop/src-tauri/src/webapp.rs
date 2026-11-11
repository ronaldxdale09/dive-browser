//! Installed web apps: a site's manifest turned into a window of its own.
//!
//! Chrome's model, kept small. A page whose manifest passes the
//! installability rules (see `inject/webapp.js`) can be installed: its icon
//! is rendered to a PNG, a row is written for the profile, and — on macOS —
//! a launcher bundle lands in `~/Applications/Dive Apps` so the app appears
//! in Spotlight and can sit in the Dock. Opening the app tears a tab into a
//! popout whose chrome is the app chrome (`?app=` in the chrome URL), sized
//! to the frame the app last had. Everything else — cookies, logins,
//! extensions, protection — is the profile's, exactly as in a normal tab.

// Tauri command arguments arrive owned by contract, like the rest of the
// command surface in commands.rs.
#![allow(clippy::needless_pass_by_value)]

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use base64::Engine as _;
use dive_core::{TabId, Timestamp, WebApp};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, State};

use crate::{
    Runtime,
    commands::{cdp_for, detach_tab, on_main, open_tab},
    engine::{self, AppWindowSpec, MainThread, WindowBounds},
    error::{AppError, AppResult},
    state::{self, AppState, lock},
};

/// Pseudo-URL scheme a launcher hands to a running Dive: `dive-app://<id>`.
pub const LAUNCH_PREFIX: &str = "dive-app://";

/// Smallest icon that can stand on a Dock; Chrome's threshold too.
const MIN_ICON: u32 = 192;
/// The PNG written at install time.
const ICON_SIZE: u32 = 512;
/// An icon larger than this is not an icon.
const MAX_ICON_BYTES: usize = 8 * 1024 * 1024;

/// What the page's manifest says, once checked against the install rules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct WebAppProbe {
    /// Whether every rule passed.
    pub installable: bool,
    /// Which rule failed, when one did.
    #[serde(default)]
    pub reason: Option<String>,
    /// Manifest `id`, or the start URL.
    #[serde(default)]
    pub id: Option<String>,
    /// Manifest `name`.
    #[serde(default)]
    pub name: Option<String>,
    /// Manifest `short_name`.
    #[serde(default)]
    pub short_name: Option<String>,
    /// Absolute start URL.
    #[serde(default)]
    pub start_url: Option<String>,
    /// Absolute scope prefix.
    #[serde(default)]
    pub scope: Option<String>,
    /// Display mode.
    #[serde(default)]
    pub display: Option<String>,
    /// Manifest `theme_color`.
    #[serde(default)]
    pub theme_color: Option<String>,
    /// Manifest `background_color`.
    #[serde(default)]
    pub background_color: Option<String>,
    /// The icon chosen for install, absolute.
    #[serde(default)]
    pub icon_url: Option<String>,
    /// That icon's declared size in pixels.
    #[serde(default)]
    pub icon_size: Option<u32>,
    /// Where the manifest was read from.
    #[serde(default)]
    pub manifest_url: Option<String>,
    /// Manifest `description`, trimmed.
    #[serde(default)]
    pub description: Option<String>,
    /// Set when an installed app already covers this page.
    #[serde(default)]
    pub installed: Option<WebApp>,
}

/// Run a probe in Dive's isolated world (see `page_world`). It reads the
/// page's DOM and fetches as the page, but in the page's own world a page
/// could replace `fetch`, `URL` or `JSON` and have the probe return whatever
/// name, start URL and icon it liked.
async fn evaluate(session: &dive_cdp::CdpSession, script: String) -> AppResult<Value> {
    let result = crate::page_world::evaluate(
        session,
        json!({ "expression": script, "awaitPromise": true, "returnByValue": true }),
    )
    .await
    .map_err(|e| AppError::new(format!("could not read the page's manifest: {e}")))?;
    if let Some(text) = result["exceptionDetails"]["exception"]["description"].as_str() {
        return Err(AppError::new(format!("manifest probe threw: {text}")));
    }
    Ok(result["result"]["value"].clone())
}

async fn probe_tab(state: &AppState, id: TabId) -> AppResult<WebAppProbe> {
    let session = cdp_for(state, id)?;
    let script = crate::pagescript::build("webapp.js", &[("__MIN_ICON__", MIN_ICON.to_string())]);
    let value = evaluate(&session, script).await?;
    let probe: WebAppProbe = serde_json::from_value(value)
        .map_err(|e| AppError::new(format!("manifest probe returned an odd shape: {e}")))?;
    // Judged against the address the browser has for the tab, not the one
    // the page reports: the report is the page's word.
    let tab_url = lock(&state.store).tab(id)?.url;
    let mut probe = checked(probe, &tab_url);
    if let Some(app_id) = probe.id.as_deref() {
        probe.installed = lock(&state.store).web_app(app_id)?;
    }
    Ok(probe)
}

/// Display modes a manifest may ask for; anything else is a standalone app.
const DISPLAY_MODES: &[&str] = &[
    "fullscreen",
    "standalone",
    "minimal-ui",
    "browser",
    "window-controls-overlay",
    "tabbed",
];
/// Longest app name kept. A name is shown in a title bar and written into a
/// launcher's file name, and neither has room for a paragraph.
const NAME_CAP: usize = 100;

/// The page's report, held to what an install may write.
///
/// The probe runs in the page, so everything in it is what the page chose
/// to say. An install writes a launcher that opens `start_url`, keeps the
/// app's window within `scope`, and names the app by `id` -- so a page that
/// could report a `file:` or `dive:` start URL, or another site's, would
/// get an icon in the Dock that opens whatever it liked under a name it
/// picked. The addresses have to be web addresses (https, or http on this
/// machine), of the tab's own site, with the start URL inside the scope and
/// the id on the start URL's origin, as the manifest spec has them. A report
/// that fails is returned as not installable, with the reason.
fn checked(mut probe: WebAppProbe, tab_url: &str) -> WebAppProbe {
    if !probe.installable {
        return probe;
    }
    match check_addresses(&probe, tab_url) {
        Ok((id, start_url, scope, manifest_url, icon_url)) => {
            probe.id = Some(id);
            probe.start_url = Some(start_url);
            probe.scope = Some(scope);
            probe.manifest_url = Some(manifest_url);
            probe.icon_url = Some(icon_url);
        }
        Err(reason) => {
            probe.installable = false;
            probe.reason = Some(reason);
            return probe;
        }
    }
    probe.name = probe.name.as_deref().and_then(|n| plain_text(n, NAME_CAP));
    probe.short_name = probe
        .short_name
        .as_deref()
        .and_then(|n| plain_text(n, NAME_CAP));
    probe.description = probe
        .description
        .as_deref()
        .and_then(|d| plain_text(d, 500));
    probe.display = Some(
        probe
            .display
            .filter(|d| DISPLAY_MODES.contains(&d.as_str()))
            .unwrap_or_else(|| "standalone".into()),
    );
    probe.theme_color = probe.theme_color.filter(|c| css_color(c));
    probe.background_color = probe.background_color.filter(|c| css_color(c));
    if probe.name.is_none() {
        probe.installable = false;
        probe.reason = Some("the manifest has no usable name".into());
    }
    probe
}

/// An address an app may live at: https anywhere, http only on this
/// machine, where dev servers run without certificates.
fn app_address(value: Option<&str>, what: &str) -> Result<url::Url, String> {
    let value = value.ok_or_else(|| format!("the manifest has no {what}"))?;
    let url =
        url::Url::parse(value).map_err(|_| format!("the manifest's {what} is not an address"))?;
    let local = url.scheme() == "http" && crate::netfetch::names_local_host(&url);
    if url.scheme() != "https" && !local {
        return Err(format!(
            "the manifest's {what} is not an https address, so it cannot be installed"
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!("the manifest's {what} carries a password"));
    }
    Ok(url)
}

/// The id, start URL, scope, manifest and icon addresses, checked.
fn check_addresses(
    probe: &WebAppProbe,
    tab_url: &str,
) -> Result<(String, String, String, String, String), String> {
    let tab = app_address(Some(tab_url), "page address").map_err(|_| {
        "only a page served over https (or from this machine) can be installed".to_owned()
    })?;
    let site = crate::site::of_url(&tab);
    let start = app_address(probe.start_url.as_deref(), "start_url")?;
    let scope = app_address(probe.scope.as_deref(), "scope")?;
    for (url, what) in [(&start, "start_url"), (&scope, "scope")] {
        if crate::site::of_url(url) != site {
            return Err(format!(
                "the manifest's {what} is on another site than the page, so it cannot be installed from here"
            ));
        }
    }
    if !start.as_str().starts_with(scope.as_str()) {
        return Err("the manifest's start_url is outside its scope".into());
    }
    // The spec resolves an id against the start URL and requires the same
    // origin; an id elsewhere would let one site claim another's app.
    let id = match probe.id.as_deref() {
        Some(id) => {
            url::Url::parse(id).map_err(|_| "the manifest's id is not an address".to_owned())?
        }
        None => start.clone(),
    };
    if id.origin() != start.origin() {
        return Err("the manifest's id is on another origin than its start_url".into());
    }
    let manifest = app_address(probe.manifest_url.as_deref(), "manifest address")?;
    let icon = probe
        .icon_url
        .as_deref()
        .ok_or_else(|| "the manifest has no icon".to_owned())?;
    let icon_ok = icon.starts_with("data:image/") || app_address(Some(icon), "icon").is_ok();
    if !icon_ok {
        return Err("the manifest's icon is not an https address or an image".into());
    }
    Ok((
        id.into(),
        start.into(),
        scope.into(),
        manifest.into(),
        icon.to_owned(),
    ))
}

/// `value` with control characters gone and runs of space collapsed, cut to
/// `cap` characters, or `None` when nothing is left.
fn plain_text(value: &str, cap: usize) -> Option<String> {
    let flat = value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let cut: String = flat.chars().take(cap).collect();
    (!cut.is_empty()).then_some(cut)
}

/// Whether `value` reads as one CSS colour and nothing more.
fn css_color(value: &str) -> bool {
    value.len() <= 64
        && !value.is_empty()
        && value.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '#' | '(' | ')' | ',' | '.' | '%' | ' ' | '/' | '-')
        })
}

/// Whether the page in `id` can be installed, and as what.
#[tauri::command]
#[specta::specta]
pub(crate) async fn webapp_probe(state: State<'_, AppState>, id: TabId) -> AppResult<WebAppProbe> {
    probe_tab(&state, id).await
}

/// Installed apps for the current profile, most recently opened first.
#[tauri::command]
#[specta::specta]
pub(crate) fn webapps_list(state: State<'_, AppState>) -> AppResult<Vec<WebApp>> {
    Ok(lock(&state.store).list_web_apps()?)
}

/// The installed app whose scope covers the page in `id`, if any.
#[tauri::command]
#[specta::specta]
pub(crate) fn webapp_for_tab(state: State<'_, AppState>, id: TabId) -> AppResult<Option<WebApp>> {
    let store = lock(&state.store);
    let tab = store.tab(id)?;
    Ok(store.web_app_for_url(&tab.url)?)
}

/// An installed app's icon as a `data:` URL, the way bookmarks carry their
/// favicon. Read through IPC rather than the asset protocol: the data root
/// can live anywhere (`DIVE_DATA_DIR`), so no static asset scope covers it.
#[tauri::command]
#[specta::specta]
pub(crate) fn webapp_icon(state: State<'_, AppState>, app_id: String) -> AppResult<Option<String>> {
    let Some(app) = lock(&state.store).web_app(&app_id)? else {
        return Ok(None);
    };
    match std::fs::read(&app.icon_path) {
        Ok(bytes) => Ok(Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))),
        Err(e) => {
            tracing::debug!(app = %app.name, "could not read the app icon: {e}");
            Ok(None)
        }
    }
}

/// The installed app an app window is showing, by manifest id.
#[tauri::command]
#[specta::specta]
pub(crate) fn webapp_for_window(
    state: State<'_, AppState>,
    app_id: String,
) -> AppResult<Option<WebApp>> {
    Ok(lock(&state.store).web_app(&app_id)?)
}

/// The first 16 hex digits of SHA-256 over the app id: the same on every
/// build, unlike the standard library hasher, whose algorithm may change between Rust
/// releases.
fn stable_id(id: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(id.as_bytes()))[..16].to_owned()
}

/// Where an app's files live: a directory named by a hash of its id, so any
/// id — they are URLs — is a safe path.
fn app_dir(id: &str) -> PathBuf {
    state::data_root().join("webapps").join(stable_id(id))
}

/// Delete an app's data folder, but only one inside Dive's own `webapps`
/// directory: a record is data, and must not be able to point a delete
/// somewhere else.
fn remove_app_dir(dir: &Path) {
    let webapps = state::data_root().join("webapps");
    if dir == webapps
        || !dir.starts_with(&webapps)
        || dir.components().any(|c| c.as_os_str() == "..")
    {
        tracing::warn!(path = %dir.display(), "not removing a folder outside Dive's web app files");
        return;
    }
    if let Err(e) = std::fs::remove_dir_all(dir)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(path = %dir.display(), "could not remove the app's files: {e}");
    }
}

/// Render the icon inside the page: no rasterizer needed for SVG or WebP,
/// and the fetch carries the page's cookies.
async fn icon_from_page(session: &dive_cdp::CdpSession, icon_url: &str) -> Result<Vec<u8>, String> {
    let script = crate::pagescript::build(
        "webapp-icon.js",
        &[
            (
                "__ICON_URL__",
                serde_json::to_string(icon_url).unwrap_or_default(),
            ),
            ("__SIZE__", ICON_SIZE.to_string()),
        ],
    );
    let value = evaluate(session, script).await.map_err(|e| e.message)?;
    if let Some(error) = value["error"].as_str() {
        return Err(error.to_owned());
    }
    let data_url = value["png"].as_str().ok_or("no png in reply")?;
    let encoded = data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or("reply was not a PNG data URL")?;
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("bad base64: {e}"))
}

/// Fall back to fetching the icon ourselves and resizing it. Handles PNG and
/// JPEG; an SVG on a CDN without CORS is the one case neither path covers.
///
/// The page chose the address, so the fetch is held to the public internet
/// (see [`crate::netfetch`]) unless the app itself is served from this
/// machine, where a dev server keeps its icons beside it.
async fn icon_from_network(icon_url: &str, tab_url: &str) -> Result<Vec<u8>, String> {
    let local = |u: &str| url::Url::parse(u).is_ok_and(|u| crate::netfetch::names_local_host(&u));
    let reach = if local(tab_url) && local(icon_url) {
        crate::netfetch::Reach::AlsoLocal
    } else {
        crate::netfetch::Reach::Public
    };
    let bytes = crate::netfetch::get(
        icon_url,
        reach,
        MAX_ICON_BYTES,
        Duration::from_secs(15),
        true,
    )
    .await?;
    let image = image::load_from_memory(&bytes).map_err(|e| format!("undecodable icon: {e}"))?;
    let square = image.resize_to_fill(ICON_SIZE, ICON_SIZE, image::imageops::FilterType::Lanczos3);
    let mut out = std::io::Cursor::new(Vec::new());
    square
        .write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| format!("could not encode icon: {e}"))?;
    Ok(out.into_inner())
}

fn write_icon(dir: &Path, png: &[u8]) -> AppResult<PathBuf> {
    std::fs::create_dir_all(dir)
        .map_err(|e| AppError::new(format!("could not create {}: {e}", dir.display())))?;
    let path = dir.join("icon.png");
    std::fs::write(&path, png)
        .map_err(|e| AppError::new(format!("could not write the icon: {e}")))?;
    Ok(path)
}

fn spec_for(app: &WebApp) -> AppWindowSpec {
    AppWindowSpec {
        id: app.id.clone(),
        name: app.name.clone(),
        bounds: WindowBounds::parse_app(&app.bounds),
    }
}

/// Install the app the page in `id` describes, then move that page into the
/// app's window, the way Chrome does: the tab you were on becomes the app.
#[tauri::command]
#[specta::specta]
pub(crate) async fn webapp_install(
    app: AppHandle<Runtime>,
    state: State<'_, AppState>,
    id: TabId,
) -> AppResult<WebApp> {
    let probe = probe_tab(&state, id).await?;
    if !probe.installable {
        return Err(AppError::new(format!(
            "this page cannot be installed: {}",
            probe.reason.as_deref().unwrap_or("it has no app manifest")
        )));
    }
    let field = |value: Option<String>, what: &str| {
        value.ok_or_else(|| AppError::new(format!("manifest has no {what}")))
    };
    let app_id = field(probe.id, "id")?;
    let icon_url = field(probe.icon_url, "icon")?;

    let session = cdp_for(&state, id)?;
    let tab_url = lock(&state.store).tab(id)?.url;
    let png = match icon_from_page(&session, &icon_url).await {
        Ok(png) => png,
        Err(in_page) => icon_from_network(&icon_url, &tab_url)
            .await
            .map_err(|network| {
                AppError::new(format!(
                    "could not fetch the app icon: {in_page}; {network}"
                ))
            })?,
    };
    let dir = app_dir(&app_id);
    let icon_path = write_icon(&dir, &png)?;

    let existing = lock(&state.store).web_app(&app_id)?;
    // An app installed before ids were hashed with SHA-256 keeps its files in
    // a folder named by the old hash. Carry what it recorded about its
    // launcher across, then drop that folder: nothing points at it any more.
    if let Some(old) = existing
        .as_ref()
        .and_then(|e| Path::new(&e.icon_path).parent())
        .filter(|old| *old != dir)
    {
        launcher::carry_record(old, &dir);
        remove_app_dir(old);
    }
    // The app opens where it was installed from: that workspace's container
    // holds the cookies and logins the page was using.
    let workspace_id = lock(&state.store)
        .tab(id)
        .ok()
        .and_then(|tab| tab.workspace_id);
    let record = WebApp {
        id: app_id,
        name: field(probe.name, "name")?,
        short_name: probe.short_name.unwrap_or_default(),
        start_url: field(probe.start_url, "start_url")?,
        scope: field(probe.scope, "scope")?,
        display: probe.display.unwrap_or_else(|| "standalone".into()),
        theme_color: probe.theme_color,
        background_color: probe.background_color,
        icon_path: icon_path.to_string_lossy().into_owned(),
        manifest_url: field(probe.manifest_url, "manifest_url")?,
        created_at: existing
            .as_ref()
            .map_or_else(|| Timestamp::now().to_rfc3339(), |e| e.created_at.clone()),
        last_opened_at: existing.as_ref().and_then(|e| e.last_opened_at.clone()),
        bounds: existing
            .as_ref()
            .map(|e| e.bounds.clone())
            .unwrap_or_default(),
        workspace_id,
    };
    lock(&state.store).add_web_app(&record)?;

    // The launcher is a convenience, not the install: a failure to write it
    // is reported in the log and the app still works from inside Dive.
    //
    // On the blocking pool because it spawns a subprocess and waits: PowerShell
    // on Windows, `sips` on macOS. Run inline it held a runtime worker for as
    // long as the child took, and forever if the child hung.
    let launcher_for = record.clone();
    if let Ok(Err(e)) =
        tauri::async_runtime::spawn_blocking(move || launcher::install(&launcher_for)).await
    {
        tracing::warn!(app = %record.name, "could not write the app launcher: {e}");
    }

    let spec = spec_for(&record);
    let opened = record.clone();
    on_main(&app, move |main, app, state| {
        detach_tab(main, app, state, id, None, Some(&spec))?;
        lock(&state.store).touch_web_app(&opened.id, Timestamp::now())?;
        Ok(())
    })?;
    Ok(record)
}

/// Open an installed app: raise its window if it has one, otherwise open its
/// start URL in the workspace it was installed from and tear that tab into an
/// app window. An app from before Dive remembered that, or whose workspace
/// has since been deleted, opens in the active workspace.
pub(crate) fn open_by_id(
    main: &MainThread,
    app: &AppHandle<Runtime>,
    state: &AppState,
    app_id: &str,
) -> AppResult<TabId> {
    let record = lock(&state.store)
        .web_app(app_id)?
        .ok_or_else(|| AppError::new("that app is not installed"))?;
    let already = lock(&state.host)
        .as_ref()
        .and_then(|h| h.tab_for_app(app_id));
    if let Some(tab) = already {
        if let Some(host) = lock(&state.host).as_ref() {
            host.focus_popout(tab)?;
        }
        return Ok(tab);
    }
    // Checked again on the way out: a record written before installs were
    // checked could hold any address, and opening one is a navigation Dive
    // makes on the app's behalf.
    app_address(Some(&record.start_url), "start_url").map_err(AppError::new)?;
    let installed_in = record
        .workspace_id
        .filter(|workspace| lock(&state.store).workspace(*workspace).is_ok());
    let workspace = installed_in
        .or(*lock(&state.active_workspace))
        .ok_or_else(|| AppError::new("no active workspace to open the app in"))?;
    let tab = open_tab(main, app, state, workspace, &record.start_url)?;
    detach_tab(main, app, state, tab.id, None, Some(&spec_for(&record)))?;
    lock(&state.store).touch_web_app(app_id, Timestamp::now())?;
    Ok(tab.id)
}

/// Open an installed app from the chrome.
#[tauri::command]
#[specta::specta]
pub(crate) fn webapp_open(app: AppHandle<Runtime>, app_id: String) -> AppResult<TabId> {
    on_main(&app, move |main, app, state| {
        open_by_id(main, app, state, &app_id)
    })
}

/// Uninstall an app. A window it has open becomes an ordinary tab again
/// rather than being closed under the person.
#[tauri::command]
#[specta::specta]
pub(crate) fn webapp_uninstall(app: AppHandle<Runtime>, app_id: String) -> AppResult<()> {
    let (record, others) = {
        let state = app.state::<AppState>();
        let record = lock(&state.store).web_app(&app_id)?;
        let Some(record) = record else {
            return Ok(());
        };
        // Read in a lock of its own: the launcher must know which other apps
        // share its name before it deletes anything by name.
        let others: Vec<WebApp> = lock(&state.store)
            .list_web_apps()?
            .into_iter()
            .filter(|other| other.id != app_id)
            .collect();
        let open_tab = lock(&state.host)
            .as_ref()
            .and_then(|h| h.tab_for_app(&app_id));
        if let Some(tab) = open_tab {
            crate::commands::tab_attach(app.clone(), tab)?;
        }
        lock(&state.store).remove_web_app(&app_id)?;
        (record, others)
    };
    if let Err(e) = launcher::remove(&record, &others) {
        tracing::warn!(app = %record.name, "could not remove the app launcher: {e}");
    }
    remove_app_dir(&app_dir(&record.id));
    // An install from before the id hash changed lives in the folder its
    // icon sits in, which is not `app_dir`'s answer any more.
    if let Some(old) = Path::new(&record.icon_path).parent() {
        remove_app_dir(old);
    }
    Ok(())
}

/// Remember an app window's frame, from the window event hook.
pub(crate) fn remember_app_window(window: &tauri::Window<Runtime>, tab: TabId) {
    let state = window.app_handle().state::<AppState>();
    let app_id = lock(&state.host)
        .as_ref()
        .and_then(|h| h.app_for_tab(tab).map(str::to_owned));
    let Some(app_id) = app_id else {
        return;
    };
    let Some(bounds) = engine::windowed_bounds(window) else {
        return;
    };
    if let Err(e) = lock(&state.store).set_web_app_bounds(&app_id, &bounds.serialize()) {
        tracing::debug!("could not remember an app window's frame: {e}");
    }
}

/// The macOS launcher: a bundle in `~/Applications/Dive Apps` whose
/// executable starts Dive with `--app=<id>`. A running Dive receives that
/// through the second-launch handoff and opens the app's window; otherwise
/// Dive starts and opens it. The bundle carries the app's name and icon, so
/// Spotlight, Launchpad and the Dock treat it as the app.
mod launcher {
    use super::{Path, PathBuf, WebApp, stable_id};
    use serde::{Deserialize, Serialize};

    /// The file in an app's data folder that lists the launcher files Dive
    /// wrote for it, so removal touches those and nothing else.
    const OWNED: &str = "launcher.json";

    /// Launcher files an app owns.
    #[derive(Serialize, Deserialize, Default)]
    struct Owned {
        paths: Vec<PathBuf>,
    }

    /// The folder the record's icon lives in: new installs and installs made
    /// under the old hash alike, so no old hash is ever recomputed.
    fn data_folder(app: &WebApp) -> Option<PathBuf> {
        Path::new(&app.icon_path).parent().map(Path::to_path_buf)
    }

    /// What the app recorded, or nothing when there is no record.
    fn read_owned(app: &WebApp) -> Owned {
        data_folder(app)
            .and_then(|dir| std::fs::read(dir.join(OWNED)).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn write_owned(app: &WebApp, owned: &Owned) -> Result<(), String> {
        let dir = data_folder(app).ok_or("the app has no data folder")?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_vec(owned).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(OWNED), json).map_err(|e| e.to_string())
    }

    /// Copy the launcher record from an app's old data folder to its new one.
    pub(super) fn carry_record(old: &Path, new: &Path) {
        let _ = std::fs::copy(old.join(OWNED), new.join(OWNED));
    }

    /// The launcher file stem for `app` in `root`: its own name when that is
    /// free or already this app's, else the name with the site's host, else
    /// with a number. `ours(path)` says whether an existing file belongs to
    /// this app.
    #[cfg_attr(
        not(any(target_os = "macos", target_os = "windows", test)),
        allow(dead_code)
    )]
    pub(super) fn free_name(
        root: &Path,
        app: &WebApp,
        ext: &str,
        ours: &dyn Fn(&Path) -> bool,
    ) -> String {
        let base = bundle_name(app);
        // The suffix must survive the 64-character cut, so the name gives way.
        let with = |suffix: &str| {
            let keep = 64usize.saturating_sub(suffix.chars().count() + 1);
            let head: String = base.chars().take(keep).collect();
            safe_name(&format!("{head} {suffix}"))
        };
        let mut candidates = vec![base.clone()];
        let host = url::Url::parse(&app.id)
            .ok()
            .and_then(|u| u.host_str().map(safe_name))
            .filter(|h| !h.is_empty());
        if let Some(host) = host {
            candidates.push(with(&format!("({host})")));
            candidates.extend((2..=9).map(|n| with(&format!("({host} {n})"))));
        }
        let last = with(&stable_id(&app.id));
        for stem in candidates {
            let path = root.join(format!("{stem}.{ext}"));
            if !path.exists() || ours(&path) {
                return stem;
            }
        }
        last
    }

    /// Launcher files recorded for the app that sit directly in `root`.
    /// The record is a file; it is only trusted for paths inside the
    /// launcher folder, so a doctored one cannot aim a delete elsewhere.
    #[cfg_attr(
        not(any(target_os = "macos", target_os = "windows", test)),
        allow(dead_code)
    )]
    fn owned_in(root: &Path, app: &WebApp) -> Vec<PathBuf> {
        read_owned(app)
            .paths
            .into_iter()
            .filter(|p| p.parent() == Some(root))
            .collect()
    }

    /// What a Windows removal may delete: exactly the recorded files; for an
    /// install from before they were recorded, the old name-only pair, but
    /// only when no other installed app shares the name and so may own them.
    #[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
    fn paths_to_remove(root: &Path, app: &WebApp, others: &[WebApp]) -> Vec<PathBuf> {
        let owned = owned_in(root, app);
        if !owned.is_empty() {
            return owned;
        }
        let name = bundle_name(app);
        if others.iter().any(|other| bundle_name(other) == name) {
            tracing::warn!(app = %app.name, "another app shares this name; leaving its shortcut");
            return Vec::new();
        }
        vec![
            root.join(format!("{name}.lnk")),
            root.join(format!("{name}.ico")),
        ]
    }

    /// Characters a launcher's file name may keep besides letters and digits.
    const NAME_PUNCTUATION: &[char] = &[' ', '-', '_', '.', '(', ')', '&', '+', ',', '!'];
    /// Names Windows gives to devices, which no file may take.
    const RESERVED: &[&str] = &[
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
        "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];

    /// `value` as a file name every system accepts and no shell reads as
    /// anything but a name.
    ///
    /// Kept to letters, digits and a little punctuation rather than stripped
    /// of what is known to be dangerous: the name comes from a web page, and
    /// PowerShell alone treats five different characters as a single quote.
    pub(super) fn safe_name(value: &str) -> String {
        let kept: String = value
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || NAME_PUNCTUATION.contains(&c) {
                    c
                } else {
                    ' '
                }
            })
            .collect();
        let flat = kept.split_whitespace().collect::<Vec<_>>().join(" ");
        let cut: String = flat.trim_matches(['.', ' ']).chars().take(64).collect();
        let cut = cut.trim_end_matches(['.', ' ']).to_owned();
        let stem = cut.split('.').next().unwrap_or_default();
        if RESERVED.iter().any(|r| stem.eq_ignore_ascii_case(r)) {
            return format!("{cut} App");
        }
        cut
    }

    /// A filename for the app: its name made safe, or its short name, or
    /// the id's host.
    fn bundle_name(app: &WebApp) -> String {
        let clean = safe_name;
        let name = clean(&app.name);
        if !name.is_empty() {
            return name;
        }
        let short = clean(&app.short_name);
        if !short.is_empty() {
            return short;
        }
        url::Url::parse(&app.id)
            .ok()
            .and_then(|u| u.host_str().map(safe_name))
            .filter(|h| !h.is_empty())
            .unwrap_or_else(|| "Web App".into())
    }

    /// Where launchers live.
    #[cfg(target_os = "macos")]
    fn root() -> Option<PathBuf> {
        std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join("Applications").join("Dive Apps"))
    }

    /// Where launchers live: a folder of the person's own Start Menu, so
    /// installed apps turn up in Search and can be pinned like any other.
    #[cfg(target_os = "windows")]
    fn root() -> Option<PathBuf> {
        std::env::var_os("APPDATA").map(|appdata| {
            PathBuf::from(appdata)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs")
                .join("Dive Apps")
        })
    }

    /// A bundle identifier that is stable for the app and legal for Launch Services.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn bundle_id(app: &WebApp) -> String {
        format!("app.dive.browser.webapp.{}", stable_id(&app.id))
    }

    /// Single-quote a string for `sh`.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn sh_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn xml_escape(value: &str) -> String {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    }

    /// The bundle's Info.plist.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub(super) fn info_plist(app: &WebApp) -> String {
        let name = xml_escape(&bundle_name(app));
        let id = bundle_id(app);
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>{name}</string>
  <key>CFBundleDisplayName</key><string>{name}</string>
  <key>CFBundleIdentifier</key><string>{id}</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
"#
        )
    }

    /// The bundle's executable: hand the app id to Dive.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub(super) fn launch_script(dive_binary: &Path, app: &WebApp) -> String {
        format!(
            "#!/bin/sh\n# Opens the installed web app \"{}\" in Dive.\nexec {} {}\n",
            bundle_name(app).replace('"', ""),
            sh_quote(&dive_binary.to_string_lossy()),
            sh_quote(&format!("--app={}", app.id)),
        )
    }

    /// Whether `bundle` was written for this app: its launch script carries
    /// the app's id as the one quoted argument. No hash is involved, so it
    /// holds for bundles written under any earlier scheme.
    #[cfg(target_os = "macos")]
    fn bundle_is_for(bundle: &Path, app: &WebApp) -> bool {
        std::fs::read_to_string(bundle.join("Contents/MacOS/launch"))
            .is_ok_and(|script| script.contains(&sh_quote(&format!("--app={}", app.id))))
    }

    /// Write the bundle and the record of it: everything but the icon
    /// conversion and the Launch Services call.
    #[cfg(target_os = "macos")]
    fn write_bundle(root: &Path, app: &WebApp, dive: &Path) -> Result<PathBuf, String> {
        use std::os::unix::fs::PermissionsExt as _;
        let stem = free_name(root, app, "app", &|bundle| bundle_is_for(bundle, app));
        let bundle = root.join(format!("{stem}.app"));
        let contents = bundle.join("Contents");
        let macos = contents.join("MacOS");
        let resources = contents.join("Resources");
        std::fs::create_dir_all(&macos).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&resources).map_err(|e| e.to_string())?;
        std::fs::write(contents.join("Info.plist"), info_plist(app)).map_err(|e| e.to_string())?;

        let script = macos.join("launch");
        std::fs::write(&script, launch_script(dive, app)).map_err(|e| e.to_string())?;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
        write_owned(
            app,
            &Owned {
                paths: vec![bundle.clone()],
            },
        )?;
        Ok(bundle)
    }

    #[cfg(target_os = "macos")]
    pub(super) fn install(app: &WebApp) -> Result<Option<PathBuf>, String> {
        let Some(root) = root() else {
            return Ok(None);
        };
        let dive = std::env::current_exe().map_err(|e| e.to_string())?;
        let bundle = write_bundle(&root, app, &dive)?;
        let resources = bundle.join("Contents/Resources");

        // `sips` ships with macOS and turns a square PNG into an icns.
        let icns = resources.join("icon.icns");
        let status = std::process::Command::new("sips")
            .args(["-s", "format", "icns"])
            .arg(&app.icon_path)
            .arg("--out")
            .arg(&icns)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if !status.is_ok_and(|s| s.success()) {
            // Without an icon the bundle still launches; it just looks generic.
            let _ = std::fs::copy(&app.icon_path, resources.join("icon.png"));
        }
        // Tell Launch Services now rather than whenever it next scans.
        let _ = std::process::Command::new(
            "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
        )
        .arg("-f")
        .arg(&bundle)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
        Ok(Some(bundle))
    }

    /// Wrap a PNG as an `.ico` so a shortcut can use it.
    ///
    /// An icon directory may hold a PNG verbatim rather than a bitmap, which
    /// is what every icon since Vista does, so this is a header and the file
    /// -- no decoding, no re-encoding. The size field is a single byte with 0
    /// meaning 256, so anything larger cannot be described honestly here; the
    /// caller falls back to Dive's own icon rather than write a lie the shell
    /// would render as garbage.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    fn png_as_ico(png: &[u8]) -> Option<Vec<u8>> {
        // IHDR is the first chunk: 8 bytes of signature, 8 of chunk header,
        // then width and height as big-endian u32.
        let dimension = |at: usize| -> Option<u32> {
            Some(u32::from_be_bytes(png.get(at..at + 4)?.try_into().ok()?))
        };
        let (width, height) = (dimension(16)?, dimension(20)?);
        if width == 0 || width > 256 || height == 0 || height > 256 {
            return None;
        }
        // 256 does not fit a byte and is written as 0.
        let byte = |v: u32| u8::try_from(v % 256).unwrap_or(0);
        let mut ico = Vec::with_capacity(png.len() + 22);
        ico.extend_from_slice(&[0, 0, 1, 0, 1, 0]); // reserved, type 1 (icon), one image
        ico.extend_from_slice(&[byte(width), byte(height), 0, 0, 1, 0, 32, 0]);
        ico.extend_from_slice(&u32::try_from(png.len()).ok()?.to_le_bytes());
        ico.extend_from_slice(&22u32.to_le_bytes()); // the image follows the header
        ico.extend_from_slice(png);
        Some(ico)
    }

    /// The script that makes a Start Menu shortcut.
    ///
    /// Fixed text. The name, the paths and the app's id come from a web page
    /// or a folder the person named, and quoting them into the script meant
    /// getting PowerShell's quoting right -- which treats ' and the curly
    /// and low quotes as the same character, so doubling only the plain one
    /// left four ways to end the literal and run code. Every value arrives in
    /// an environment variable instead, which PowerShell reads as a string
    /// and never parses.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub(super) const SHORTCUT_SCRIPT: &str = "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:DIVE_SHORTCUT_PATH); $s.TargetPath = $env:DIVE_SHORTCUT_TARGET; $s.Arguments = $env:DIVE_SHORTCUT_ARGUMENTS; $s.IconLocation = $env:DIVE_SHORTCUT_ICON; $s.Description = $env:DIVE_SHORTCUT_DESCRIPTION; $s.Save()";

    /// The values [`SHORTCUT_SCRIPT`] reads, by variable.
    ///
    /// The id goes on Dive's command line as one quoted argument; a quote in
    /// it would split that argument in two, so it is escaped the way a URL
    /// escapes one.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub(super) fn shortcut_env(
        link: &Path,
        target: &Path,
        app: &WebApp,
        icon: &str,
    ) -> Vec<(&'static str, String)> {
        vec![
            ("DIVE_SHORTCUT_PATH", link.display().to_string()),
            ("DIVE_SHORTCUT_TARGET", target.display().to_string()),
            (
                "DIVE_SHORTCUT_ARGUMENTS",
                format!("\"--app={}\"", app.id.replace('"', "%22")),
            ),
            ("DIVE_SHORTCUT_ICON", icon.to_owned()),
            (
                "DIVE_SHORTCUT_DESCRIPTION",
                format!("{} in Dive", bundle_name(app)),
            ),
        ]
    }

    #[cfg(target_os = "windows")]
    pub(super) fn install(app: &WebApp) -> Result<Option<PathBuf>, String> {
        let Some(root) = root() else {
            return Ok(None);
        };
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let dive = std::env::current_exe().map_err(|e| e.to_string())?;
        let owned = read_owned(app);
        let stem = free_name(&root, app, "lnk", &|link| {
            owned.paths.iter().any(|p| p == link)
        });
        let link = root.join(format!("{stem}.lnk"));

        // A shortcut points at an icon file; it cannot carry a PNG. Write one
        // next to the shortcut, and fall back to Dive's own icon -- index 0 of
        // the executable -- when the app's icon cannot be described as an ico.
        let icon = std::fs::read(&app.icon_path)
            .ok()
            .and_then(|png| png_as_ico(&png))
            .and_then(|ico| {
                let path = root.join(format!("{stem}.ico"));
                std::fs::write(&path, ico).ok().map(|()| path)
            });
        let icon_text = icon.as_ref().map_or_else(
            || format!("{},0", dive.display()),
            |path| path.display().to_string(),
        );

        // A .lnk is a COM object's business. Rather than bind IShellLink for
        // one call, ask the shell scripting host that has always made them.
        let status = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", SHORTCUT_SCRIPT])
            .envs(shortcut_env(&link, &dive, app, &icon_text))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!(
                "could not create the Start Menu shortcut ({status})"
            ));
        }
        let mut paths = vec![link.clone()];
        paths.extend(icon);
        write_owned(app, &Owned { paths })?;
        Ok(Some(link))
    }

    #[cfg(target_os = "windows")]
    pub(super) fn remove(app: &WebApp, others: &[WebApp]) -> Result<(), String> {
        let Some(root) = root() else {
            return Ok(());
        };
        // Only what this app owns: see `paths_to_remove`.
        for path in paths_to_remove(&root, app, others) {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    pub(super) fn install(_app: &WebApp) -> Result<Option<PathBuf>, String> {
        Ok(None)
    }

    #[cfg(target_os = "macos")]
    pub(super) fn remove(app: &WebApp, others: &[WebApp]) -> Result<(), String> {
        let Some(root) = root() else {
            return Ok(());
        };
        remove_in(&root, app, others)
    }

    /// Delete the bundles recorded for the app, plus the name-only one an
    /// install from before they were recorded would have made, but only a
    /// bundle whose launch script names this app. A same-named bundle that
    /// belongs to another app, or to the person, stays.
    #[cfg(target_os = "macos")]
    fn remove_in(root: &Path, app: &WebApp, _others: &[WebApp]) -> Result<(), String> {
        let mut bundles = owned_in(root, app);
        bundles.push(root.join(format!("{}.app", bundle_name(app))));
        for bundle in bundles {
            if !bundle_is_for(&bundle, app) {
                continue;
            }
            match std::fs::remove_dir_all(&bundle) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    pub(super) fn remove(_app: &WebApp, _others: &[WebApp]) -> Result<(), String> {
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn a_png_becomes_an_icon_directory_pointing_at_it() {
            // 64x64: signature, IHDR header, then the dimensions.
            let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
            png.extend_from_slice(&[0, 0, 0, 13, b'I', b'H', b'D', b'R']);
            png.extend_from_slice(&64u32.to_be_bytes());
            png.extend_from_slice(&64u32.to_be_bytes());
            let ico = png_as_ico(&png).expect("64px is describable");
            assert_eq!(&ico[..6], &[0, 0, 1, 0, 1, 0]);
            assert_eq!((ico[6], ico[7]), (64, 64));
            // The image is the PNG verbatim, at the offset the header gives.
            let offset = u32::from_le_bytes(ico[18..22].try_into().unwrap()) as usize;
            assert_eq!(offset, 22);
            assert_eq!(&ico[offset..], &png[..]);
        }

        #[test]
        fn two_hundred_and_fifty_six_is_written_as_zero() {
            let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
            png.extend_from_slice(&[0, 0, 0, 13, b'I', b'H', b'D', b'R']);
            png.extend_from_slice(&256u32.to_be_bytes());
            png.extend_from_slice(&256u32.to_be_bytes());
            let ico = png_as_ico(&png).expect("256px is the largest describable");
            assert_eq!((ico[6], ico[7]), (0, 0));
        }

        #[test]
        fn an_icon_too_large_to_describe_is_refused_rather_than_mislabelled() {
            // 512 would have to be written as a byte, and the shell would
            // render whatever that lie decoded to.
            let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
            png.extend_from_slice(&[0, 0, 0, 13, b'I', b'H', b'D', b'R']);
            png.extend_from_slice(&512u32.to_be_bytes());
            png.extend_from_slice(&512u32.to_be_bytes());
            assert!(png_as_ico(&png).is_none());
            // A file too short to hold a header is not an icon either.
            assert!(png_as_ico(&[0x89, b'P', b'N', b'G']).is_none());
        }

        #[test]
        fn the_shortcut_script_carries_no_value_of_its_own() {
            // Every value reaches PowerShell through the environment, so the
            // script is the same text whatever the page called itself.
            assert!(!SHORTCUT_SCRIPT.contains('\''));
            assert!(!SHORTCUT_SCRIPT.contains('"'));
            let hostile = app(
                "x'); Start-Process calc; ('\u{2019}); calc; (\u{2018}\u{201a}\u{201b}",
                "https://x/?q=\"--load-extension=C:\\evil\"",
            );
            let env = shortcut_env(
                Path::new(r"C:\Users\o'brien\Dive Apps\x.lnk"),
                Path::new(r"C:\Program Files\Dive\dive.exe"),
                &hostile,
                "icon.ico",
            );
            let names: Vec<&str> = env.iter().map(|(name, _)| *name).collect();
            for name in &names {
                assert!(SHORTCUT_SCRIPT.contains(&format!("$env:{name}")), "{name}");
            }
            let arguments = &env
                .iter()
                .find(|(n, _)| *n == "DIVE_SHORTCUT_ARGUMENTS")
                .unwrap()
                .1;
            // One argument, whose quotes cannot be closed from inside.
            assert_eq!(arguments.matches('"').count(), 2, "{arguments}");
            assert!(arguments.starts_with("\"--app=") && arguments.ends_with('"'));
        }

        #[test]
        fn a_name_keeps_no_quote_of_any_kind() {
            let named =
                safe_name("Tom's \u{2018}Mail\u{2019} \u{201a}x\u{201b} \"y\" `z` $(calc); <a>|b");
            for c in [
                '\'', '\u{2018}', '\u{2019}', '\u{201a}', '\u{201b}', '"', '`', '$', ';', '<', '>',
                '|',
            ] {
                assert!(!named.contains(c), "{c:?} survived in {named:?}");
            }
            assert_eq!(named, "Tom s Mail x y z (calc) a b");
            // Names Windows keeps for devices, and names that are all dots,
            // do not become files.
            assert_eq!(safe_name("CON"), "CON App");
            assert_eq!(safe_name("nul.txt"), "nul.txt App");
            assert_eq!(safe_name(".."), "");
            assert_eq!(safe_name(&"a".repeat(200)).len(), 64);
            // Letters other than English ones are names like any other.
            assert_eq!(safe_name("メール"), "メール");
        }

        fn app(name: &str, id: &str) -> WebApp {
            WebApp {
                id: id.into(),
                name: name.into(),
                short_name: "S".into(),
                start_url: id.into(),
                scope: id.into(),
                display: "standalone".into(),
                theme_color: None,
                background_color: None,
                icon_path: "/tmp/i.png".into(),
                manifest_url: id.into(),
                created_at: String::new(),
                last_opened_at: None,
                bounds: String::new(),
                workspace_id: None,
            }
        }

        fn temp(tag: &str) -> PathBuf {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("dive-webapp-{tag}-{nanos}"));
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        /// An app whose icon, and so launcher record, lives in `data`.
        fn app_in(data: &Path, name: &str, id: &str) -> WebApp {
            let mut a = app(name, id);
            a.icon_path = data.join("icon.png").to_string_lossy().into_owned();
            a
        }

        #[test]
        fn stable_id_is_sha256_and_the_same_every_build() {
            assert_eq!(stable_id("https://x/"), "4b7efacc825af67f");
        }

        #[test]
        fn two_apps_with_the_same_name_get_two_launchers() {
            let root = temp("names");
            std::fs::create_dir_all(root.join("Mail.app")).unwrap();
            let b = app("Mail", "https://b.example/");
            assert_eq!(free_name(&root, &b, "app", &|_| false), "Mail (b.example)");
            std::fs::create_dir_all(root.join("Mail (b.example).app")).unwrap();
            assert_eq!(
                free_name(&root, &b, "app", &|_| false),
                "Mail (b.example 2)"
            );
            let _ = std::fs::remove_dir_all(&root);
        }

        #[test]
        fn a_long_name_keeps_its_disambiguator() {
            let root = temp("long");
            let long = "N".repeat(100);
            std::fs::create_dir_all(root.join(format!("{}.app", "N".repeat(64)))).unwrap();
            let stem = free_name(&root, &app(&long, "https://b.example/"), "app", &|_| false);
            assert!(
                stem.ends_with("(b.example)") && stem.chars().count() <= 64,
                "{stem}"
            );
            let _ = std::fs::remove_dir_all(&root);
        }

        #[test]
        fn reinstalling_an_app_reuses_its_own_launcher() {
            let root = temp("reuse");
            std::fs::create_dir_all(root.join("Mail.app")).unwrap();
            let a = app("Mail", "https://a.example/");
            assert_eq!(free_name(&root, &a, "app", &|_| true), "Mail");
            let _ = std::fs::remove_dir_all(&root);
        }

        #[test]
        fn a_legacy_windows_shortcut_shared_by_name_is_kept() {
            let root = temp("legacy");
            let data = temp("legacy-data");
            let a = app_in(&data, "Mail", "https://a.example/");
            let data_b = temp("legacy-data-b");
            let b = app_in(&data_b, "Mail", "https://b.example/");
            // No record: the name-only pair goes only if nobody else could own it.
            assert!(paths_to_remove(&root, &a, std::slice::from_ref(&b)).is_empty());
            assert_eq!(paths_to_remove(&root, &a, &[]).len(), 2);
            // A record names exactly its files, and nothing outside the folder.
            write_owned(
                &a,
                &Owned {
                    paths: vec![
                        root.join("Mail (a.example).lnk"),
                        PathBuf::from("/etc/passwd"),
                    ],
                },
            )
            .unwrap();
            assert_eq!(
                paths_to_remove(&root, &a, std::slice::from_ref(&b)),
                vec![root.join("Mail (a.example).lnk")]
            );
            let _ = std::fs::remove_dir_all(&root);
            let _ = std::fs::remove_dir_all(&data);
            let _ = std::fs::remove_dir_all(&data_b);
        }

        #[cfg(target_os = "macos")]
        #[test]
        fn removing_one_app_leaves_a_same_named_bundle_alone() {
            let root = temp("mac");
            let (data_a, data_b) = (temp("mac-a"), temp("mac-b"));
            let a = app_in(&data_a, "Mail", "https://a.example/");
            let b = app_in(&data_b, "Mail", "https://b.example/");
            let dive = Path::new("/Applications/Dive.app/Contents/MacOS/dive");
            let bundle_a = write_bundle(&root, &a, dive).unwrap();
            let bundle_b = write_bundle(&root, &b, dive).unwrap();
            assert_ne!(bundle_a, bundle_b);
            // Installing A again lands on A's own bundle.
            assert_eq!(write_bundle(&root, &a, dive).unwrap(), bundle_a);
            remove_in(&root, &a, std::slice::from_ref(&b)).unwrap();
            assert!(!bundle_a.exists());
            assert!(bundle_b.exists());
            let _ = std::fs::remove_dir_all(&root);
            let _ = std::fs::remove_dir_all(&data_a);
            let _ = std::fs::remove_dir_all(&data_b);
        }

        #[cfg(target_os = "macos")]
        #[test]
        fn a_bundle_dive_did_not_write_is_not_removed() {
            let root = temp("mac-foreign");
            let macos = root.join("Mail.app/Contents/MacOS");
            std::fs::create_dir_all(&macos).unwrap();
            std::fs::write(
                macos.join("launch"),
                launch_script(Path::new("/dive"), &app("Mail", "https://other.example/")),
            )
            .unwrap();
            let data = temp("mac-foreign-a");
            let a = app_in(&data, "Mail", "https://a.example/");
            remove_in(&root, &a, &[]).unwrap();
            assert!(root.join("Mail.app").exists());
            let _ = std::fs::remove_dir_all(&root);
            let _ = std::fs::remove_dir_all(&data);
        }

        #[test]
        fn bundle_name_is_a_safe_filename() {
            assert_eq!(
                bundle_name(&app("Mail / Work: v2", "https://x/")),
                "Mail Work v2"
            );
            assert_eq!(bundle_name(&app("   ", "https://mail.example/app")), "S");
            let mut a = app("", "https://mail.example/app");
            a.short_name = String::new();
            assert_eq!(bundle_name(&a), "mail.example");
        }

        #[test]
        fn launch_script_quotes_for_sh() {
            let s = launch_script(
                Path::new("/Applications/Dive's.app/Contents/MacOS/dive"),
                &app("A", "https://x/?q='1'"),
            );
            assert!(s.starts_with("#!/bin/sh\n"));
            assert!(s.contains(r"exec '/Applications/Dive'\''s.app/Contents/MacOS/dive' '--app=https://x/?q='\''1'\'''"));
        }

        #[test]
        fn plist_escapes_the_name_and_is_stable_per_id() {
            let a = app("Tom & <Jerry>", "https://x/");
            let plist = info_plist(&a);
            // The brackets never reach the name; the ampersand is escaped.
            assert!(plist.contains("<string>Tom &amp; Jerry</string>"));
            assert!(plist.contains("<key>CFBundleExecutable</key><string>launch</string>"));
            assert_eq!(bundle_id(&a), bundle_id(&app("Renamed", "https://x/")));
            assert_ne!(
                bundle_id(&a),
                bundle_id(&app("Tom & <Jerry>", "https://y/"))
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_deserializes_the_not_installable_shape() {
        let probe: WebAppProbe =
            serde_json::from_value(json!({ "installable": false, "reason": "no manifest" }))
                .unwrap();
        assert!(!probe.installable);
        assert_eq!(probe.reason.as_deref(), Some("no manifest"));
        assert!(probe.name.is_none());
    }

    fn installable(start: &str, scope: &str) -> WebAppProbe {
        WebAppProbe {
            installable: true,
            reason: None,
            id: Some(start.into()),
            name: Some("Mail".into()),
            short_name: Some("Mail".into()),
            start_url: Some(start.into()),
            scope: Some(scope.into()),
            display: Some("standalone".into()),
            theme_color: Some("#112233".into()),
            background_color: Some("rgb(1, 2, 3)".into()),
            icon_url: Some("https://cdn.example.net/icon.png".into()),
            icon_size: Some(512),
            manifest_url: Some("https://mail.example.com/manifest.json".into()),
            description: None,
            installed: None,
        }
    }

    #[test]
    fn an_app_of_the_tab_s_own_site_installs() {
        let probe = checked(
            installable("https://mail.example.com/app/", "https://mail.example.com/"),
            "https://mail.example.com/inbox",
        );
        assert!(probe.installable, "{:?}", probe.reason);
        // A subdomain is the same site.
        let probe = checked(
            installable("https://app.example.com/", "https://app.example.com/"),
            "https://example.com/",
        );
        assert!(probe.installable, "{:?}", probe.reason);
        // A dev server on this machine may be plain http.
        let probe = checked(
            installable("http://localhost:5173/", "http://localhost:5173/"),
            "http://localhost:5173/",
        );
        assert!(probe.installable, "{:?}", probe.reason);
    }

    #[test]
    fn a_page_cannot_install_an_app_that_opens_somewhere_else() {
        let tab = "https://mail.example.com/inbox";
        for (start, scope) in [
            ("file:///etc/passwd", "file:///"),
            ("dive://settings", "dive://"),
            ("data:text/html,hi", "data:text/html,"),
            ("https://bank.example.org/", "https://bank.example.org/"),
            ("http://mail.example.com/", "http://mail.example.com/"),
            (
                "https://user:pw@mail.example.com/",
                "https://user:pw@mail.example.com/",
            ),
        ] {
            let probe = checked(installable(start, scope), tab);
            assert!(!probe.installable, "{start} was installable");
            assert!(probe.reason.is_some());
        }
        // A start URL outside its scope, and an id on another origin.
        let probe = checked(
            installable(
                "https://mail.example.com/app/",
                "https://mail.example.com/other/",
            ),
            tab,
        );
        assert!(!probe.installable);
        let mut foreign_id = installable("https://mail.example.com/", "https://mail.example.com/");
        foreign_id.id = Some("https://other.example.com/".into());
        assert!(!checked(foreign_id, tab).installable);
        // An icon that is not a web address or an image.
        let mut icon = installable("https://mail.example.com/", "https://mail.example.com/");
        icon.icon_url = Some("file:///Users/me/.ssh/id_ed25519".into());
        assert!(!checked(icon, tab).installable);
        // A page that is not on the web cannot install anything.
        assert!(
            !checked(
                installable("https://mail.example.com/", "https://mail.example.com/"),
                "file:///tmp/x.html"
            )
            .installable
        );
    }

    #[test]
    fn the_rest_of_the_report_is_held_to_plain_values() {
        let mut probe = installable("https://mail.example.com/", "https://mail.example.com/");
        probe.name = Some("Mail\n\u{0007}  for  you".into());
        probe.display = Some("javascript".into());
        probe.theme_color = Some("red; background: url(https://evil/)".into());
        let probe = checked(probe, "https://mail.example.com/");
        assert!(probe.installable);
        assert_eq!(probe.name.as_deref(), Some("Mail for you"));
        assert_eq!(probe.display.as_deref(), Some("standalone"));
        assert_eq!(probe.theme_color, None);
        assert_eq!(probe.background_color.as_deref(), Some("rgb(1, 2, 3)"));
    }

    #[test]
    fn app_dir_is_a_hash_not_the_url() {
        let dir = app_dir("https://example.com/app?x=1/../..");
        let leaf = dir.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(leaf.len(), 16);
        assert!(leaf.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(dir, app_dir("https://example.com/app?x=1/../.."));
    }
}
