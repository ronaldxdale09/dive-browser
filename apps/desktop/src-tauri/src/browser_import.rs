//! Bring bookmarks and history in from the browsers already on this Mac.
//!
//! Every browser keeps its data under `~/Library`: the Chromium family
//! (Chrome, Brave, Edge, Arc, Vivaldi, Opera, Chromium) in a profile folder
//! with a `Bookmarks` JSON file and a `History` SQLite database, Firefox in
//! `places.sqlite`, Safari in `Bookmarks.plist` and `History.db`. Only
//! bookmarks and history are read: passwords and cookies live in each
//! browser's keychain-encrypted stores and stay there.
//!
//! macOS protects some of those folders. Reading one without consent fails
//! with "Operation not permitted", so a source reports its `access` and the
//! chrome offers two ways in: a folder picker at the profile (choosing it in
//! the system panel is consent for that folder) or Full Disk Access.
//!
//! A live browser holds its databases open, so each one is copied to a
//! temporary folder before it is read.

use crate::error::{AppError, AppResult};
use dive_core::{ImportedEntry, Timestamp};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Which family a browser belongs to, which decides the files and formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Family {
    Chromium,
    Firefox,
    Safari,
}

/// Whether the profile folder can be read right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    /// Files open; the import can run.
    Ok,
    /// macOS refused ("Operation not permitted"); the person has to allow it.
    Denied,
    /// The folder exists but holds neither bookmarks nor history.
    Empty,
}

/// One browser profile the import can read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct ImportSource {
    /// `browser:profile-folder`, stable across calls.
    pub id: String,
    /// `chrome`, `brave`, `edge`, `arc`, `vivaldi`, `opera`, `chromium`, `firefox`, `safari`.
    pub browser: String,
    /// Display name of the browser.
    pub name: String,
    pub family: Family,
    /// The profile's own name when the browser has several; `None` for the only one.
    pub profile: Option<String>,
    /// Folder the files are read from.
    pub dir: String,
    pub access: Access,
    /// The browser's own icon from its app bundle, as a PNG data URL; `None`
    /// when the app itself is not installed (its data can outlive it).
    pub icon: Option<String>,
}

/// What an import brought in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
pub struct ImportSummary {
    pub bookmarks: u32,
    pub history: u32,
}

/// Bookmarks and visits read from one source, before they reach the store.
#[derive(Debug, Default)]
pub struct Harvest {
    pub bookmarks: Vec<ImportedEntry>,
    pub history: Vec<ImportedEntry>,
}

/// Visits beyond this are left behind; nobody scrolls that far back.
const HISTORY_LIMIT: usize = 100_000;

struct Known {
    browser: &'static str,
    name: &'static str,
    /// The app bundle's name under /Applications, for its icon.
    app: &'static str,
    family: Family,
    /// Relative to `~/Library/Application Support`, or `~/Library` for Safari.
    dir: &'static str,
    /// Chromium browsers that keep their one profile in the root (Opera).
    flat: bool,
}

const KNOWN: &[Known] = &[
    Known {
        browser: "chrome",
        app: "Google Chrome",
        name: "Chrome",
        family: Family::Chromium,
        dir: "Google/Chrome",
        flat: false,
    },
    Known {
        browser: "brave",
        app: "Brave Browser",
        name: "Brave",
        family: Family::Chromium,
        dir: "BraveSoftware/Brave-Browser",
        flat: false,
    },
    Known {
        browser: "edge",
        app: "Microsoft Edge",
        name: "Microsoft Edge",
        family: Family::Chromium,
        dir: "Microsoft Edge",
        flat: false,
    },
    Known {
        browser: "arc",
        app: "Arc",
        name: "Arc",
        family: Family::Chromium,
        dir: "Arc/User Data",
        flat: false,
    },
    Known {
        browser: "vivaldi",
        app: "Vivaldi",
        name: "Vivaldi",
        family: Family::Chromium,
        dir: "Vivaldi",
        flat: false,
    },
    Known {
        browser: "opera",
        app: "Opera",
        name: "Opera",
        family: Family::Chromium,
        dir: "com.operasoftware.Opera",
        flat: true,
    },
    Known {
        browser: "chromium",
        app: "Chromium",
        name: "Chromium",
        family: Family::Chromium,
        dir: "Chromium",
        flat: false,
    },
    Known {
        browser: "firefox",
        app: "Firefox",
        name: "Firefox",
        family: Family::Firefox,
        dir: "Firefox/Profiles",
        flat: false,
    },
    Known {
        browser: "safari",
        app: "Safari",
        name: "Safari",
        family: Family::Safari,
        dir: "Safari",
        flat: true,
    },
];

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Every browser profile on this Mac with something to import.
pub fn sources() -> Vec<ImportSource> {
    let Some(home) = home() else {
        return Vec::new();
    };
    let support = home.join("Library/Application Support");
    let mut out = Vec::new();
    for known in KNOWN {
        let root = if known.family == Family::Safari {
            home.join("Library").join(known.dir)
        } else {
            support.join(known.dir)
        };
        if !root.exists() {
            continue;
        }
        match known.family {
            Family::Chromium => out.extend(chromium_sources(known, &root)),
            Family::Firefox => out.extend(firefox_sources(known, &root)),
            Family::Safari => out.push(source(
                known,
                &root,
                None,
                probe(&root, &["Bookmarks.plist", "History.db"]),
            )),
        }
    }
    out
}

fn source(known: &Known, dir: &Path, profile: Option<String>, access: Access) -> ImportSource {
    let folder = dir
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_default();
    ImportSource {
        id: format!("{}:{}", known.browser, folder),
        browser: known.browser.into(),
        name: known.name.into(),
        family: known.family,
        profile,
        dir: dir.to_string_lossy().into_owned(),
        access,
        icon: app_icon(known.app),
    }
}

/// Where the app lives, if it is installed at all.
fn app_bundle(app: &str) -> Option<PathBuf> {
    let mut candidates = vec![PathBuf::from(format!("/Applications/{app}.app"))];
    if let Some(home) = home() {
        candidates.push(home.join(format!("Applications/{app}.app")));
    }
    candidates
        .into_iter()
        .find(|p| p.join("Contents/Info.plist").exists())
}

/// The app's icon as a small PNG data URL, read from its bundle: the real
/// mark, whatever version is installed, without shipping anyone's logo.
/// Converted once per app with `sips`, which every Mac has.
pub fn app_icon(app: &str) -> Option<String> {
    use base64::Engine as _;
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = cache.lock().ok().and_then(|c| c.get(app).cloned()) {
        return hit;
    }
    let icon = (|| {
        let bundle = app_bundle(app)?;
        let info = plist::Value::from_file(bundle.join("Contents/Info.plist")).ok()?;
        let mut file = info
            .as_dictionary()?
            .get("CFBundleIconFile")?
            .as_string()?
            .to_owned();
        if !file.to_ascii_lowercase().ends_with(".icns") {
            file.push_str(".icns");
        }
        let icns = bundle.join("Contents/Resources").join(file);
        let dir = tempfile::tempdir().ok()?;
        let png = dir.path().join("icon.png");
        let ok = std::process::Command::new("sips")
            .args(["-s", "format", "png", "-Z", "64"])
            .arg(&icns)
            .arg("--out")
            .arg(&png)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .ok()?
            .success();
        if !ok {
            return None;
        }
        let bytes = std::fs::read(&png).ok()?;
        Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    })();
    if let Ok(mut c) = cache.lock() {
        c.insert(app.to_owned(), icon.clone());
    }
    icon
}

/// Try to open the data files: consent shows up as an error we can name.
fn probe(dir: &Path, files: &[&str]) -> Access {
    let mut found = false;
    for file in files {
        match std::fs::File::open(dir.join(file)) {
            Ok(_) => found = true,
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => return Access::Denied,
            Err(_) => {}
        }
    }
    // A folder we cannot even list is denied too, whatever the files say.
    if !found
        && matches!(std::fs::read_dir(dir), Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied)
    {
        return Access::Denied;
    }
    if found { Access::Ok } else { Access::Empty }
}

/// Chromium profile names, from `Local State`; the folder name when it has none.
fn chromium_profiles(root: &Path) -> Vec<(String, Option<String>)> {
    let mut profiles = Vec::new();
    if let Ok(text) = std::fs::read_to_string(root.join("Local State"))
        && let Ok(json) = serde_json::from_str::<serde_json::Value>(&text)
        && let Some(cache) = json
            .pointer("/profile/info_cache")
            .and_then(|v| v.as_object())
    {
        for (folder, info) in cache {
            let name = info.get("name").and_then(|n| n.as_str()).map(str::to_owned);
            profiles.push((folder.clone(), name));
        }
    }
    if profiles.is_empty()
        && let Ok(entries) = std::fs::read_dir(root)
    {
        for entry in entries.flatten() {
            let folder = entry.file_name().to_string_lossy().into_owned();
            if folder == "Default" || folder.starts_with("Profile ") {
                profiles.push((folder, None));
            }
        }
    }
    profiles.sort();
    profiles
}

fn chromium_sources(known: &Known, root: &Path) -> Vec<ImportSource> {
    if known.flat {
        return match probe(root, &["Bookmarks", "History"]) {
            Access::Empty => Vec::new(),
            access => vec![source(known, root, None, access)],
        };
    }
    let profiles = chromium_profiles(root);
    if profiles.is_empty() {
        // Either nothing is installed beyond a messaging-host stub, or macOS
        // will not let us look; only the latter is worth a row.
        return match probe(root, &["Local State"]) {
            Access::Denied => vec![source(known, &root.join("Default"), None, Access::Denied)],
            _ => Vec::new(),
        };
    }
    let several = profiles.len() > 1;
    profiles
        .into_iter()
        .filter_map(|(folder, name)| {
            let dir = root.join(&folder);
            match probe(&dir, &["Bookmarks", "History"]) {
                Access::Empty => None,
                access => Some(source(
                    known,
                    &dir,
                    if several {
                        Some(name.unwrap_or(folder))
                    } else {
                        None
                    },
                    access,
                )),
            }
        })
        .collect()
}

fn firefox_sources(known: &Known, root: &Path) -> Vec<ImportSource> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return vec![source(known, root, None, Access::Denied)];
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.join("places.sqlite").exists())
        .collect();
    dirs.sort();
    let several = dirs.len() > 1;
    dirs.into_iter()
        .map(|dir| {
            let profile = several.then(|| {
                dir.file_name()
                    .map(|f| f.to_string_lossy().into_owned())
                    .unwrap_or_default()
            });
            let access = probe(&dir, &["places.sqlite"]);
            source(known, &dir, profile, access)
        })
        .collect()
}

/// The source with this id, looked up fresh so its access is current.
pub fn find(id: &str) -> AppResult<ImportSource> {
    sources()
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| AppError::new("that browser is no longer available"))
}

/// Read everything asked for from `source`.
pub fn harvest(source: &ImportSource, bookmarks: bool, history: bool) -> AppResult<Harvest> {
    let dir = Path::new(&source.dir);
    let temp = tempfile::tempdir()?;
    let mut out = Harvest::default();
    match source.family {
        Family::Chromium => {
            if bookmarks && let Some(text) = read_optional(&dir.join("Bookmarks"))? {
                out.bookmarks = chromium_bookmarks(&text)?;
            }
            if history && let Some(db) = copied(dir, "History", temp.path())? {
                out.history = chromium_history(&db)?;
            }
        }
        Family::Firefox => {
            if let Some(db) = copied(dir, "places.sqlite", temp.path())? {
                let _ = copied(dir, "places.sqlite-wal", temp.path());
                if bookmarks {
                    out.bookmarks = firefox_bookmarks(&db)?;
                }
                if history {
                    out.history = firefox_history(&db)?;
                }
            }
        }
        Family::Safari => {
            if bookmarks && dir.join("Bookmarks.plist").exists() {
                out.bookmarks = safari_bookmarks(&dir.join("Bookmarks.plist"))?;
            }
            if history && let Some(db) = copied(dir, "History.db", temp.path())? {
                let _ = copied(dir, "History.db-wal", temp.path());
                out.history = safari_history(&db)?;
            }
        }
    }
    Ok(out)
}

fn denied(e: &std::io::Error, what: &str) -> AppError {
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        AppError::new(format!(
            "macOS would not let Dive read {what}; allow access first"
        ))
    } else {
        AppError::new(format!("could not read {what}: {e}"))
    }
}

fn read_optional(path: &Path) -> AppResult<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(denied(&e, &path.display().to_string())),
    }
}

/// Copy a database out from under the browser that has it open.
fn copied(dir: &Path, name: &str, into: &Path) -> AppResult<Option<PathBuf>> {
    let from = dir.join(name);
    if !from.exists() {
        return Ok(None);
    }
    let to = into.join(name);
    std::fs::copy(&from, &to).map_err(|e| denied(&e, &from.display().to_string()))?;
    Ok(Some(to))
}

fn open_ro(db: &Path) -> AppResult<rusqlite::Connection> {
    rusqlite::Connection::open_with_flags(
        db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| AppError::new(format!("could not open {}: {e}", db.display())))
}

/// Microseconds since 1601-01-01, as Chromium stores every time.
pub fn from_webkit_micros(micros: i64) -> Timestamp {
    const EPOCH_GAP: i64 = 11_644_473_600;
    from_unix(micros / 1_000_000 - EPOCH_GAP)
}

/// Microseconds since 1970, as Firefox stores every time.
pub fn from_unix_micros(micros: i64) -> Timestamp {
    from_unix(micros / 1_000_000)
}

/// Seconds since 2001-01-01, as Safari stores every time.
#[allow(clippy::cast_possible_truncation)]
pub fn from_cocoa_seconds(seconds: f64) -> Timestamp {
    const EPOCH_GAP: i64 = 978_307_200;
    from_unix(seconds.floor() as i64 + EPOCH_GAP)
}

fn from_unix(seconds: i64) -> Timestamp {
    // A zero or nonsense time (never visited, a corrupt row) becomes "now"
    // rather than 1601 or 1970, which would sink it to the bottom.
    match time::OffsetDateTime::from_unix_timestamp(seconds) {
        Ok(t) if seconds > 0 => Timestamp(t),
        _ => Timestamp::now(),
    }
}

fn keep(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

/// Chromium's `Bookmarks` file: folders of folders under three roots.
pub fn chromium_bookmarks(text: &str) -> AppResult<Vec<ImportedEntry>> {
    fn walk(node: &serde_json::Value, out: &mut Vec<ImportedEntry>) {
        if node.get("type").and_then(|t| t.as_str()) == Some("url") {
            let url = node.get("url").and_then(|u| u.as_str()).unwrap_or_default();
            if keep(url) {
                let micros = node
                    .get("date_added")
                    .and_then(|d| d.as_str())
                    .and_then(|d| d.parse::<i64>().ok())
                    .unwrap_or(0);
                out.push(ImportedEntry {
                    url: url.to_owned(),
                    title: node
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or_default()
                        .to_owned(),
                    at: from_webkit_micros(micros),
                });
            }
            return;
        }
        if let Some(children) = node.get("children").and_then(|c| c.as_array()) {
            for child in children {
                walk(child, out);
            }
        }
    }
    let json: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| AppError::new(format!("bookmarks file is not JSON: {e}")))?;
    let mut out = Vec::new();
    if let Some(roots) = json.get("roots").and_then(|r| r.as_object()) {
        for root in roots.values() {
            walk(root, &mut out);
        }
    }
    Ok(out)
}

/// Chromium's `History` database: one row per visit.
pub fn chromium_history(db: &Path) -> AppResult<Vec<ImportedEntry>> {
    let conn = open_ro(db)?;
    query(
        &conn,
        "SELECT urls.url, urls.title, visits.visit_time FROM visits
         JOIN urls ON urls.id = visits.url
         WHERE urls.hidden = 0
         ORDER BY visits.visit_time DESC LIMIT ?1",
        |url, title, t: i64| ImportedEntry {
            url,
            title,
            at: from_webkit_micros(t),
        },
    )
}

/// Firefox's `places.sqlite`: bookmarks are places with a bookmark row.
pub fn firefox_bookmarks(db: &Path) -> AppResult<Vec<ImportedEntry>> {
    let conn = open_ro(db)?;
    query(
        &conn,
        "SELECT p.url, COALESCE(b.title, p.title, ''), b.dateAdded FROM moz_bookmarks b
         JOIN moz_places p ON p.id = b.fk
         WHERE b.type = 1
         ORDER BY b.dateAdded DESC LIMIT ?1",
        |url, title, t: i64| ImportedEntry {
            url,
            title,
            at: from_unix_micros(t),
        },
    )
}

/// Firefox's `places.sqlite`: one row per visit.
pub fn firefox_history(db: &Path) -> AppResult<Vec<ImportedEntry>> {
    let conn = open_ro(db)?;
    query(
        &conn,
        "SELECT p.url, COALESCE(p.title, ''), v.visit_date FROM moz_historyvisits v
         JOIN moz_places p ON p.id = v.place_id
         ORDER BY v.visit_date DESC LIMIT ?1",
        |url, title, t: i64| ImportedEntry {
            url,
            title,
            at: from_unix_micros(t),
        },
    )
}

/// Safari's `History.db`: one row per visit, titles on the visit.
pub fn safari_history(db: &Path) -> AppResult<Vec<ImportedEntry>> {
    let conn = open_ro(db)?;
    query(
        &conn,
        "SELECT i.url, COALESCE(v.title, ''), v.visit_time FROM history_visits v
         JOIN history_items i ON i.id = v.history_item
         ORDER BY v.visit_time DESC LIMIT ?1",
        |url, title, t: f64| ImportedEntry {
            url,
            title,
            at: from_cocoa_seconds(t),
        },
    )
}

/// Safari's `Bookmarks.plist`: nested lists of leaves.
pub fn safari_bookmarks(path: &Path) -> AppResult<Vec<ImportedEntry>> {
    fn walk(node: &plist::Value, out: &mut Vec<ImportedEntry>) {
        let Some(dict) = node.as_dictionary() else {
            return;
        };
        if dict.get("WebBookmarkType").and_then(|t| t.as_string()) == Some("WebBookmarkTypeLeaf") {
            let url = dict
                .get("URLString")
                .and_then(|u| u.as_string())
                .unwrap_or_default();
            if keep(url) {
                let title = dict
                    .get("URIDictionary")
                    .and_then(|d| d.as_dictionary())
                    .and_then(|d| d.get("title"))
                    .and_then(|t| t.as_string())
                    .unwrap_or_default();
                out.push(ImportedEntry {
                    url: url.to_owned(),
                    title: title.to_owned(),
                    at: Timestamp::now(),
                });
            }
            return;
        }
        if let Some(children) = dict.get("Children").and_then(|c| c.as_array()) {
            for child in children {
                walk(child, out);
            }
        }
    }
    let value = plist::Value::from_file(path)
        .map_err(|e| AppError::new(format!("could not read Safari bookmarks: {e}")))?;
    let mut out = Vec::new();
    walk(&value, &mut out);
    Ok(out)
}

fn query<T: rusqlite::types::FromSql>(
    conn: &rusqlite::Connection,
    sql: &str,
    make: impl Fn(String, String, T) -> ImportedEntry,
) -> AppResult<Vec<ImportedEntry>> {
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| AppError::new(format!("unexpected database layout: {e}")))?;
    let rows = stmt
        .query_map([i64::try_from(HISTORY_LIMIT).unwrap_or(i64::MAX)], |r| {
            Ok(make(r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(|e| AppError::new(e.to_string()))?;
    let mut out = Vec::new();
    for row in rows {
        let entry = row.map_err(|e| AppError::new(e.to_string()))?;
        if keep(&entry.url) {
            out.push(entry);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chromium_bookmarks_walk_every_root_and_skip_non_web_urls() {
        let text = r#"{"roots":{"bookmark_bar":{"type":"folder","children":[
            {"type":"url","name":"Docs","url":"https://docs.test/","date_added":"13390000000000000"},
            {"type":"folder","name":"Work","children":[{"type":"url","name":"Repo","url":"https://repo.test/","date_added":"13390000000000000"}]}
        ]},"other":{"type":"folder","children":[{"type":"url","name":"Local","url":"file:///tmp/x","date_added":"0"}]},"synced":{"type":"folder","children":[]}}}"#;
        let got = chromium_bookmarks(text).unwrap();
        assert_eq!(
            got.iter().map(|b| b.url.as_str()).collect::<Vec<_>>(),
            ["https://docs.test/", "https://repo.test/"]
        );
        assert_eq!(got[0].title, "Docs");
        assert_eq!(got[0].at.to_rfc3339(), "2025-04-24T20:26:40Z");
    }

    #[test]
    fn chromium_history_reads_visits_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("History");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, hidden INTEGER DEFAULT 0);
             CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER);
             INSERT INTO urls VALUES (1, 'https://a.test/', 'A', 0), (2, 'https://b.test/', 'B', 0), (3, 'chrome://settings', 'S', 1);
             INSERT INTO visits VALUES (1, 1, 13390000000000000), (2, 2, 13390000060000000), (3, 3, 13390000070000000);",
        )
        .unwrap();
        drop(conn);
        let got = chromium_history(&db).unwrap();
        assert_eq!(
            got.iter().map(|v| v.url.as_str()).collect::<Vec<_>>(),
            ["https://b.test/", "https://a.test/"]
        );
        assert_eq!(got[0].title, "B");
    }

    #[test]
    fn firefox_places_yield_bookmarks_and_visits() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("places.sqlite");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
             CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, title TEXT, dateAdded INTEGER);
             CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER);
             INSERT INTO moz_places VALUES (1, 'https://a.test/', 'A'), (2, 'place:sort=8', 'Recent');
             INSERT INTO moz_bookmarks VALUES (1, 1, 1, 'Mine', 1756720000000000), (2, 1, 2, 'Query', 1756720000000000), (3, 2, NULL, 'Folder', 0);
             INSERT INTO moz_historyvisits VALUES (1, 1, 1756720000000000);",
        )
        .unwrap();
        drop(conn);
        let bookmarks = firefox_bookmarks(&db).unwrap();
        assert_eq!(bookmarks.len(), 1);
        assert_eq!(
            (bookmarks[0].url.as_str(), bookmarks[0].title.as_str()),
            ("https://a.test/", "Mine")
        );
        assert_eq!(bookmarks[0].at.to_rfc3339(), "2025-09-01T09:46:40Z");
        assert_eq!(firefox_history(&db).unwrap().len(), 1);
    }

    #[test]
    fn safari_files_yield_bookmarks_and_visits() {
        let dir = tempfile::tempdir().unwrap();
        let leaf = |url: &str, title: &str| {
            let mut uri = plist::Dictionary::new();
            uri.insert("title".into(), plist::Value::String(title.into()));
            let mut d = plist::Dictionary::new();
            d.insert(
                "WebBookmarkType".into(),
                plist::Value::String("WebBookmarkTypeLeaf".into()),
            );
            d.insert("URLString".into(), plist::Value::String(url.into()));
            d.insert("URIDictionary".into(), plist::Value::Dictionary(uri));
            plist::Value::Dictionary(d)
        };
        let mut list = plist::Dictionary::new();
        list.insert(
            "WebBookmarkType".into(),
            plist::Value::String("WebBookmarkTypeList".into()),
        );
        list.insert(
            "Children".into(),
            plist::Value::Array(vec![
                leaf("https://a.test/", "A"),
                leaf("javascript:void(0)", "Bookmarklet"),
            ]),
        );
        let mut root = plist::Dictionary::new();
        root.insert(
            "Children".into(),
            plist::Value::Array(vec![plist::Value::Dictionary(list)]),
        );
        let path = dir.path().join("Bookmarks.plist");
        plist::Value::Dictionary(root)
            .to_file_binary(&path)
            .unwrap();
        let bookmarks = safari_bookmarks(&path).unwrap();
        assert_eq!(bookmarks.len(), 1);
        assert_eq!(bookmarks[0].title, "A");

        let db = dir.path().join("History.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT);
             CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT);
             INSERT INTO history_items VALUES (1, 'https://a.test/');
             INSERT INTO history_visits VALUES (1, 1, 778336000.5, 'A');",
        )
        .unwrap();
        drop(conn);
        let visits = safari_history(&db).unwrap();
        assert_eq!(visits.len(), 1);
        assert_eq!(visits[0].at.to_rfc3339(), "2025-08-31T12:26:40Z");
    }

    #[test]
    fn epochs_convert_and_nonsense_becomes_now() {
        assert_eq!(
            from_webkit_micros(13_390_000_000_000_000).to_rfc3339(),
            "2025-04-24T20:26:40Z"
        );
        assert_eq!(
            from_unix_micros(1_756_720_000_000_000).to_rfc3339(),
            "2025-09-01T09:46:40Z"
        );
        assert_eq!(
            from_cocoa_seconds(778_336_000.0).to_rfc3339(),
            "2025-08-31T12:26:40Z"
        );
        let year = from_webkit_micros(0).0.year();
        assert!(year >= 2026);
    }

    #[test]
    fn chromium_profiles_come_from_local_state_or_folders() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("Default")).unwrap();
        std::fs::create_dir_all(dir.path().join("Profile 1")).unwrap();
        assert_eq!(
            chromium_profiles(dir.path()),
            vec![
                ("Default".to_string(), None),
                ("Profile 1".to_string(), None)
            ]
        );
        std::fs::write(
            dir.path().join("Local State"),
            r#"{"profile":{"info_cache":{"Default":{"name":"Ada"}}}}"#,
        )
        .unwrap();
        assert_eq!(
            chromium_profiles(dir.path()),
            vec![("Default".to_string(), Some("Ada".to_string()))]
        );
        // A profile with data is a source; one without is not.
        std::fs::write(dir.path().join("Default/Bookmarks"), "{}").unwrap();
        let known = &KNOWN[0];
        let found = chromium_sources(known, dir.path());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].access, Access::Ok);
        assert_eq!(found[0].profile, None);
    }

    #[test]
    fn app_icons_come_from_installed_bundles_only() {
        assert_eq!(app_icon("No Such Browser"), None);
        if app_bundle("Safari").is_some() {
            let icon = app_icon("Safari").expect("Safari ships with macOS");
            assert!(icon.starts_with("data:image/png;base64,"));
            assert_eq!(app_icon("Safari"), Some(icon), "cached");
        }
    }
}
