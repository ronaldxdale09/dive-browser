//! Validation, persistence, and startup loading for unpacked Chromium extensions.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use tauri::AppHandle;

use crate::Runtime;
use crate::error::{AppError, AppResult};

const REGISTRY_VERSION: u8 = 1;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
static STARTED_PATHS: OnceLock<Vec<String>> = OnceLock::new();

/// One locally installed unpacked extension.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ExtensionInfo {
    /// Stable Dive identifier derived from the canonical source path.
    pub id: String,
    /// Display name declared by the manifest.
    pub name: String,
    /// Extension version declared by the manifest.
    pub version: String,
    /// Chromium manifest generation (2 or 3).
    pub manifest_version: u8,
    /// Canonical local source directory.
    pub path: String,
    /// Whether Dive asks Chromium to load this extension at startup.
    pub enabled: bool,
    /// Requested API and host permissions.
    pub permissions: Vec<String>,
    /// Compatibility or security facts the user should see.
    pub warnings: Vec<String>,
}

/// Extension page data plus whether current settings need a restart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ExtensionList {
    /// Installed extensions.
    pub items: Vec<ExtensionInfo>,
    /// True when enabled paths differ from what this process started with.
    pub restart_required: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Registry {
    version: u8,
    items: Vec<ExtensionInfo>,
}

fn registry_path() -> PathBuf {
    crate::state::data_root().join("extensions.json")
}

fn read_registry(path: &Path) -> AppResult<Registry> {
    if !path.exists() {
        return Ok(Registry {
            version: REGISTRY_VERSION,
            items: Vec::new(),
        });
    }
    let bytes = fs::read(path).map_err(AppError::new)?;
    let registry: Registry = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::new(format!("invalid extension registry: {e}")))?;
    if registry.version != REGISTRY_VERSION {
        return Err(AppError::new(format!(
            "unsupported extension registry version {}",
            registry.version
        )));
    }
    Ok(registry)
}

fn write_registry(path: &Path, registry: &Registry) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("extension registry has no parent directory"))?;
    fs::create_dir_all(parent).map_err(AppError::new)?;
    let tmp = parent.join("extensions.json.tmp");
    let bytes = serde_json::to_vec_pretty(registry).map_err(AppError::new)?;
    fs::write(&tmp, bytes).map_err(AppError::new)?;
    fs::rename(&tmp, path).map_err(AppError::new)
}

fn string_field(value: &serde_json::Value, field: &str) -> AppResult<String> {
    value[field]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| AppError::new(format!("manifest {field} must be a non-empty string")))
}

fn manifest_paths_are_safe(root: &Path, value: &serde_json::Value) -> bool {
    let mut candidates: Vec<String> = Vec::new();
    for pointer in [
        "/background/service_worker",
        "/background/page",
        "/action/default_popup",
        "/browser_action/default_popup",
        "/page_action/default_popup",
        "/options_page",
        "/options_ui/page",
        "/devtools_page",
        "/side_panel/default_path",
    ] {
        if let Some(path) = value.pointer(pointer).and_then(serde_json::Value::as_str) {
            candidates.push(path.to_owned());
        }
    }
    for pointer in ["/background/scripts", "/sandbox/pages"] {
        candidates.extend(string_array(value.pointer(pointer)));
    }
    for pointer in ["/icons", "/chrome_url_overrides"] {
        if let Some(paths) = value
            .pointer(pointer)
            .and_then(serde_json::Value::as_object)
        {
            candidates.extend(
                paths
                    .values()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_owned),
            );
        }
    }
    for pointer in [
        "/action/default_icon",
        "/browser_action/default_icon",
        "/page_action/default_icon",
    ] {
        if let Some(icon) = value.pointer(pointer) {
            if let Some(path) = icon.as_str() {
                candidates.push(path.to_owned());
            } else if let Some(paths) = icon.as_object() {
                candidates.extend(
                    paths
                        .values()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_owned),
                );
            }
        }
    }
    if let Some(scripts) = value
        .get("content_scripts")
        .and_then(serde_json::Value::as_array)
    {
        for script in scripts {
            candidates.extend(string_array(script.get("js")));
            candidates.extend(string_array(script.get("css")));
        }
    }
    if let Some(resources) = value
        .get("web_accessible_resources")
        .and_then(serde_json::Value::as_array)
    {
        for entry in resources {
            if let Some(path) = entry.as_str() {
                candidates.push(path.to_owned());
            } else {
                candidates.extend(string_array(entry.get("resources")));
            }
        }
    }
    candidates
        .iter()
        .all(|path| resource_path_is_safe(root, path))
}

fn safe_relative_path(candidate: &str) -> bool {
    let path = Path::new(candidate);
    !path.is_absolute()
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_) | Component::CurDir))
}

fn resource_path_is_safe(root: &Path, candidate: &str) -> bool {
    if !safe_relative_path(candidate) {
        return false;
    }
    let joined = root.join(candidate);
    // Wildcards and resources generated later cannot be canonicalized. For a
    // path that exists now, canonicalization additionally prevents symlinks
    // from escaping the selected extension directory.
    !joined.exists()
        || joined
            .canonicalize()
            .is_ok_and(|canonical| canonical.starts_with(root))
}

fn string_array(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn validate(directory: &Path) -> AppResult<ExtensionInfo> {
    let root = directory
        .canonicalize()
        .map_err(|e| AppError::new(format!("cannot open extension directory: {e}")))?;
    if !root.is_dir() {
        return Err(AppError::new("extension path must be a directory"));
    }
    let manifest_path = root.join("manifest.json");
    let metadata = fs::metadata(&manifest_path)
        .map_err(|_| AppError::new("extension directory has no manifest.json"))?;
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err(AppError::new("extension manifest is larger than 1 MiB"));
    }
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).map_err(AppError::new)?)
            .map_err(|e| AppError::new(format!("invalid extension manifest: {e}")))?;
    let generation = manifest["manifest_version"]
        .as_u64()
        .and_then(|v| u8::try_from(v).ok())
        .filter(|v| matches!(v, 2 | 3))
        .ok_or_else(|| {
            AppError::new("only Chromium Manifest V2 and V3 extensions are supported")
        })?;
    if !manifest_paths_are_safe(&root, &manifest) {
        return Err(AppError::new(
            "extension manifest contains a path outside its directory",
        ));
    }

    let mut permissions = BTreeSet::new();
    permissions.extend(string_array(manifest.get("permissions")));
    permissions.extend(string_array(manifest.get("host_permissions")));
    let mut warnings = Vec::new();
    if generation == 2 {
        warnings.push(
            "Manifest V2 is deprecated by Chromium and may have limited compatibility.".to_owned(),
        );
    }
    if manifest.get("oauth2").is_some() {
        warnings.push("OAuth integrations may depend on Google Chrome services unavailable in embedded Chromium.".to_owned());
    }
    if permissions.contains("webRequestBlocking") && generation == 3 {
        warnings.push("Manifest V3 limits blocking webRequest behavior.".to_owned());
    }

    let canonical = root.to_string_lossy().into_owned();
    let digest = Sha256::digest(canonical.as_bytes());
    Ok(ExtensionInfo {
        id: format!("{digest:x}")[..32].to_owned(),
        name: string_field(&manifest, "name")?,
        version: string_field(&manifest, "version")?,
        manifest_version: generation,
        path: canonical,
        enabled: true,
        permissions: permissions.into_iter().collect(),
        warnings,
    })
}

fn enabled_paths_from(registry: &Registry) -> Vec<String> {
    let mut paths: Vec<_> = registry
        .items
        .iter()
        .filter(|item| item.enabled)
        .map(|item| item.path.clone())
        .collect();
    paths.sort();
    paths.dedup();
    paths
}

/// Enabled, currently valid extension paths used to construct Chromium startup arguments.
pub fn startup_paths() -> Vec<String> {
    let Ok(registry) = read_registry(&registry_path()) else {
        return Vec::new();
    };
    enabled_paths_from(&registry)
        .into_iter()
        .filter(|path| validate(Path::new(path)).is_ok())
        .collect()
}

/// Record the exact extensions passed to this process.
pub fn mark_started(paths: &[String]) {
    let _ = STARTED_PATHS.set(paths.to_vec());
}

fn list_at(path: &Path) -> AppResult<ExtensionList> {
    let registry = read_registry(path)?;
    let enabled = enabled_paths_from(&registry);
    let started = STARTED_PATHS
        .get()
        .cloned()
        .unwrap_or_else(|| enabled.clone());
    Ok(ExtensionList {
        items: registry.items,
        restart_required: enabled != started,
    })
}

/// List installed extensions.
#[tauri::command]
#[specta::specta]
pub fn extensions_list() -> AppResult<ExtensionList> {
    list_at(&registry_path())
}

/// Ask the operating system for an unpacked extension directory.
#[tauri::command]
#[specta::specta]
pub async fn extension_pick() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Load unpacked Chromium extension")
        .pick_folder()
        .await
        .map(|folder| folder.path().to_string_lossy().into_owned())
}

/// Validate and register an unpacked extension directory.
#[tauri::command]
#[specta::specta]
pub fn extension_import(path: String) -> AppResult<ExtensionList> {
    let mut registry = read_registry(&registry_path())?;
    let path = PathBuf::from(path);
    let mut item = validate(&path)?;
    if let Some(existing) = registry
        .items
        .iter()
        .find(|existing| existing.id == item.id)
    {
        item.enabled = existing.enabled;
    }
    registry.items.retain(|existing| existing.id != item.id);
    registry.items.push(item);
    registry.items.sort_by_key(|item| item.name.to_lowercase());
    write_registry(&registry_path(), &registry)?;
    list_at(&registry_path())
}

/// Enable or disable an installed extension for the next launch.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Owned command payload is the Tauri IPC boundary.
pub fn extension_set_enabled(id: String, enabled: bool) -> AppResult<ExtensionList> {
    let mut registry = read_registry(&registry_path())?;
    let item = registry
        .items
        .iter_mut()
        .find(|item| item.id == id)
        .ok_or_else(|| AppError::new("extension not found"))?;
    item.enabled = enabled;
    write_registry(&registry_path(), &registry)?;
    list_at(&registry_path())
}

/// Forget an extension without deleting its source directory.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Owned command payload is the Tauri IPC boundary.
pub fn extension_remove(id: String) -> AppResult<ExtensionList> {
    let mut registry = read_registry(&registry_path())?;
    let before = registry.items.len();
    registry.items.retain(|item| item.id != id);
    if registry.items.len() == before {
        return Err(AppError::new("extension not found"));
    }
    write_registry(&registry_path(), &registry)?;
    list_at(&registry_path())
}

/// Restart Dive so pending browser changes can take effect safely.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri injects AppHandle by value for commands.
pub fn app_restart(app: AppHandle<Runtime>) {
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("dive-extension-{name}-{id}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn fixture(manifest: &str) -> PathBuf {
        let root = temp_dir("fixture");
        fs::write(root.join("manifest.json"), manifest).unwrap();
        root
    }

    #[test]
    fn accepts_manifest_v3_and_collects_permissions() {
        let root = fixture(
            r#"{"manifest_version":3,"name":"Fixture","version":"1.2.3","permissions":["storage"],"host_permissions":["https://example.com/*"],"background":{"service_worker":"worker.js"}}"#,
        );
        let item = validate(&root).unwrap();
        assert_eq!(item.name, "Fixture");
        assert_eq!(item.manifest_version, 3);
        assert_eq!(item.permissions, vec!["https://example.com/*", "storage"]);
        assert!(item.enabled);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_manifest_paths_that_escape_the_extension() {
        let root = fixture(
            r#"{"manifest_version":3,"name":"Bad","version":"1","background":{"service_worker":"../outside.js"}}"#,
        );
        assert!(validate(&root).unwrap_err().to_string().contains("outside"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_content_script_paths_that_escape_the_extension() {
        let root = fixture(
            r#"{"manifest_version":3,"name":"Bad","version":"1","content_scripts":[{"matches":["https://example.com/*"],"js":["../outside.js"]}]}"#,
        );
        assert!(validate(&root).unwrap_err().to_string().contains("outside"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_unknown_manifest_generations_and_missing_names() {
        let unknown = fixture(r#"{"manifest_version":4,"name":"Future","version":"1"}"#);
        assert!(validate(&unknown).is_err());
        let unnamed = fixture(r#"{"manifest_version":3,"version":"1"}"#);
        assert!(validate(&unnamed).is_err());
        fs::remove_dir_all(unknown).unwrap();
        fs::remove_dir_all(unnamed).unwrap();
    }

    #[test]
    fn registry_round_trip_is_atomic_and_paths_are_deterministic() {
        let root = temp_dir("registry");
        let path = root.join("extensions.json");
        let registry = Registry {
            version: REGISTRY_VERSION,
            items: vec![
                ExtensionInfo {
                    id: "b".into(),
                    name: "B".into(),
                    version: "1".into(),
                    manifest_version: 3,
                    path: "/z".into(),
                    enabled: true,
                    permissions: vec![],
                    warnings: vec![],
                },
                ExtensionInfo {
                    id: "a".into(),
                    name: "A".into(),
                    version: "1".into(),
                    manifest_version: 3,
                    path: "/a".into(),
                    enabled: true,
                    permissions: vec![],
                    warnings: vec![],
                },
            ],
        };
        write_registry(&path, &registry).unwrap();
        assert_eq!(read_registry(&path).unwrap().items, registry.items);
        assert_eq!(enabled_paths_from(&registry), vec!["/a", "/z"]);
        assert!(!root.join("extensions.json.tmp").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
