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
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
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

async fn evaluate(session: &dive_cdp::CdpSession, script: String) -> AppResult<Value> {
    let result = session
        .call(
            "Runtime.evaluate",
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
    let mut probe: WebAppProbe = serde_json::from_value(value)
        .map_err(|e| AppError::new(format!("manifest probe returned an odd shape: {e}")))?;
    if let Some(app_id) = probe.id.as_deref() {
        probe.installed = lock(&state.store).web_app(app_id)?;
    }
    Ok(probe)
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

/// Where an app's files live: a directory named by a hash of its id, so any
/// id — they are URLs — is a safe path.
fn app_dir(id: &str) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    id.hash(&mut hasher);
    state::data_root()
        .join("webapps")
        .join(format!("{:016x}", hasher.finish()))
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
async fn icon_from_network(icon_url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(icon_url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("icon {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|n| usize::try_from(n).map_or(true, |n| n > MAX_ICON_BYTES))
    {
        return Err("icon too large".into());
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_ICON_BYTES {
        return Err("icon too large".into());
    }
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
        bounds: WindowBounds::parse(&app.bounds),
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
    let png = match icon_from_page(&session, &icon_url).await {
        Ok(png) => png,
        Err(in_page) => icon_from_network(&icon_url).await.map_err(|network| {
            AppError::new(format!(
                "could not fetch the app icon: {in_page}; {network}"
            ))
        })?,
    };
    let dir = app_dir(&app_id);
    let icon_path = write_icon(&dir, &png)?;

    let existing = lock(&state.store).web_app(&app_id)?;
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
/// start URL in the active workspace and tear that tab into an app window.
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
    let workspace = (*lock(&state.active_workspace))
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
    let record = {
        let state = app.state::<AppState>();
        let record = lock(&state.store).web_app(&app_id)?;
        let Some(record) = record else {
            return Ok(());
        };
        let open_tab = lock(&state.host)
            .as_ref()
            .and_then(|h| h.tab_for_app(&app_id));
        if let Some(tab) = open_tab {
            crate::commands::tab_attach(app.clone(), tab)?;
        }
        lock(&state.store).remove_web_app(&app_id)?;
        record
    };
    if let Err(e) = launcher::remove(&record) {
        tracing::warn!(app = %record.name, "could not remove the app launcher: {e}");
    }
    let dir = app_dir(&record.id);
    if let Err(e) = std::fs::remove_dir_all(&dir)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(path = %dir.display(), "could not remove the app's files: {e}");
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
    use super::{DefaultHasher, Hash, Hasher, Path, PathBuf, WebApp};

    /// A filename for the app: its name with path separators and control
    /// characters removed, or its short name, or the id's host.
    fn bundle_name(app: &WebApp) -> String {
        let clean = |s: &str| {
            s.chars()
                .filter(|c| !matches!(c, '/' | ':' | '\\' | '\0') && !c.is_control())
                .collect::<String>()
                .trim()
                .to_owned()
        };
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
            .and_then(|u| u.host_str().map(str::to_owned))
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
        let mut hasher = DefaultHasher::new();
        app.id.hash(&mut hasher);
        format!("app.dive.browser.webapp.{:016x}", hasher.finish())
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

    #[cfg(target_os = "macos")]
    pub(super) fn install(app: &WebApp) -> Result<Option<PathBuf>, String> {
        use std::os::unix::fs::PermissionsExt as _;
        let Some(root) = root() else {
            return Ok(None);
        };
        let bundle = root.join(format!("{}.app", bundle_name(app)));
        let contents = bundle.join("Contents");
        let macos = contents.join("MacOS");
        let resources = contents.join("Resources");
        std::fs::create_dir_all(&macos).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&resources).map_err(|e| e.to_string())?;
        std::fs::write(contents.join("Info.plist"), info_plist(app)).map_err(|e| e.to_string())?;

        let dive = std::env::current_exe().map_err(|e| e.to_string())?;
        let script = macos.join("launch");
        std::fs::write(&script, launch_script(&dive, app)).map_err(|e| e.to_string())?;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;

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

    /// Quote a string for a single-quoted PowerShell literal.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    fn ps_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "''"))
    }

    #[cfg(target_os = "windows")]
    pub(super) fn install(app: &WebApp) -> Result<Option<PathBuf>, String> {
        let Some(root) = root() else {
            return Ok(None);
        };
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let dive = std::env::current_exe().map_err(|e| e.to_string())?;
        let link = root.join(format!("{}.lnk", bundle_name(app)));

        // A shortcut points at an icon file; it cannot carry a PNG. Write one
        // next to the shortcut, and fall back to Dive's own icon -- index 0 of
        // the executable -- when the app's icon cannot be described as an ico.
        let icon = std::fs::read(&app.icon_path)
            .ok()
            .and_then(|png| png_as_ico(&png))
            .and_then(|ico| {
                let path = root.join(format!("{}.ico", bundle_name(app)));
                std::fs::write(&path, ico).ok().map(|()| path)
            })
            .map_or_else(
                || format!("{},0", dive.display()),
                |path| path.display().to_string(),
            );

        // A .lnk is a COM object's business. Rather than bind IShellLink for
        // one call, ask the shell scripting host that has always made them.
        let script = format!(
            "$s = (New-Object -ComObject WScript.Shell).CreateShortcut({link});\
             $s.TargetPath = {target};\
             $s.Arguments = {args};\
             $s.IconLocation = {icon};\
             $s.Description = {description};\
             $s.Save()",
            link = ps_quote(&link.display().to_string()),
            target = ps_quote(&dive.display().to_string()),
            args = ps_quote(&format!("--app={}", app.id)),
            icon = ps_quote(&icon),
            description = ps_quote(&format!("{} in Dive", bundle_name(app))),
        );
        let status = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!(
                "could not create the Start Menu shortcut ({status})"
            ));
        }
        Ok(Some(link))
    }

    #[cfg(target_os = "windows")]
    pub(super) fn remove(app: &WebApp) -> Result<(), String> {
        let Some(root) = root() else {
            return Ok(());
        };
        // Only what Dive wrote: the folder is Dive's own, and the names come
        // from the app being removed.
        for path in [
            root.join(format!("{}.lnk", bundle_name(app))),
            root.join(format!("{}.ico", bundle_name(app))),
        ] {
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
    pub(super) fn remove(app: &WebApp) -> Result<(), String> {
        let Some(root) = root() else {
            return Ok(());
        };
        let bundle = root.join(format!("{}.app", bundle_name(app)));
        // Only a bundle Dive wrote is removed: the identifier says so.
        let plist = std::fs::read_to_string(bundle.join("Contents/Info.plist")).unwrap_or_default();
        if !plist.contains(&bundle_id(app)) {
            return Ok(());
        }
        match std::fs::remove_dir_all(&bundle) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    pub(super) fn remove(_app: &WebApp) -> Result<(), String> {
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
        fn a_quote_in_a_path_cannot_end_the_powershell_literal() {
            assert_eq!(
                ps_quote(r"C:\Users\o'brien\App.lnk"),
                r"'C:\Users\o''brien\App.lnk'"
            );
            assert_eq!(ps_quote("plain"), "'plain'");
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
            }
        }

        #[test]
        fn bundle_name_is_a_safe_filename() {
            assert_eq!(
                bundle_name(&app("Mail / Work: v2", "https://x/")),
                "Mail  Work v2"
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
            assert!(plist.contains("<string>Tom &amp; &lt;Jerry&gt;</string>"));
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

    #[test]
    fn app_dir_is_a_hash_not_the_url() {
        let dir = app_dir("https://example.com/app?x=1/../..");
        let leaf = dir.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(leaf.len(), 16);
        assert!(leaf.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(dir, app_dir("https://example.com/app?x=1/../.."));
    }
}
