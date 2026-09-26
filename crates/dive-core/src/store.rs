//! SQLite persistence for containers, workspaces and tabs.
//!
//! One connection, WAL mode, versioned migrations. Callers own threading;
//! the store is `Send` but not `Sync`, so wrap it in a mutex or dedicate a
//! thread to it.

use std::path::Path;
use std::time::Duration;

use crate::model::{
    AgentThread, Container, ContainerId, Profile, ProfileId, Tab, TabId, TabState, TabTier,
    Timestamp, Workspace, WorkspaceId,
};
use crate::{CoreError, Result};
use rusqlite::{Connection, OptionalExtension, Row, params};

const MIGRATIONS: &[&str] = &[
    // v1
    "CREATE TABLE containers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cache_dir TEXT NOT NULL UNIQUE,
        persist_cookies INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        icon TEXT NOT NULL,
        container_id TEXT NOT NULL REFERENCES containers(id),
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE tabs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        tier TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL,
        state TEXT NOT NULL,
        last_active_at TEXT NOT NULL
    );
    CREATE INDEX tabs_by_workspace ON tabs(workspace_id, tier, position);",
    // v2: small key/value table for session state and preferences.
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    // v3: site icon, stored inline as a `data:` URL.
    "ALTER TABLE tabs ADD COLUMN favicon TEXT;",
    // v4: icons remembered per origin, so a tab shows its site's mark before
    // it has ever been opened in this session.
    "CREATE TABLE favicons (
        origin TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );",
    // v5: visited pages for the palette.
    "CREATE TABLE history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        visited_at TEXT NOT NULL
    );
    CREATE INDEX history_by_url ON history(url);
    CREATE INDEX history_by_time ON history(visited_at);",
    // v6: bookmarks.
    "CREATE TABLE bookmarks (
        url TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
    );",
    // v7: where a discarded tab was scrolled, so waking it puts the page back.
    "CREATE TABLE tab_scroll (
        tab_id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        x INTEGER NOT NULL DEFAULT 0,
        y INTEGER NOT NULL DEFAULT 0
    );",
    // v8: profiles own workspaces. Existing rows get an empty profile id that
    // `ensure_default_profile` fills in at startup, since a uuid v7 cannot
    // be minted in SQL.
    "CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        avatar TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        container_id TEXT NOT NULL REFERENCES containers(id),
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL
    );
    ALTER TABLE workspaces ADD COLUMN profile_id TEXT NOT NULL DEFAULT '';",
    // v9: a scroll offset belongs to its tab and goes when the tab goes, so
    // removing a workspace (which cascades to its tabs) leaves no orphans.
    // SQLite cannot add a foreign key in place; rebuild the table.
    "CREATE TABLE tab_scroll_new (
        tab_id TEXT PRIMARY KEY REFERENCES tabs(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        x INTEGER NOT NULL DEFAULT 0,
        y INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO tab_scroll_new (tab_id, url, x, y)
        SELECT s.tab_id, s.url, s.x, s.y FROM tab_scroll s
        WHERE EXISTS (SELECT 1 FROM tabs t WHERE t.id = s.tab_id);
    DROP TABLE tab_scroll;
    ALTER TABLE tab_scroll_new RENAME TO tab_scroll;",
    // v10: saved logins. The password lives in the keychain under `id`; this
    // is the listing and the fill index.
    "CREATE TABLE credentials (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        origin TEXT NOT NULL,
        username TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        uses INTEGER NOT NULL DEFAULT 0,
        UNIQUE(profile_id, origin, username)
    );
    CREATE INDEX credentials_origin ON credentials(profile_id, origin);",
    // v11: form entries (names, addresses, emails) offered while typing.
    "CREATE TABLE form_entries (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        uses INTEGER NOT NULL DEFAULT 1,
        last_used_at TEXT,
        UNIQUE(profile_id, field, value)
    );
    CREATE INDEX form_entries_field ON form_entries(profile_id, field);",
    // v12: history and bookmarks belong to a profile, like logins do. Rows
    // from before are given to the first profile, which is where they were made.
    "ALTER TABLE history ADD COLUMN profile_id TEXT NOT NULL DEFAULT '';
    UPDATE history SET profile_id = COALESCE((SELECT id FROM profiles ORDER BY position, created_at LIMIT 1), '');
    CREATE INDEX history_profile ON history(profile_id, visited_at);
    CREATE TABLE bookmarks_new (
        profile_id TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, url)
    );
    INSERT INTO bookmarks_new (profile_id, url, title, created_at)
        SELECT COALESCE((SELECT id FROM profiles ORDER BY position, created_at LIMIT 1), ''), url, title, created_at FROM bookmarks;
    DROP TABLE bookmarks;
    ALTER TABLE bookmarks_new RENAME TO bookmarks;",
    // v13: installed web apps. One row per app per profile, keyed by the
    // manifest id (Chrome's key too), so reinstalling from a changed start
    // URL updates the app rather than duplicating it. `bounds` is the last
    // windowed frame as JSON, or empty before the app has been opened.
    "CREATE TABLE web_apps (
        profile_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        short_name TEXT NOT NULL,
        start_url TEXT NOT NULL,
        scope TEXT NOT NULL,
        display TEXT NOT NULL,
        theme_color TEXT,
        background_color TEXT,
        icon_path TEXT NOT NULL,
        manifest_url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_opened_at TEXT,
        bounds TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (profile_id, id)
    );",
    // v14: addresses and payment cards for filling checkout forms. An
    // address is ordinary data and lives here; a card's number does not --
    // only its last four digits are kept, and the number itself goes to the
    // keychain under the row's id, the way a password does.
    "CREATE TABLE addresses (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        label TEXT NOT NULL,
        name TEXT NOT NULL,
        organization TEXT NOT NULL DEFAULT '',
        street TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        region TEXT NOT NULL DEFAULT '',
        postal_code TEXT NOT NULL DEFAULT '',
        country TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        uses INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX addresses_profile ON addresses(profile_id);
    CREATE TABLE cards (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        label TEXT NOT NULL,
        cardholder TEXT NOT NULL,
        last4 TEXT NOT NULL,
        brand TEXT NOT NULL DEFAULT '',
        expiry_month INTEGER NOT NULL,
        expiry_year INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        uses INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX cards_profile ON cards(profile_id);",
    // v15
    "CREATE TABLE agent_threads (
        tab_id TEXT PRIMARY KEY REFERENCES tabs(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        messages TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX agent_threads_updated ON agent_threads(updated_at);",
    // v16: the workspace an app was installed from, so it opens with that
    // workspace's container -- its cookies and logins -- rather than
    // whichever workspace happens to be active. Empty for apps installed
    // before this, which keep opening in the active workspace.
    "ALTER TABLE web_apps ADD COLUMN workspace_id TEXT;",
    // v17: one row per address a profile has visited, kept up to date by
    // `record_visit` next to the visit log. Searching history used to group
    // the whole log by address on every keystroke; a few months of browsing
    // is tens of thousands of visits but only a few thousand addresses.
    // Addresses are indexed by a 64-bit hash rather than by their text:
    // they run to kilobytes, and an index on the text doubled the size of
    // the database. `key_hash` hashes the address without its fragment or
    // trailing slash (see `url_key`), which finds the twins shown as one
    // row. The rows are filled in `URLS_MIGRATION`, since the hashes are
    // computed in Rust.
    "CREATE TABLE urls (
        id INTEGER PRIMARY KEY,
        profile_id TEXT NOT NULL,
        url TEXT NOT NULL,
        url_hash INTEGER NOT NULL,
        key_hash INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        last_visit TEXT NOT NULL,
        visit_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX urls_by_address ON urls(profile_id, url_hash);
    CREATE INDEX urls_by_key ON urls(profile_id, key_hash);
    CREATE INDEX urls_by_recency ON urls(profile_id, last_visit);",
    // v18: site icons are stored once, under a key made from their bytes,
    // and everything else refers to them by that key. A tab row used to
    // carry its icon inline -- tens of kilobytes of `data:` URL -- into
    // every tab event, snapshot and history result the chrome was sent.
    // `source` names the icon links the page declared when the icon was
    // resolved, so a later load that declares the same ones can skip the
    // fetch. The data moves across in `FAVICON_KEYS_MIGRATION`, since the
    // key is computed in Rust.
    "CREATE TABLE favicon_images (
        key TEXT PRIMARY KEY,
        data TEXT NOT NULL
    );
    CREATE TABLE favicons_by_key (
        origin TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
    );",
];

/// Migrations whose data moves run in Rust, after their SQL and inside the
/// same transaction: see [`fill_urls`] and [`move_favicons_to_keys`]. A
/// migration renumbered while merging must carry its number here with it.
const URLS_MIGRATION: usize = 17;
/// See [`URLS_MIGRATION`].
const FAVICON_KEYS_MIGRATION: usize = 18;

/// Setting that names the active workspace; the store reads it to know
/// which profile history and bookmarks belong to right now.
pub const ACTIVE_WORKSPACE_SETTING: &str = "active_workspace";

/// Copy an existing database aside when this build is about to migrate it,
/// so a migration that goes wrong is recoverable by hand. Returns the copy's
/// path, or `None` when there was nothing to protect (a new file, or one
/// already at this build's schema).
fn backup_before_migrating(path: &Path) -> Result<Option<std::path::PathBuf>> {
    if !path.is_file() {
        return Ok(None);
    }
    let version = Store::file_version(path)?;
    if version >= MIGRATIONS.len() {
        return Ok(None);
    }
    let name = path
        .file_name()
        .map_or_else(|| "dive.db".into(), |n| n.to_string_lossy().into_owned());
    let backup = path.with_file_name(format!("{name}.before-v{}", MIGRATIONS.len()));
    // A checkpoint folds the WAL into the main file, so the copy is complete.
    let live = Connection::open(path)?;
    live.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    drop(live);
    std::fs::copy(path, &backup).map_err(|e| {
        CoreError::Db(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_IOERR),
            Some(format!(
                "copying {} to {}: {e}",
                path.display(),
                backup.display()
            )),
        ))
    })?;
    remove_older_backups(path, &backup);
    Ok(Some(backup))
}

/// Delete the copies earlier migrations left beside the database, keeping
/// `newest`. Each is a whole copy of the database -- tens of megabytes after
/// some months -- and only the one taken just before the latest migration is
/// worth going back to: an older one predates changes the newer copy holds.
/// Failing to delete one costs disk space, never data, so errors are only
/// logged.
fn remove_older_backups(path: &Path, newest: &Path) {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return;
    };
    let prefix = format!("{}.before-v", name.to_string_lossy());
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let file = entry.file_name();
        let file = file.to_string_lossy();
        let is_backup = file
            .strip_prefix(&prefix)
            .is_some_and(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()));
        if !is_backup || entry.path() == newest {
            continue;
        }
        match std::fs::remove_file(entry.path()) {
            Ok(()) => tracing::info!(backup = %file, "removed an older pre-migration copy"),
            Err(e) => {
                tracing::warn!(backup = %file, "could not remove an older pre-migration copy: {e}");
            }
        }
    }
}

/// The key a site icon is stored and requested under, made from its bytes.
///
/// FNV-1a over the `data:` URL plus its length: a stable, dependency-free
/// fingerprint for a table that holds a few hundred icons, where the only
/// thing a collision could do is show one site's mark on another. Because the
/// key names the content, the chrome can cache what it reads for a key for as
/// long as it runs; a changed icon arrives under a new key.
pub fn favicon_key(data: &str) -> String {
    format!("{:016x}{:x}", fnv1a(data), data.len())
}

/// 64-bit FNV-1a of `s`: tiny, stable across builds and platforms, and good
/// enough to tell apart the few thousand strings a table here holds.
fn fnv1a(s: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in s.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// [`fnv1a`] as SQLite stores an integer. Lookups always compare the text as
/// well, so two addresses that share a hash stay two rows.
fn url_hash(s: &str) -> i64 {
    i64::from_ne_bytes(fnv1a(s).to_ne_bytes())
}

/// Fill the per-address table from the visit log: one row per profile and
/// address, with its visit count, its latest visit and the title of its
/// latest titled visit. Runs inside migration v17's transaction.
fn fill_urls(conn: &Connection) -> Result<()> {
    // SQLite's bare column beside MAX() comes from the row holding the
    // maximum, which makes this the newest non-empty title per address.
    let titles: std::collections::HashMap<(String, String), String> = {
        let mut stmt = conn.prepare(
            "SELECT profile_id, url, title, MAX(visited_at) FROM history
             WHERE title != '' GROUP BY profile_id, url",
        )?;
        let rows = stmt.query_map([], |r| Ok(((r.get(0)?, r.get(1)?), r.get(2)?)))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    let mut visited = conn.prepare(
        "SELECT profile_id, url, MAX(visited_at), COUNT(*) FROM history GROUP BY profile_id, url",
    )?;
    let mut insert = conn.prepare(
        "INSERT INTO urls (profile_id, url, url_hash, key_hash, title, last_visit, visit_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    let mut rows = visited.query([])?;
    while let Some(row) = rows.next()? {
        let (profile, url): (String, String) = (row.get(0)?, row.get(1)?);
        let (last, count): (String, i64) = (row.get(2)?, row.get(3)?);
        let title = titles
            .get(&(profile.clone(), url.clone()))
            .map_or("", String::as_str);
        insert.execute(params![
            profile,
            url,
            url_hash(&url),
            url_hash(url_key(&url)),
            title,
            last,
            count
        ])?;
    }
    Ok(())
}

/// Move icons from inline `data:` URLs to [`favicon_key`]s: the bytes go to
/// `favicon_images` once, and the origin cache and every tab keep only the
/// key. Runs inside the migration's transaction, so a failure leaves the
/// database as it was.
fn move_favicons_to_keys(conn: &Connection) -> Result<()> {
    let origins: Vec<(String, String, String)> = {
        let mut stmt = conn.prepare("SELECT origin, data, updated_at FROM favicons")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    for (origin, data, updated_at) in origins {
        let key = favicon_key(&data);
        conn.execute(
            "INSERT OR IGNORE INTO favicon_images (key, data) VALUES (?1, ?2)",
            params![key, data],
        )?;
        conn.execute(
            "INSERT INTO favicons_by_key (origin, key, updated_at) VALUES (?1, ?2, ?3)",
            params![origin, key, updated_at],
        )?;
    }
    let tabs: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, favicon FROM tabs WHERE favicon IS NOT NULL AND favicon != ''")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    for (id, data) in tabs {
        let key = favicon_key(&data);
        conn.execute(
            "INSERT OR IGNORE INTO favicon_images (key, data) VALUES (?1, ?2)",
            params![key, data],
        )?;
        conn.execute(
            "UPDATE tabs SET favicon = ?2 WHERE id = ?1",
            params![id, key],
        )?;
    }
    conn.execute_batch("DROP TABLE favicons; ALTER TABLE favicons_by_key RENAME TO favicons;")?;
    Ok(())
}

/// What makes two history addresses the same page on screen: the address
/// without its fragment and without trailing slashes. `https://a.dev/`,
/// `https://a.dev` and `https://a.dev/#top` are one page; `?gl=PH` is not
/// ignored, since a query can be the whole difference between two pages.
pub fn url_key(url: &str) -> &str {
    url.split('#').next().unwrap_or(url).trim_end_matches('/')
}

/// The empty document's own name, which a page reports as its title while
/// the real one is still loading.
const BLANK_TITLE: &str = "about:blank";

/// How many matching addresses a history search ranks: the newest this many.
/// Plenty for a site visited every day for months to be among them, and few
/// enough that a one-letter query stays cheap.
const HISTORY_CANDIDATES: usize = 1000;

/// How much more a page counts when its address begins with what was typed.
/// Typing `git` means github.com far more often than a page whose title
/// happens to mention git, however often that page was read.
const HOST_MATCH_BOOST: f64 = 8.0;

/// How strongly history suggests a page: how often it was visited, weighed
/// by how long ago the last visit was.
///
/// Recency comes in steps rather than a smooth decay, so a page read this
/// morning and one read last night are equals. The count is taken on a log
/// scale: a page visited daily still outranks one visited once, but a page
/// left open and reloading itself for a year does not bury everything else.
fn frecency(visits: u32, age: time::Duration) -> f64 {
    let recency = match age.whole_hours() {
        h if h < 24 => 100.0,
        h if h < 24 * 4 => 70.0,
        h if h < 24 * 14 => 50.0,
        h if h < 24 * 31 => 30.0,
        h if h < 24 * 90 => 15.0,
        _ => 5.0,
    };
    recency * f64::from(visits.max(1)).ln_1p()
}

/// Whether `url`, without its scheme and `www.`, begins with `needle`
/// (already lower-cased), which is also read without a scheme or `www.`:
/// `git`, `github.com/` and `https://www.github.com` all match github.com.
fn address_starts_with(url: &str, needle: &str) -> bool {
    fn bare(s: &str) -> &str {
        let s = s
            .strip_prefix("https://")
            .or_else(|| s.strip_prefix("http://"))
            .unwrap_or(s);
        s.strip_prefix("www.").unwrap_or(s)
    }
    let needle = bare(needle);
    !needle.is_empty() && bare(&url.to_lowercase()).starts_with(needle)
}

/// A bookmark or visit brought in from another browser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedEntry {
    /// The page.
    pub url: String,
    /// Its title, or empty.
    pub title: String,
    /// When it was saved or visited.
    pub at: Timestamp,
}

/// A saved page.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct Bookmark {
    /// URL.
    pub url: String,
    /// Title at save time.
    pub title: String,
    /// RFC 3339 creation time.
    pub created_at: String,
    /// The key of the site's remembered icon, when one is known; the chrome
    /// reads the image itself with `favicon_get`.
    pub favicon: Option<String>,
}

fn web_app_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WebApp> {
    Ok(WebApp {
        id: row.get(0)?,
        name: row.get(1)?,
        short_name: row.get(2)?,
        start_url: row.get(3)?,
        scope: row.get(4)?,
        display: row.get(5)?,
        theme_color: row.get(6)?,
        background_color: row.get(7)?,
        icon_path: row.get(8)?,
        manifest_url: row.get(9)?,
        created_at: row.get(10)?,
        last_opened_at: row.get(11)?,
        bounds: row.get(12)?,
        // A value that no longer parses is an app with no workspace of its
        // own, which opens in the active one like an app from before v16.
        workspace_id: row
            .get::<_, Option<String>>(13)?
            .and_then(|id| id.parse().ok()),
    })
}

/// A web app installed from its manifest, opened in a window of its own.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct WebApp {
    /// The manifest `id`, or the start URL when the manifest gives none.
    pub id: String,
    /// The manifest `name`.
    pub name: String,
    /// The manifest `short_name`, for the Dock and tight spaces.
    pub short_name: String,
    /// Where the app opens.
    pub start_url: String,
    /// URL prefix the app owns; leaving it shows the page as a plain site.
    pub scope: String,
    /// `standalone`, `minimal-ui` or `fullscreen`.
    pub display: String,
    /// Chrome colour the manifest asks for, when it does.
    pub theme_color: Option<String>,
    /// Splash/background colour the manifest asks for, when it does.
    pub background_color: Option<String>,
    /// PNG icon on disk, made at install time.
    pub icon_path: String,
    /// The manifest this came from, for reinstall and diagnostics.
    pub manifest_url: String,
    /// RFC 3339 install time.
    pub created_at: String,
    /// RFC 3339 time the app was last opened, once it has been.
    pub last_opened_at: Option<String>,
    /// Last windowed frame as JSON (`{"x","y","width","height"}`), or empty.
    pub bounds: String,
    /// The workspace the app was installed from, whose container it opens
    /// in; absent for apps installed before Dive remembered it.
    #[specta(optional)]
    pub workspace_id: Option<WorkspaceId>,
}

/// A saved login for one site in one profile. The password itself lives in
/// the OS keychain under the credential's id; this row is what the list
/// shows and what fill matches on.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct Credential {
    /// Row id, also the keychain account name.
    pub id: String,
    /// The profile the login belongs to.
    pub profile_id: String,
    /// `scheme://host[:port]`, no path.
    pub origin: String,
    /// The account name as the site's form took it.
    pub username: String,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339, when it was last filled.
    pub last_used_at: Option<String>,
    /// How many times it has been filled.
    pub uses: u32,
}

/// A postal address, for filling a checkout or a delivery form.
///
/// Ordinary data, so unlike a card or a password it lives in the database
/// whole; there is nothing here a person would not hand to a courier.
#[derive(
    Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type,
)]
pub struct Address {
    /// Row id.
    pub id: String,
    /// The profile the address belongs to.
    pub profile_id: String,
    /// What the person calls it ("Home", "Work").
    pub label: String,
    /// The full name the parcel is addressed to.
    pub name: String,
    /// Company or department, when a delivery needs one.
    pub organization: String,
    /// The street lines, newline-separated as they are typed.
    pub street: String,
    /// Town or city.
    pub city: String,
    /// State, province or county.
    pub region: String,
    /// Postcode or ZIP.
    pub postal_code: String,
    /// Country as written, or its two-letter code.
    pub country: String,
    /// Contact number for the delivery.
    pub phone: String,
    /// Contact address for the order.
    pub email: String,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339, when it was last filled.
    pub last_used_at: Option<String>,
    /// How many times it has been filled.
    pub uses: u32,
}

/// A payment card, as the list shows it.
///
/// The number is **not** here: only the last four digits, so a card can be
/// recognised, while the number itself lives in the OS keychain under the
/// row's id, exactly as a password does.
#[derive(
    Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type,
)]
pub struct Card {
    /// Row id, also the keychain account name.
    pub id: String,
    /// The profile the card belongs to.
    pub profile_id: String,
    /// What the person calls it ("Personal", "Company").
    pub label: String,
    /// The name on the card.
    pub cardholder: String,
    /// The last four digits, which is all a listing needs.
    pub last4: String,
    /// `visa`, `mastercard`, `amex`, `discover`, or empty when unknown.
    pub brand: String,
    /// Expiry month, 1 to 12.
    pub expiry_month: u32,
    /// Expiry year, four digits.
    pub expiry_year: u32,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339, when it was last filled.
    pub last_used_at: Option<String>,
    /// How many times it has been filled.
    pub uses: u32,
}

/// One thing typed into a form field once, offered again when the same
/// field (by its name) is typed into.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct FormEntry {
    /// Row id.
    pub id: String,
    /// The profile the entry belongs to.
    pub profile_id: String,
    /// The field's `name` (or `id`) attribute, lower-cased.
    pub field: String,
    /// What was typed.
    pub value: String,
    /// How many times it was used, here or before import.
    pub uses: u32,
    /// RFC 3339.
    pub last_used_at: Option<String>,
}

/// A form entry on its way in from another browser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedFormEntry {
    /// The field's name, any case.
    pub field: String,
    /// What was typed.
    pub value: String,
    /// The other browser's use count.
    pub uses: u32,
    /// When it was last used there.
    pub last_used_at: Option<Timestamp>,
}

/// One page in history, aggregated by URL.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct HistoryEntry {
    /// URL.
    pub url: String,
    /// Most recent non-empty title.
    pub title: String,
    /// RFC 3339 time of the last visit.
    pub last_visited_at: String,
    /// Number of recorded visits.
    pub visits: u32,
    /// The key of the site's remembered icon, when one is known; the chrome
    /// reads the image itself with `favicon_get`.
    pub favicon: Option<String>,
}

/// What one change to a tab means for history; see [`Store::save_tab`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VisitChange<'a> {
    /// The tab went to `url`: a visit, folded into the last one when the
    /// same page was visited less than a minute ago.
    Navigated {
        /// Where the tab is now.
        url: &'a str,
        /// What to file it under; empty until the page names itself.
        title: &'a str,
        /// When.
        at: Timestamp,
    },
    /// The page at `url` named itself `title`. It names the latest visit
    /// there if that has no name yet, and changes nothing otherwise: a page
    /// that animates its own title -- an unread count, a clock -- must not
    /// write to history on every tick.
    Titled {
        /// The page.
        url: &'a str,
        /// Its title now.
        title: &'a str,
    },
}

/// What the store remembers about one origin's icon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FaviconEntry {
    /// The icon's key; see [`favicon_key`].
    pub key: String,
    /// The fingerprint of the icon links the page declared when it was
    /// resolved, or empty when that is not known.
    pub source: String,
    /// When the icon was last resolved or confirmed.
    pub updated_at: Timestamp,
}

/// Persistent store backed by SQLite.
pub struct Store {
    conn: Connection,
    /// The profile history and bookmarks are filed under, once worked out.
    /// Every visit, search and bookmark check asks for it, and each answer
    /// cost a settings read and a workspace read; it changes only when the
    /// active workspace or the profiles do, and every write that could move
    /// it clears this. See [`Store::scope`].
    scope: std::cell::RefCell<Option<String>>,
}

impl Store {
    /// Open or create the database at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(backup) = backup_before_migrating(path)? {
            tracing::info!(backup = %backup.display(), "copied the database before migrating it");
        }
        Self::init(Connection::open(path)?)
    }

    /// Open an in-memory database, for tests and previews.
    pub fn in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        // WAL with synchronous=NORMAL fsyncs at checkpoints rather than on
        // every commit. A crash can never corrupt the database or lose a
        // committed transaction; only a power loss can drop the last few
        // commits. That is the right trade for a store the app writes twice
        // per tab switch on the main thread under its host and store locks.
        conn.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;",
        )?;
        // A second Dive process or a short-lived SQLite checkpoint should wait
        // instead of surfacing an immediate, user-visible `database is locked`.
        conn.busy_timeout(Duration::from_secs(5))?;
        let store = Self {
            conn,
            scope: std::cell::RefCell::new(None),
        };
        store.migrate()?;
        // v8 left pre-profile workspaces with an empty profile id, which
        // `workspace_from_row` cannot parse. Repair here so every opener,
        // not just the app, reads a consistent database.
        let orphaned: i64 = store.conn.query_row(
            "SELECT COUNT(*) FROM workspaces WHERE profile_id = ''",
            [],
            |r| r.get(0),
        )?;
        if orphaned > 0 {
            store.ensure_default_profile()?;
        }
        Ok(store)
    }

    /// The schema version a database file carries, without migrating it.
    pub fn file_version(path: &Path) -> Result<usize> {
        let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        Ok(usize::try_from(version).unwrap_or(0))
    }

    fn migrate(&self) -> Result<()> {
        self.migrate_to(MIGRATIONS.len())
    }

    /// Apply migrations up to and including `target`; tests stop short of
    /// the latest to build a database as an older build left it.
    fn migrate_to(&self, target: usize) -> Result<()> {
        let version: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))?;
        let version = usize::try_from(version).unwrap_or(0);
        if version > MIGRATIONS.len() {
            return Err(CoreError::Invalid(format!(
                "database schema is version {version}, newer than the {} this build knows; \
                 open it with a newer Dive",
                MIGRATIONS.len()
            )));
        }
        for (i, sql) in MIGRATIONS.iter().enumerate().take(target).skip(version) {
            let next = i + 1;
            tracing::info!(version = next, "applying migration");
            // Schema changes and their version marker are one unit. Without a
            // transaction, a crash between them leaves a half-applied migration
            // that cannot be safely retried on the next launch.
            let tx = self.conn.unchecked_transaction()?;
            tx.execute_batch(sql)?;
            match next {
                URLS_MIGRATION => fill_urls(&tx)?,
                FAVICON_KEYS_MIGRATION => move_favicons_to_keys(&tx)?,
                _ => {}
            }
            tx.pragma_update(
                None,
                "user_version",
                i64::try_from(next).unwrap_or(i64::MAX),
            )?;
            tx.commit()?;
        }
        Ok(())
    }

    // ----- containers -----

    /// Insert or replace a container.
    pub fn upsert_container(&self, c: &Container) -> Result<()> {
        self.conn.execute(
            "INSERT INTO containers (id, name, cache_dir, persist_cookies) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, cache_dir = excluded.cache_dir,
             persist_cookies = excluded.persist_cookies",
            params![c.id.to_string(), c.name, c.cache_dir, c.persist_cookies],
        )?;
        Ok(())
    }

    /// Fetch one container.
    pub fn container(&self, id: ContainerId) -> Result<Container> {
        self.conn
            .query_row(
                &format!("{CONTAINER_SELECT} WHERE id = ?1"),
                [id.to_string()],
                container_from_row,
            )
            .optional()?
            .ok_or_else(|| CoreError::NotFound {
                kind: "container",
                id: id.to_string(),
            })
    }

    /// All containers by name.
    pub fn containers(&self) -> Result<Vec<Container>> {
        let mut stmt = self
            .conn
            .prepare(&format!("{CONTAINER_SELECT} ORDER BY name"))?;
        let rows = stmt.query_map([], container_from_row)?;
        rows.collect::<std::result::Result<_, _>>()
            .map_err(Into::into)
    }

    // ----- workspaces -----

    /// Insert or replace a workspace.
    pub fn upsert_workspace(&self, w: &Workspace) -> Result<()> {
        self.forget_scope();
        self.conn.execute(
            "INSERT INTO workspaces (id, name, color, icon, container_id, position, created_at, profile_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color,
             icon = excluded.icon, container_id = excluded.container_id, position = excluded.position,
             profile_id = excluded.profile_id",
            params![
                w.id.to_string(),
                w.name,
                w.color,
                w.icon,
                w.container_id.to_string(),
                w.position,
                w.created_at.to_rfc3339(),
                w.profile_id.to_string()
            ],
        )?;
        Ok(())
    }

    /// Fetch one workspace.
    pub fn workspace(&self, id: WorkspaceId) -> Result<Workspace> {
        self.conn
            .query_row(
                &format!("{WORKSPACE_SELECT} WHERE id = ?1"),
                [id.to_string()],
                workspace_from_row,
            )
            .optional()?
            .ok_or_else(|| CoreError::NotFound {
                kind: "workspace",
                id: id.to_string(),
            })
    }

    /// All workspaces in rail order.
    pub fn workspaces(&self) -> Result<Vec<Workspace>> {
        let mut stmt = self
            .conn
            .prepare(&format!("{WORKSPACE_SELECT} ORDER BY position, created_at"))?;
        let rows = stmt.query_map([], workspace_from_row)?;
        rows.collect::<std::result::Result<_, _>>()
            .map_err(Into::into)
    }

    /// The workspaces of one profile, in rail order.
    pub fn workspaces_for_profile(&self, profile: ProfileId) -> Result<Vec<Workspace>> {
        let mut stmt = self.conn.prepare(&format!(
            "{WORKSPACE_SELECT} WHERE profile_id = ?1 ORDER BY position, created_at"
        ))?;
        let rows = stmt.query_map([profile.to_string()], workspace_from_row)?;
        rows.collect::<std::result::Result<_, _>>()
            .map_err(Into::into)
    }

    // ----- profiles -----

    /// Insert or replace a profile.
    pub fn upsert_profile(&self, p: &Profile) -> Result<()> {
        self.forget_scope();
        self.conn.execute(
            "INSERT INTO profiles (id, name, color, avatar, note, container_id, position, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color,
             avatar = excluded.avatar, note = excluded.note, container_id = excluded.container_id,
             position = excluded.position",
            params![
                p.id.to_string(),
                p.name,
                p.color,
                p.avatar,
                p.note,
                p.container_id.to_string(),
                p.position,
                p.created_at.to_rfc3339()
            ],
        )?;
        Ok(())
    }

    /// Fetch one profile.
    pub fn profile(&self, id: ProfileId) -> Result<Profile> {
        self.conn
            .query_row(
                &format!("{PROFILE_SELECT} WHERE id = ?1"),
                [id.to_string()],
                profile_from_row,
            )
            .optional()?
            .ok_or_else(|| CoreError::NotFound {
                kind: "profile",
                id: id.to_string(),
            })
    }

    /// All profiles in switcher order.
    pub fn profiles(&self) -> Result<Vec<Profile>> {
        let mut stmt = self
            .conn
            .prepare(&format!("{PROFILE_SELECT} ORDER BY position, created_at"))?;
        let rows = stmt.query_map([], profile_from_row)?;
        rows.collect::<std::result::Result<_, _>>()
            .map_err(Into::into)
    }

    /// Remove a profile. Its workspaces must have been removed first.
    pub fn remove_profile(&self, id: ProfileId) -> Result<()> {
        self.forget_scope();
        let workspaces: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM workspaces WHERE profile_id = ?1",
            [id.to_string()],
            |r| r.get(0),
        )?;
        if workspaces > 0 {
            return Err(CoreError::Invalid(format!(
                "profile {id} still owns {workspaces} workspace(s); remove or move them first"
            )));
        }
        let n = self
            .conn
            .execute("DELETE FROM profiles WHERE id = ?1", [id.to_string()])?;
        if n == 0 {
            return Err(CoreError::NotFound {
                kind: "profile",
                id: id.to_string(),
            });
        }
        Ok(())
    }

    /// Remove what a deleted profile kept in the database: its logins,
    /// cards, addresses, form entries, history, bookmarks and the settings
    /// named after it. Passwords and card numbers live in the keychain under
    /// the row ids, so the caller reads those ids first and removes the
    /// secrets itself. Installed web apps are left to their own uninstall,
    /// which also takes their launchers away.
    pub fn remove_profile_data(&self, id: ProfileId) -> Result<()> {
        self.forget_scope();
        let tx = self.conn.unchecked_transaction()?;
        let key = id.to_string();
        for table in [
            "credentials",
            "cards",
            "addresses",
            "form_entries",
            "history",
            "urls",
            "bookmarks",
        ] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE profile_id = ?1"),
                [&key],
            )?;
        }
        // Settings keyed by the profile id: the workspace it last showed,
        // sites it never saves logins for, sites kept awake.
        tx.execute("DELETE FROM settings WHERE instr(key, ?1) > 0", [&key])?;
        tx.commit()?;
        Ok(())
    }

    /// Remove `id` if no profile or workspace uses it any more, returning
    /// it so the caller can delete its folder; `None` when it is still used.
    pub fn remove_container_if_unused(&self, id: ContainerId) -> Result<Option<Container>> {
        let used: i64 = self.conn.query_row(
            "SELECT (SELECT COUNT(*) FROM workspaces WHERE container_id = ?1)
                  + (SELECT COUNT(*) FROM profiles WHERE container_id = ?1)",
            [id.to_string()],
            |r| r.get(0),
        )?;
        if used > 0 {
            return Ok(None);
        }
        let Some(container) = self
            .conn
            .query_row(
                &format!("{CONTAINER_SELECT} WHERE id = ?1"),
                [id.to_string()],
                container_from_row,
            )
            .optional()?
        else {
            return Ok(None);
        };
        self.conn
            .execute("DELETE FROM containers WHERE id = ?1", [id.to_string()])?;
        Ok(Some(container))
    }

    /// Make sure a profile exists and every workspace belongs to one: a
    /// database from before profiles gets a "Personal" profile in the first
    /// container that adopts all its workspaces. Returns the first profile.
    pub fn ensure_default_profile(&self) -> Result<Profile> {
        self.forget_scope();
        if let Some(first) = self.profiles()?.into_iter().next() {
            self.conn.execute(
                "UPDATE workspaces SET profile_id = ?1 WHERE profile_id = ''",
                [first.id.to_string()],
            )?;
            return Ok(first);
        }
        let container = if let Some(c) = self.containers()?.into_iter().next() {
            c
        } else {
            let c = Container::new("Personal");
            self.upsert_container(&c)?;
            c
        };
        let profile = Profile::new("Personal", container.id, 0);
        self.upsert_profile(&profile)?;
        self.conn.execute(
            "UPDATE workspaces SET profile_id = ?1 WHERE profile_id = ''",
            [profile.id.to_string()],
        )?;
        Ok(profile)
    }

    /// Remove a workspace and, by cascade, its tabs.
    pub fn remove_workspace(&self, id: WorkspaceId) -> Result<()> {
        self.forget_scope();
        let n = self
            .conn
            .execute("DELETE FROM workspaces WHERE id = ?1", [id.to_string()])?;
        if n == 0 {
            return Err(CoreError::NotFound {
                kind: "workspace",
                id: id.to_string(),
            });
        }
        Ok(())
    }

    // ----- tabs -----

    /// Insert or replace a tab.
    pub fn upsert_tab(&self, t: &Tab) -> Result<()> {
        // Cached: every title and address change of every tab lands here.
        self.conn.prepare_cached(
            "INSERT INTO tabs (id, workspace_id, tier, url, title, position, state, last_active_at, favicon)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, tier = excluded.tier,
             url = excluded.url, title = excluded.title, position = excluded.position,
             state = excluded.state, last_active_at = excluded.last_active_at,
             favicon = excluded.favicon",
        )?
        .execute(params![
                t.id.to_string(),
                t.workspace_id.map(|w| w.to_string()),
                t.tier.as_str(),
                t.url,
                t.title,
                t.position,
                t.state.as_str(),
                t.last_active_at.to_rfc3339(),
                t.favicon
            ])?;
        Ok(())
    }

    /// Persist `tab` and what the change means for history, together.
    ///
    /// One transaction instead of two or three autocommits: every title and
    /// address change of every tab comes through here, and each commit is a
    /// WAL append of its own. The visit is best-effort, as it always was: a
    /// failure to file it is logged and rolled back on its own, and never
    /// costs the tab its update.
    pub fn save_tab(&self, tab: &Tab, visit: Option<VisitChange<'_>>) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        self.upsert_tab(tab)?;
        if let Some(visit) = visit {
            self.conn.execute_batch("SAVEPOINT visit")?;
            let filed = match visit {
                VisitChange::Navigated { url, title, at } => self.record_visit_in(url, title, at),
                VisitChange::Titled { url, title } => self.title_visit_in(url, title).map(|_| ()),
            };
            match filed {
                Ok(()) => self.conn.execute_batch("RELEASE visit")?,
                Err(e) => {
                    tracing::debug!(%tab.id, "history write failed: {e}");
                    self.conn
                        .execute_batch("ROLLBACK TO visit; RELEASE visit")?;
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Move each listed tab to its position, all in one transaction: a drag
    /// that shifts ten tabs is one commit, not ten.
    pub fn set_tab_positions(&self, positions: &[(TabId, i32)]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare_cached("UPDATE tabs SET position = ?2 WHERE id = ?1")?;
            for (id, position) in positions {
                stmt.execute(params![id.to_string(), position])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Fetch one tab.
    pub fn tab(&self, id: TabId) -> Result<Tab> {
        let mut tab = self.tab_as_stored(id)?;
        self.fill_favicon(&mut tab);
        Ok(tab)
    }

    /// The tab's row exactly as written, without the site icon [`tab`]
    /// lends it. Deciding whether a change happened has to compare against
    /// this: the lent icon makes a freshly resolved one look already known.
    ///
    /// [`tab`]: Self::tab
    pub fn tab_as_stored(&self, id: TabId) -> Result<Tab> {
        self.conn
            .prepare_cached(&format!("{TAB_SELECT} WHERE id = ?1"))?
            .query_row([id.to_string()], tab_from_row)
            .optional()?
            .ok_or_else(|| CoreError::NotFound {
                kind: "tab",
                id: id.to_string(),
            })
    }

    /// Tabs of one workspace plus essentials, ordered by tier then position.
    pub fn tabs_for_workspace(&self, id: WorkspaceId) -> Result<Vec<Tab>> {
        let mut stmt = self.conn.prepare(&format!(
            "{TAB_SELECT} WHERE workspace_id = ?1 OR tier = 'essential'
             ORDER BY CASE tier WHEN 'essential' THEN 0 WHEN 'pinned' THEN 1 ELSE 2 END, position"
        ))?;
        let rows = stmt.query_map([id.to_string()], tab_from_row)?;
        let mut tabs: Vec<Tab> = rows.collect::<std::result::Result<_, _>>()?;
        for tab in &mut tabs {
            self.fill_favicon(tab);
        }
        Ok(tabs)
    }

    // ----- agent threads -----

    /// The conversation held in `tab`, if there is one.
    ///
    /// Stored as one JSON document per tab rather than a row per message.
    /// The chrome owns the shape of a message -- text, steps, token usage,
    /// whether it was stopped -- and that shape changes with the agent; a
    /// column per field would mean a migration every time it did, for data
    /// nothing ever queries by field. What is wanted here is only "give me
    /// back the conversation this tab was having", and a document answers
    /// that exactly.
    pub fn agent_thread(&self, tab: TabId) -> Result<Option<AgentThread>> {
        Ok(self
            .conn
            .query_row(
                "SELECT tab_id, title, messages, updated_at FROM agent_threads WHERE tab_id = ?1",
                [tab.to_string()],
                |row| {
                    Ok(AgentThread {
                        tab_id: row.get::<_, String>(0)?,
                        title: row.get(1)?,
                        messages: row.get(2)?,
                        updated_at: row.get(3)?,
                    })
                },
            )
            .optional()?)
    }

    /// Keep `tab`'s conversation, replacing whatever was there.
    pub fn agent_thread_save(&self, tab: TabId, title: &str, messages: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO agent_threads (tab_id, title, messages, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(tab_id) DO UPDATE SET
                title = excluded.title,
                messages = excluded.messages,
                updated_at = excluded.updated_at",
            params![
                tab.to_string(),
                title,
                messages,
                Timestamp::now().to_rfc3339()
            ],
        )?;
        Ok(())
    }

    /// Throw away `tab`'s conversation. False when there was none.
    pub fn agent_thread_delete(&self, tab: TabId) -> Result<bool> {
        let n = self.conn.execute(
            "DELETE FROM agent_threads WHERE tab_id = ?1",
            [tab.to_string()],
        )?;
        Ok(n > 0)
    }

    /// Drop conversations untouched since `before`, and any whose tab is gone.
    ///
    /// The foreign key takes care of closed tabs where foreign keys are on;
    /// the explicit delete makes a database where they are off tidy too.
    pub fn agent_threads_prune(&self, before: &str) -> Result<usize> {
        let tx = self.conn.unchecked_transaction()?;
        let mut gone = tx.execute(
            "DELETE FROM agent_threads WHERE tab_id NOT IN (SELECT id FROM tabs)",
            [],
        )?;
        gone += tx.execute("DELETE FROM agent_threads WHERE updated_at < ?1", [before])?;
        tx.commit()?;
        Ok(gone)
    }

    /// Remove a tab.
    pub fn remove_tab(&self, id: TabId) -> Result<()> {
        // The scroll row cascades since v9; deleting it explicitly as well, in
        // the same transaction, keeps a database whose foreign keys are off
        // tidy without ever leaving a tab-less scroll row behind.
        let tx = self.conn.unchecked_transaction()?;
        let n = tx.execute("DELETE FROM tabs WHERE id = ?1", [id.to_string()])?;
        if n == 0 {
            return Err(CoreError::NotFound {
                kind: "tab",
                id: id.to_string(),
            });
        }
        tx.execute("DELETE FROM tab_scroll WHERE tab_id = ?1", [id.to_string()])?;
        tx.commit()?;
        Ok(())
    }

    /// Remember where `tab` was scrolled on `url`, so waking it can put the
    /// page back where the user left it.
    pub fn set_scroll(&self, tab: TabId, url: &str, x: i32, y: i32) -> Result<()> {
        self.conn.execute(
            "INSERT INTO tab_scroll (tab_id, url, x, y) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(tab_id) DO UPDATE SET url = excluded.url, x = excluded.x, y = excluded.y",
            params![tab.to_string(), url, x, y],
        )?;
        Ok(())
    }

    /// The scroll offset remembered for `tab`, if it was saved for the URL
    /// the tab still shows; a tab that moved on since gets a fresh start.
    pub fn scroll(&self, tab: TabId, url: &str) -> Result<Option<(i32, i32)>> {
        Ok(self
            .conn
            .query_row(
                "SELECT x, y FROM tab_scroll WHERE tab_id = ?1 AND url = ?2",
                params![tab.to_string(), url],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
    }

    // ----- favicons -----

    /// Remember `data` as the icon every tab on `origin` should wear, and
    /// return the key it is stored under (see [`favicon_key`]). `source`
    /// fingerprints the icon links the page declared, so a later load that
    /// declares the same ones can reuse this without fetching anything.
    ///
    /// Nothing is written when the origin already has this icon from this
    /// source, confirmed within the last day: a site that is loaded again and
    /// again must not rewrite its row every time.
    pub fn set_favicon(&self, origin: &str, data: &str, source: &str) -> Result<String> {
        let key = favicon_key(data);
        let now = Timestamp::now();
        let confirmed_after = (now - time::Duration::days(1)).to_rfc3339();
        let tx = self.conn.unchecked_transaction()?;
        tx.prepare_cached("INSERT OR IGNORE INTO favicon_images (key, data) VALUES (?1, ?2)")?
            .execute(params![key, data])?;
        tx.prepare_cached(
            "INSERT INTO favicons (origin, key, source, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(origin) DO UPDATE SET key = excluded.key, source = excluded.source,
             updated_at = excluded.updated_at
             WHERE favicons.key != excluded.key OR favicons.source != excluded.source
                OR favicons.updated_at < ?5",
        )?
        .execute(params![
            origin,
            key,
            source,
            now.to_rfc3339(),
            confirmed_after
        ])?;
        tx.commit()?;
        Ok(key)
    }

    /// Store an icon that belongs to no origin -- a `file:` page's -- and
    /// return its key. Only the tab wearing it keeps it from being pruned.
    pub fn put_favicon_image(&self, data: &str) -> Result<String> {
        let key = favicon_key(data);
        self.conn
            .prepare_cached("INSERT OR IGNORE INTO favicon_images (key, data) VALUES (?1, ?2)")?
            .execute(params![key, data])?;
        Ok(key)
    }

    /// The key of the icon remembered for `origin`, if one has ever been
    /// resolved.
    pub fn favicon(&self, origin: &str) -> Result<Option<String>> {
        self.conn
            .prepare_cached("SELECT key FROM favicons WHERE origin = ?1")?
            .query_row([origin], |r| r.get(0))
            .optional()
            .map_err(Into::into)
    }

    /// Everything remembered about `origin`'s icon: its key, the links it was
    /// resolved from, and when that was last confirmed.
    pub fn favicon_entry(&self, origin: &str) -> Result<Option<FaviconEntry>> {
        self.conn
            .prepare_cached("SELECT key, source, updated_at FROM favicons WHERE origin = ?1")?
            .query_row([origin], |r| {
                Ok(FaviconEntry {
                    key: r.get(0)?,
                    source: r.get(1)?,
                    updated_at: parse_time(&r.get::<_, String>(2)?)?,
                })
            })
            .optional()
            .map_err(Into::into)
    }

    /// The images stored under `keys`, as `(key, data: URL)` pairs. A key
    /// with no image -- one pruned since it was handed out -- is left out.
    pub fn favicon_images(&self, keys: &[String]) -> Result<Vec<(String, String)>> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT data FROM favicon_images WHERE key = ?1")?;
        let mut out = Vec::with_capacity(keys.len());
        for key in keys {
            if let Some(data) = stmt
                .query_row([key], |r| r.get::<_, String>(0))
                .optional()?
            {
                out.push((key.clone(), data));
            }
        }
        Ok(out)
    }

    /// Delete images nothing refers to any more: an origin whose icon changed
    /// leaves its old one behind, and so does a tab that was closed.
    pub fn prune_favicon_images(&self) -> Result<usize> {
        Ok(self.conn.execute(
            "DELETE FROM favicon_images
             WHERE key NOT IN (SELECT key FROM favicons)
               AND key NOT IN (SELECT favicon FROM tabs WHERE favicon IS NOT NULL)",
            [],
        )?)
    }

    /// Re-key `tab`'s icon to the site it is on now, dropping one that belongs
    /// to the origin it just left.
    ///
    /// [`Self::tab`] lends a tab its origin's icon on the way out, so a plain
    /// read-modify-write of `tab.url` would carry the old site's mark onto the
    /// new one and persist it. Anything that changes the URL runs this after.
    pub fn rekey_favicon(&self, tab: &mut Tab) {
        tab.favicon = None;
        self.fill_favicon(tab);
    }

    /// Lend `tab` its site's remembered icon when it has none of its own.
    ///
    /// This is what puts a mark on a tab restored from a previous session: the
    /// tab has no renderer yet, but its origin was resolved once before.
    fn fill_favicon(&self, tab: &mut Tab) {
        if tab.favicon.is_some() {
            return;
        }
        let Some(origin) = origin_of(&tab.url) else {
            return;
        };
        match self.favicon(&origin) {
            Ok(data) => tab.favicon = data,
            Err(e) => tracing::debug!(origin, "favicon lookup failed: {e}"),
        }
    }

    // ----- profile scope -----

    /// The profile history and bookmarks are read and written for: the one
    /// owning the active workspace, else the first profile, else "" (a
    /// database with no profiles yet, as in tests).
    ///
    /// Cached until something that could change the answer is written; see
    /// the `scope` field.
    fn scope(&self) -> Result<String> {
        if let Some(cached) = self.scope.borrow().as_ref() {
            return Ok(cached.clone());
        }
        let scope = self.read_scope()?;
        *self.scope.borrow_mut() = Some(scope.clone());
        Ok(scope)
    }

    /// Drop the cached scope; the next [`Self::scope`] reads it afresh.
    fn forget_scope(&self) {
        self.scope.borrow_mut().take();
    }

    fn read_scope(&self) -> Result<String> {
        if let Some(active) = self.setting(ACTIVE_WORKSPACE_SETTING)?
            && let Ok(id) = active.parse::<WorkspaceId>()
            && let Ok(workspace) = self.workspace(id)
        {
            return Ok(workspace.profile_id.to_string());
        }
        Ok(self
            .conn
            .query_row(
                "SELECT id FROM profiles ORDER BY position, created_at LIMIT 1",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_default())
    }

    // ----- bookmarks -----

    /// Add or refresh a bookmark.
    pub fn add_bookmark(&self, url: &str, title: &str, at: Timestamp) -> Result<()> {
        self.conn.execute(
            "INSERT INTO bookmarks (profile_id, url, title, created_at) VALUES (?4, ?1, ?2, ?3)
             ON CONFLICT(profile_id, url) DO UPDATE SET title = CASE WHEN excluded.title != '' THEN excluded.title ELSE bookmarks.title END",
            params![url, title, at.to_rfc3339(), self.scope()?],
        )?;
        Ok(())
    }

    /// Saved logins for `profile`, by site then username. The site sorts by
    /// its host, the way the list shows it: ordered by the whole origin, every
    /// `http://` login came before every `https://` one, so a local server
    /// sat above sites it should have sorted after.
    pub fn credentials(&self, profile: ProfileId) -> Result<Vec<Credential>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, profile_id, origin, username, created_at, last_used_at, uses
             FROM credentials WHERE profile_id = ?1
             ORDER BY substr(origin, instr(origin, '://') + 3), origin,
                      username COLLATE NOCASE, username",
        )?;
        let rows = stmt.query_map([profile.to_string()], credential_row)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Saved logins for one site in `profile`, most used first.
    pub fn credentials_for(&self, profile: ProfileId, origin: &str) -> Result<Vec<Credential>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, profile_id, origin, username, created_at, last_used_at, uses
             FROM credentials WHERE profile_id = ?1 AND origin = ?2 ORDER BY uses DESC, username",
        )?;
        let rows = stmt.query_map(params![profile.to_string(), origin], credential_row)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Record a login (the secret is the caller's to keep). Saving the same
    /// site and username again keeps the existing row and its id.
    pub fn upsert_credential(
        &self,
        id: &str,
        profile: ProfileId,
        origin: &str,
        username: &str,
        at: Timestamp,
    ) -> Result<Credential> {
        self.conn.execute(
            "INSERT INTO credentials (id, profile_id, origin, username, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(profile_id, origin, username) DO NOTHING",
            params![id, profile.to_string(), origin, username, at.to_rfc3339()],
        )?;
        Ok(self.conn.query_row(
            "SELECT id, profile_id, origin, username, created_at, last_used_at, uses
             FROM credentials WHERE profile_id = ?1 AND origin = ?2 AND username = ?3",
            params![profile.to_string(), origin, username],
            credential_row,
        )?)
    }

    /// Give login `id` a new username, keeping its id (and so its keychain
    /// item). Fails when the site already has a login by that name, which
    /// the unique index enforces.
    pub fn rename_credential(&self, id: &str, username: &str) -> Result<Credential> {
        self.conn.execute(
            "UPDATE credentials SET username = ?2 WHERE id = ?1",
            params![id, username],
        )?;
        Ok(self.conn.query_row(
            "SELECT id, profile_id, origin, username, created_at, last_used_at, uses
             FROM credentials WHERE id = ?1",
            [id],
            credential_row,
        )?)
    }

    /// Forget a login; returns whether one existed.
    pub fn remove_credential(&self, id: &str) -> Result<bool> {
        Ok(self
            .conn
            .execute("DELETE FROM credentials WHERE id = ?1", [id])?
            > 0)
    }

    /// Note that a login was filled just now.
    pub fn touch_credential(&self, id: &str, at: Timestamp) -> Result<()> {
        self.conn.execute(
            "UPDATE credentials SET uses = uses + 1, last_used_at = ?2 WHERE id = ?1",
            params![id, at.to_rfc3339()],
        )?;
        Ok(())
    }

    /// Every form entry in `profile`, by field then most used.
    /// Every saved address in `profile`, most used first.
    pub fn addresses(&self, profile: ProfileId) -> Result<Vec<Address>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, profile_id, label, name, organization, street, city, region,
                    postal_code, country, phone, email, created_at, last_used_at, uses
             FROM addresses WHERE profile_id = ?1 ORDER BY uses DESC, created_at DESC",
        )?;
        let rows = stmt.query_map(params![profile.to_string()], address_from_row)?;
        rows.collect::<std::result::Result<_, _>>()
            .map_err(Into::into)
    }

    /// Save an address, replacing the one with the same id.
    pub fn upsert_address(&self, address: &Address) -> Result<()> {
        self.conn.execute(
            "INSERT INTO addresses (id, profile_id, label, name, organization, street, city,
                 region, postal_code, country, phone, email, created_at, last_used_at, uses)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT(id) DO UPDATE SET label = excluded.label, name = excluded.name,
                 organization = excluded.organization, street = excluded.street,
                 city = excluded.city, region = excluded.region,
                 postal_code = excluded.postal_code, country = excluded.country,
                 phone = excluded.phone, email = excluded.email",
            params![
                address.id,
                address.profile_id,
                address.label,
                address.name,
                address.organization,
                address.street,
                address.city,
                address.region,
                address.postal_code,
                address.country,
                address.phone,
                address.email,
                address.created_at,
                address.last_used_at,
                address.uses,
            ],
        )?;
        Ok(())
    }

    /// Forget an address. False when it was not there.
    pub fn remove_address(&self, profile: ProfileId, id: &str) -> Result<bool> {
        let changed = self.conn.execute(
            "DELETE FROM addresses WHERE id = ?1 AND profile_id = ?2",
            params![id, profile.to_string()],
        )?;
        Ok(changed > 0)
    }

    /// Count one use of an address.
    pub fn address_used(&self, id: &str, at: Timestamp) -> Result<()> {
        self.conn.execute(
            "UPDATE addresses SET uses = uses + 1, last_used_at = ?2 WHERE id = ?1",
            params![id, at.to_rfc3339()],
        )?;
        Ok(())
    }

    /// Every saved card in `profile`, most used first. Numbers are not here.
    pub fn cards(&self, profile: ProfileId) -> Result<Vec<Card>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, profile_id, label, cardholder, last4, brand, expiry_month, expiry_year,
                    created_at, last_used_at, uses
             FROM cards WHERE profile_id = ?1 ORDER BY uses DESC, created_at DESC",
        )?;
        let rows = stmt.query_map(params![profile.to_string()], card_from_row)?;
        rows.collect::<std::result::Result<_, _>>()
            .map_err(Into::into)
    }

    /// Save a card's listing row. The number belongs in the keychain.
    pub fn upsert_card(&self, card: &Card) -> Result<()> {
        self.conn.execute(
            "INSERT INTO cards (id, profile_id, label, cardholder, last4, brand,
                 expiry_month, expiry_year, created_at, last_used_at, uses)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET label = excluded.label,
                 cardholder = excluded.cardholder, last4 = excluded.last4,
                 brand = excluded.brand, expiry_month = excluded.expiry_month,
                 expiry_year = excluded.expiry_year",
            params![
                card.id,
                card.profile_id,
                card.label,
                card.cardholder,
                card.last4,
                card.brand,
                card.expiry_month,
                card.expiry_year,
                card.created_at,
                card.last_used_at,
                card.uses,
            ],
        )?;
        Ok(())
    }

    /// Forget a card's row. False when it was not there; the caller clears
    /// the keychain item.
    pub fn remove_card(&self, profile: ProfileId, id: &str) -> Result<bool> {
        let changed = self.conn.execute(
            "DELETE FROM cards WHERE id = ?1 AND profile_id = ?2",
            params![id, profile.to_string()],
        )?;
        Ok(changed > 0)
    }

    /// Count one use of a card.
    pub fn card_used(&self, id: &str, at: Timestamp) -> Result<()> {
        self.conn.execute(
            "UPDATE cards SET uses = uses + 1, last_used_at = ?2 WHERE id = ?1",
            params![id, at.to_rfc3339()],
        )?;
        Ok(())
    }

    /// Everything remembered from forms in `profile`.
    pub fn form_entries(&self, profile: ProfileId) -> Result<Vec<FormEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, profile_id, field, value, uses, last_used_at FROM form_entries
             WHERE profile_id = ?1 ORDER BY field, uses DESC, value",
        )?;
        let rows = stmt.query_map([profile.to_string()], form_entry_row)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Entries for one field whose value starts with `prefix` (case-folded),
    /// most used first, at most `limit`.
    pub fn form_entries_for(
        &self,
        profile: ProfileId,
        field: &str,
        prefix: &str,
        limit: usize,
    ) -> Result<Vec<FormEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, profile_id, field, value, uses, last_used_at FROM form_entries
             WHERE profile_id = ?1 AND field = ?2 AND lower(value) LIKE ?3 ESCAPE '\\'
             ORDER BY uses DESC, last_used_at DESC, value LIMIT ?4",
        )?;
        let escaped = prefix
            .to_lowercase()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let rows = stmt.query_map(
            params![
                profile.to_string(),
                field.to_lowercase(),
                format!("{escaped}%"),
                i64::try_from(limit).unwrap_or(i64::MAX)
            ],
            form_entry_row,
        )?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Remember that `value` was submitted in `field`; a repeat counts a use.
    pub fn record_form_entry(
        &self,
        profile: ProfileId,
        field: &str,
        value: &str,
        at: Timestamp,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO form_entries (id, profile_id, field, value, uses, last_used_at)
             VALUES (?1, ?2, ?3, ?4, 1, ?5)
             ON CONFLICT(profile_id, field, value) DO UPDATE SET
                 uses = uses + 1, last_used_at = excluded.last_used_at",
            params![
                uuid::Uuid::now_v7().to_string(),
                profile.to_string(),
                field.to_lowercase(),
                value,
                at.to_rfc3339()
            ],
        )?;
        Ok(())
    }

    /// Add entries from another browser, skipping any already here.
    /// Returns how many were new.
    pub fn import_form_entries(
        &self,
        profile: ProfileId,
        entries: &[ImportedFormEntry],
    ) -> Result<usize> {
        let tx = self.conn.unchecked_transaction()?;
        let mut added = 0;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO form_entries (id, profile_id, field, value, uses, last_used_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(profile_id, field, value) DO NOTHING",
            )?;
            for e in entries {
                added += stmt.execute(params![
                    uuid::Uuid::now_v7().to_string(),
                    profile.to_string(),
                    e.field.to_lowercase(),
                    e.value,
                    e.uses.max(1),
                    e.last_used_at.map(Timestamp::to_rfc3339)
                ])?;
            }
        }
        tx.commit()?;
        Ok(added)
    }

    /// Forget one entry; returns whether it existed.
    pub fn remove_form_entry(&self, id: &str) -> Result<bool> {
        Ok(self
            .conn
            .execute("DELETE FROM form_entries WHERE id = ?1", [id])?
            > 0)
    }

    /// Forget every entry in `profile`; returns how many there were.
    pub fn clear_form_entries(&self, profile: ProfileId) -> Result<usize> {
        Ok(self.conn.execute(
            "DELETE FROM form_entries WHERE profile_id = ?1",
            [profile.to_string()],
        )?)
    }

    /// Remove a bookmark; returns whether one existed.
    pub fn remove_bookmark(&self, url: &str) -> Result<bool> {
        Ok(self.conn.execute(
            "DELETE FROM bookmarks WHERE url = ?1 AND profile_id = ?2",
            params![url, self.scope()?],
        )? > 0)
    }

    /// Whether `url` is bookmarked.
    pub fn is_bookmarked(&self, url: &str) -> Result<bool> {
        Ok(self
            .conn
            .query_row(
                "SELECT 1 FROM bookmarks WHERE url = ?1 AND profile_id = ?2",
                params![url, self.scope()?],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// Bookmarks matching `query`, newest first.
    /// Every bookmark in the active profile, newest first.
    ///
    /// A search asks for a page of matches; a backup asks for all of them,
    /// which is why this is not `search_bookmarks("")`.
    pub fn all_bookmarks(&self) -> Result<Vec<Bookmark>> {
        let mut stmt = self.conn.prepare(
            "SELECT url, title, created_at FROM bookmarks
             WHERE profile_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map(params![self.scope()?], |r| {
            Ok(Bookmark {
                url: r.get(0)?,
                title: r.get(1)?,
                created_at: r.get(2)?,
                favicon: None,
            })
        })?;
        rows.collect::<std::result::Result<_, _>>()
            .map_err(Into::into)
    }

    /// Every page in the active profile's history, one row per address,
    /// newest first, up to `limit`.
    pub fn all_history(&self, limit: usize) -> Result<Vec<HistoryEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT url, title, last_visit, visit_count FROM urls
             WHERE profile_id = ?1 ORDER BY last_visit DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(
            params![self.scope()?, i64::try_from(limit).unwrap_or(i64::MAX)],
            |r| {
                Ok(HistoryEntry {
                    url: r.get(0)?,
                    title: r.get(1)?,
                    last_visited_at: r.get(2)?,
                    visits: r.get::<_, i64>(3)?.try_into().unwrap_or(u32::MAX),
                    favicon: None,
                })
            },
        )?;
        rows.collect::<std::result::Result<_, _>>()
            .map_err(Into::into)
    }

    /// Bookmarks whose address or title contains `query`, newest first.
    pub fn search_bookmarks(&self, query: &str, limit: usize) -> Result<Vec<Bookmark>> {
        let like = format!("%{}%", like_escape(query.trim()));
        let mut stmt = self.conn.prepare(
            "SELECT url, title, created_at FROM bookmarks
             WHERE profile_id = ?3 AND (url LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\')
             ORDER BY created_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(
            params![
                like,
                i64::try_from(limit).unwrap_or(i64::MAX),
                self.scope()?
            ],
            |r| {
                Ok(Bookmark {
                    url: r.get(0)?,
                    title: r.get(1)?,
                    created_at: r.get(2)?,
                    favicon: None,
                })
            },
        )?;
        let mut found: Vec<Bookmark> = rows.collect::<std::result::Result<_, _>>()?;
        for b in &mut found {
            b.favicon = self.site_favicon(&b.url);
        }
        Ok(found)
    }

    /// Install or update a web app for the current profile.
    pub fn add_web_app(&self, app: &WebApp) -> Result<()> {
        self.conn.execute(
            "INSERT INTO web_apps (profile_id, id, name, short_name, start_url, scope, display,
                theme_color, background_color, icon_path, manifest_url, created_at, last_opened_at, bounds,
                workspace_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT(profile_id, id) DO UPDATE SET
                name = excluded.name, short_name = excluded.short_name,
                start_url = excluded.start_url, scope = excluded.scope, display = excluded.display,
                theme_color = excluded.theme_color, background_color = excluded.background_color,
                icon_path = excluded.icon_path, manifest_url = excluded.manifest_url,
                workspace_id = COALESCE(excluded.workspace_id, web_apps.workspace_id)",
            params![
                self.scope()?,
                app.id,
                app.name,
                app.short_name,
                app.start_url,
                app.scope,
                app.display,
                app.theme_color,
                app.background_color,
                app.icon_path,
                app.manifest_url,
                app.created_at,
                app.last_opened_at,
                app.bounds,
                app.workspace_id.map(|id| id.to_string()),
            ],
        )?;
        Ok(())
    }

    /// Installed web apps for the current profile, most recently opened first.
    pub fn list_web_apps(&self) -> Result<Vec<WebApp>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, short_name, start_url, scope, display, theme_color, background_color,
                    icon_path, manifest_url, created_at, last_opened_at, bounds, workspace_id
             FROM web_apps WHERE profile_id = ?1
             ORDER BY COALESCE(last_opened_at, created_at) DESC, name",
        )?;
        let rows = stmt.query_map(params![self.scope()?], web_app_row)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    /// One installed web app, by manifest id.
    pub fn web_app(&self, id: &str) -> Result<Option<WebApp>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, short_name, start_url, scope, display, theme_color, background_color,
                    icon_path, manifest_url, created_at, last_opened_at, bounds, workspace_id
             FROM web_apps WHERE profile_id = ?1 AND id = ?2",
        )?;
        let mut rows = stmt.query_map(params![self.scope()?, id], web_app_row)?;
        rows.next().transpose().map_err(Into::into)
    }

    /// The installed app whose scope covers `url`, if any. The longest scope
    /// wins when several nest, the way Chrome resolves it.
    pub fn web_app_for_url(&self, url: &str) -> Result<Option<WebApp>> {
        Ok(self
            .list_web_apps()?
            .into_iter()
            .filter(|app| url.starts_with(&app.scope))
            .max_by_key(|app| app.scope.len()))
    }

    /// Remove an installed web app. Returns whether there was one.
    pub fn remove_web_app(&self, id: &str) -> Result<bool> {
        let changed = self.conn.execute(
            "DELETE FROM web_apps WHERE profile_id = ?1 AND id = ?2",
            params![self.scope()?, id],
        )?;
        Ok(changed > 0)
    }

    /// Record that an app was opened now.
    pub fn touch_web_app(&self, id: &str, at: Timestamp) -> Result<()> {
        self.conn.execute(
            "UPDATE web_apps SET last_opened_at = ?3 WHERE profile_id = ?1 AND id = ?2",
            params![self.scope()?, id, at.to_rfc3339()],
        )?;
        Ok(())
    }

    /// Remember an app window's last windowed frame.
    pub fn set_web_app_bounds(&self, id: &str, bounds: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE web_apps SET bounds = ?3 WHERE profile_id = ?1 AND id = ?2",
            params![self.scope()?, id, bounds],
        )?;
        Ok(())
    }

    /// Bring bookmarks in from another browser. A URL already bookmarked
    /// keeps its own row; returns how many were new.
    pub fn import_bookmarks(&self, items: &[ImportedEntry]) -> Result<usize> {
        let tx = self.conn.unchecked_transaction()?;
        let mut added = 0;
        {
            let scope = self.scope()?;
            let mut stmt = tx.prepare(
                "INSERT OR IGNORE INTO bookmarks (profile_id, url, title, created_at) VALUES (?4, ?1, ?2, ?3)",
            )?;
            for item in items {
                added +=
                    stmt.execute(params![item.url, item.title, item.at.to_rfc3339(), scope])?;
            }
        }
        tx.commit()?;
        Ok(added)
    }

    /// Bring visits in from another browser. A visit to the same URL at the
    /// same time is already here (a second import, say) and is skipped;
    /// returns how many were new.
    pub fn import_history(&self, items: &[ImportedEntry]) -> Result<usize> {
        let tx = self.conn.unchecked_transaction()?;
        let mut added = 0;
        {
            let scope = self.scope()?;
            let mut stmt = tx.prepare(
                "INSERT INTO history (profile_id, url, title, visited_at)
                 SELECT ?4, ?1, ?2, ?3
                 WHERE NOT EXISTS (SELECT 1 FROM history WHERE profile_id = ?4 AND url = ?1 AND visited_at = ?3)",
            )?;
            for item in items {
                let at = item.at.to_rfc3339();
                let new = stmt.execute(params![item.url, item.title, at, scope])?;
                if new > 0 {
                    self.count_visit(&scope, &item.url, &item.title, &at)?;
                }
                added += new;
            }
        }
        tx.commit()?;
        Ok(added)
    }

    // ----- history -----

    /// Record a visit. Same URL within a minute is the visit already filed,
    /// which it can only name. "about:blank" is never filed as a title: it
    /// names the empty document, not the page.
    pub fn record_visit(&self, url: &str, title: &str, at: Timestamp) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        self.record_visit_in(url, title, at)?;
        tx.commit()?;
        Ok(())
    }

    /// [`Self::record_visit`] without a transaction of its own, for callers
    /// that already hold one.
    fn record_visit_in(&self, url: &str, title: &str, at: Timestamp) -> Result<()> {
        let title = if title == BLANK_TITLE { "" } else { title };
        let scope = self.scope()?;
        let last: Option<String> = self
            .conn
            .prepare_cached(
                "SELECT last_visit FROM urls WHERE profile_id = ?1 AND url_hash = ?2 AND url = ?3",
            )?
            .query_row(params![scope, url_hash(url), url], |r| r.get(0))
            .optional()?;
        let fresh = last
            .and_then(|t| Timestamp::parse(&t).ok())
            .is_some_and(|t| (at.0 - t.0).abs() < time::Duration::minutes(1));
        if fresh {
            // A reload, or a redirect that came straight back: the visit is
            // already here, and all this can add is its name.
            self.title_visit_in(url, title)?;
            return Ok(());
        }
        let at = at.to_rfc3339();
        self.conn
            .prepare_cached(
                "INSERT INTO history (profile_id, url, title, visited_at) VALUES (?1, ?2, ?3, ?4)",
            )?
            .execute(params![scope, url, title, at])?;
        self.count_visit(&scope, url, title, &at)
    }

    /// Name the latest visit to `url` `title`, if it has no name yet; true
    /// when it did. A visit keeps the first real title it is given, so a
    /// page that keeps retitling itself writes nothing after that.
    fn title_visit_in(&self, url: &str, title: &str) -> Result<bool> {
        if title.is_empty() || title == BLANK_TITLE {
            return Ok(false);
        }
        let scope = self.scope()?;
        // `+profile_id` keeps SQLite on the address index. Left to choose, it
        // walks the profile's index newest-first until it meets this address,
        // which for a page last seen weeks ago is the whole log.
        let named = self
            .conn
            .prepare_cached(
                "UPDATE history SET title = ?1 WHERE title = '' AND id = (
                     SELECT id FROM history WHERE url = ?2 AND +profile_id = ?3
                     ORDER BY visited_at DESC LIMIT 1)",
            )?
            .execute(params![title, url, scope])?;
        if named > 0 {
            self.conn
                .prepare_cached(
                    "UPDATE urls SET title = ?1
                     WHERE profile_id = ?3 AND url_hash = ?4 AND url = ?2",
                )?
                .execute(params![title, url, scope, url_hash(url)])?;
        }
        Ok(named > 0)
    }

    /// Count one visit to `url` at `at` (RFC 3339) in the per-address table.
    /// The newest non-empty title wins; a visit older than the latest one
    /// (an import) names the row only if it has no name.
    fn count_visit(&self, scope: &str, url: &str, title: &str, at: &str) -> Result<()> {
        let hash = url_hash(url);
        let row: Option<i64> = self
            .conn
            .prepare_cached(
                "SELECT id FROM urls WHERE profile_id = ?1 AND url_hash = ?2 AND url = ?3",
            )?
            .query_row(params![scope, hash, url], |r| r.get(0))
            .optional()?;
        match row {
            Some(id) => self
                .conn
                .prepare_cached(
                    "UPDATE urls SET
                        visit_count = visit_count + 1,
                        title = CASE
                            WHEN ?2 != '' AND (title = '' OR ?3 >= last_visit) THEN ?2
                            ELSE title END,
                        last_visit = MAX(last_visit, ?3)
                     WHERE id = ?1",
                )?
                .execute(params![id, title, at])?,
            None => self
                .conn
                .prepare_cached(
                    "INSERT INTO urls (profile_id, url, url_hash, key_hash, title, last_visit, visit_count)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)",
                )?
                .execute(params![scope, url, hash, url_hash(url_key(url)), title, at])?,
        };
        Ok(())
    }

    /// Open tab count per workspace, including tabs whose renderer was discarded.
    /// Global essential tabs have no workspace and are counted separately.
    pub fn tab_counts(&self) -> Result<Vec<(WorkspaceId, u32)>> {
        let mut stmt = self.conn.prepare(
            "SELECT workspace_id, COUNT(*) FROM tabs
             WHERE workspace_id IS NOT NULL
             GROUP BY workspace_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                parse_id(&r.get::<_, String>(0)?)?,
                r.get::<_, i64>(1)?.try_into().unwrap_or(u32::MAX),
            ))
        })?;
        rows.collect::<std::result::Result<_, _>>()
            .map_err(Into::into)
    }

    /// Forget every visit to `url` and to its twins -- the addresses shown as
    /// the same row, see [`url_key`] -- so the row a person removed does not
    /// come back as the twin it was hiding. Returns how many visits went.
    pub fn remove_history(&self, url: &str) -> Result<usize> {
        let scope = self.scope()?;
        let key = url_key(url);
        let tx = self.conn.unchecked_transaction()?;
        let mut twins: Vec<String> = {
            let mut stmt =
                tx.prepare("SELECT url FROM urls WHERE profile_id = ?1 AND key_hash = ?2")?;
            let rows = stmt.query_map(params![scope, url_hash(key)], |r| r.get::<_, String>(0))?;
            let mut twins = Vec::new();
            for twin in rows {
                let twin = twin?;
                // The hash only narrows the search; the key decides.
                if url_key(&twin) == key {
                    twins.push(twin);
                }
            }
            twins
        };
        if !twins.iter().any(|twin| twin == url) {
            twins.push(url.to_owned());
        }
        let mut gone = 0;
        for twin in &twins {
            gone += tx.execute(
                "DELETE FROM history WHERE url = ?1 AND +profile_id = ?2",
                params![twin, scope],
            )?;
            tx.execute(
                "DELETE FROM urls WHERE profile_id = ?1 AND url_hash = ?2 AND url = ?3",
                params![scope, url_hash(twin), twin],
            )?;
        }
        tx.commit()?;
        Ok(gone)
    }

    /// Delete every visit of this profile; returns how many rows went.
    pub fn clear_history(&self) -> Result<usize> {
        let scope = self.scope()?;
        let tx = self.conn.unchecked_transaction()?;
        let gone = tx.execute("DELETE FROM history WHERE profile_id = ?1", [&scope])?;
        tx.execute("DELETE FROM urls WHERE profile_id = ?1", [&scope])?;
        tx.commit()?;
        Ok(gone)
    }

    /// Forget every cached site icon. Icons record which origins were
    /// visited, so clearing history clears them too. An icon an open tab is
    /// still wearing stays until that tab lets it go.
    pub fn clear_favicons(&self) -> Result<usize> {
        let tx = self.conn.unchecked_transaction()?;
        let gone = tx.execute("DELETE FROM favicons", [])?;
        tx.execute(
            "DELETE FROM favicon_images
             WHERE key NOT IN (SELECT favicon FROM tabs WHERE favicon IS NOT NULL)",
            [],
        )?;
        tx.commit()?;
        Ok(gone)
    }

    /// Delete visits older than `cutoff` in every profile; returns how many
    /// rows went.
    ///
    /// Every profile, not only the active one: retention is the browser's
    /// setting, and a profile nobody had switched to kept every visit it
    /// ever made.
    pub fn prune_history(&self, cutoff: Timestamp) -> Result<usize> {
        let cutoff = cutoff.to_rfc3339();
        let tx = self.conn.unchecked_transaction()?;
        let touched: Vec<(String, String)> = {
            let mut stmt =
                tx.prepare("SELECT DISTINCT profile_id, url FROM history WHERE visited_at < ?1")?;
            let rows = stmt.query_map([&cutoff], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        let gone = tx.execute("DELETE FROM history WHERE visited_at < ?1", [&cutoff])?;
        {
            let mut left = tx.prepare(
                "SELECT COUNT(*), MAX(visited_at) FROM history WHERE url = ?2 AND +profile_id = ?1",
            )?;
            let mut forget = tx
                .prepare("DELETE FROM urls WHERE profile_id = ?1 AND url_hash = ?3 AND url = ?2")?;
            let mut recount = tx.prepare(
                "UPDATE urls SET visit_count = ?4, last_visit = ?5
                 WHERE profile_id = ?1 AND url_hash = ?3 AND url = ?2",
            )?;
            for (profile, url) in &touched {
                let (count, last): (i64, Option<String>) =
                    left.query_row(params![profile, url], |r| Ok((r.get(0)?, r.get(1)?)))?;
                let hash = url_hash(url);
                match last {
                    Some(last) if count > 0 => {
                        recount.execute(params![profile, url, hash, count, last])?
                    }
                    _ => forget.execute(params![profile, url, hash])?,
                };
            }
        }
        tx.commit()?;
        Ok(gone)
    }

    /// Pages in history matching `query` (a substring of the address or the
    /// title), best first, one row per page.
    ///
    /// With no query the list is simply the most recent pages, which is what
    /// the palette and the Library show before anything is typed. With one,
    /// rows are ranked by [`frecency`]: a site visited every day outranks a
    /// page seen once this morning, and a page whose address begins with what
    /// was typed -- `git` for github.com -- outranks one that only mentions
    /// it somewhere.
    ///
    /// Twins -- addresses that differ only in a fragment or a trailing slash,
    /// see [`url_key`] -- are one row: the newest address, with the visits of
    /// all of them. Addresses that differ in anything else stay apart even
    /// when their titles match, since many different pages share a title
    /// ("Vite App").
    pub fn search_history(&self, query: &str, limit: usize) -> Result<Vec<HistoryEntry>> {
        let query = query.trim();
        let like = format!("%{}%", like_escape(query));
        let mut stmt = self.conn.prepare_cached(
            "SELECT url, title, last_visit, visit_count FROM urls
             WHERE profile_id = ?3 AND (url LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\')
             ORDER BY last_visit DESC LIMIT ?2",
        )?;
        // With a query every match is a candidate for the ranking, up to a
        // bound that keeps a one-letter query cheap. Without one the order
        // is the table's own, and a little headroom covers collapsed twins.
        let fetch = if query.is_empty() {
            limit.saturating_mul(4).clamp(limit, HISTORY_CANDIDATES)
        } else {
            HISTORY_CANDIDATES
        };
        let rows = stmt.query_map(
            params![
                like,
                i64::try_from(fetch).unwrap_or(i64::MAX),
                self.scope()?
            ],
            |r| {
                Ok(HistoryEntry {
                    url: r.get(0)?,
                    title: r.get(1)?,
                    last_visited_at: r.get(2)?,
                    visits: r.get::<_, i64>(3)?.try_into().unwrap_or(u32::MAX),
                    favicon: None,
                })
            },
        )?;

        let mut pages: Vec<HistoryEntry> = Vec::new();
        let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for entry in rows {
            let entry = entry?;
            let key = url_key(&entry.url).to_owned();
            // Rows arrive newest first, so the page on screen is the newest
            // twin; the older ones lend it their visits, and their title when
            // it has none.
            if let Some(&i) = seen.get(&key) {
                let page = &mut pages[i];
                page.visits = page.visits.saturating_add(entry.visits);
                if page.title.is_empty() {
                    page.title = entry.title;
                }
            } else {
                seen.insert(key, pages.len());
                pages.push(entry);
            }
        }
        if !query.is_empty() {
            let now = Timestamp::now();
            let needle = query.to_lowercase();
            let score = |page: &HistoryEntry| {
                let age = Timestamp::parse(&page.last_visited_at)
                    .map_or(time::Duration::days(365), |at| now.0 - at.0);
                let boost = if address_starts_with(&page.url, &needle) {
                    HOST_MATCH_BOOST
                } else {
                    1.0
                };
                frecency(page.visits, age) * boost
            };
            let mut scored: Vec<(f64, HistoryEntry)> =
                pages.into_iter().map(|p| (score(&p), p)).collect();
            // Stable, and the rows are newest first: equal scores keep that.
            scored.sort_by(|a, b| b.0.total_cmp(&a.0));
            pages = scored.into_iter().map(|(_, p)| p).collect();
        }
        pages.truncate(limit);
        for page in &mut pages {
            page.favicon = self.site_favicon(&page.url);
        }
        Ok(pages)
    }

    /// The key of the icon remembered for `url`'s origin, if any.
    ///
    /// Lets a history or bookmark row wear its site's mark even though no tab
    /// is open on it, which is the only source of an icon for a page that is
    /// not currently loaded anywhere.
    fn site_favicon(&self, url: &str) -> Option<String> {
        let origin = crate::origin_of(url)?;
        self.favicon(&origin)
            .inspect_err(|e| tracing::debug!(origin, "favicon lookup failed: {e}"))
            .ok()
            .flatten()
    }

    // ----- settings -----

    /// Read a setting.
    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        self.conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(Into::into)
    }

    /// Every setting whose key starts with `prefix`, as `(key, value)` pairs.
    pub fn settings_with_prefix(&self, prefix: &str) -> Result<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT key, value FROM settings WHERE key LIKE ?1 ESCAPE '\\' ORDER BY key",
        )?;
        let pattern = format!("{}%", like_escape(prefix));
        let rows = stmt.query_map([pattern], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Forget a setting; `Ok(false)` when there was none.
    pub fn remove_setting(&self, key: &str) -> Result<bool> {
        self.forget_scope();
        Ok(self
            .conn
            .execute("DELETE FROM settings WHERE key = ?1", [key])?
            == 1)
    }

    /// Origins explicitly exempted from automatic discard in one profile.
    pub fn keep_active_sites(&self, profile: ProfileId) -> Result<Vec<String>> {
        self.profile(profile)?;
        let prefix = format!("keep_active:{profile}:");
        Ok(self
            .settings_with_prefix(&prefix)?
            .into_iter()
            .filter(|(_, value)| value == "1")
            .map(|(key, _)| key[prefix.len()..].to_owned())
            .collect())
    }

    /// Persist a site exemption, canonicalized to its HTTP(S) origin.
    pub fn set_keep_active_site(&self, profile: ProfileId, url: &str, keep: bool) -> Result<()> {
        self.profile(profile)?;
        let parsed = url::Url::parse(url)
            .map_err(|_| crate::CoreError::Invalid("Enter an HTTP or HTTPS site URL".into()))?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err(crate::CoreError::Invalid(
                "Enter an HTTP or HTTPS site URL".into(),
            ));
        }
        let key = format!(
            "keep_active:{profile}:{}",
            parsed.origin().ascii_serialization()
        );
        if keep {
            self.set_setting(&key, "1")
        } else {
            self.remove_setting(&key).map(|_| ())
        }
    }

    /// Update activity without overwriting concurrent tab metadata.
    pub fn touch_tab_activity(&self, tab: TabId, now: Timestamp) -> Result<()> {
        self.conn.execute("UPDATE tabs SET last_active_at = ?2 WHERE id = ?1 AND state != 'discarded' AND last_active_at < ?2",
            params![tab.to_string(), now.to_rfc3339()])?;
        Ok(())
    }

    /// Write a setting.
    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.forget_scope();
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }

    /// Write a related set of settings as one all-or-nothing decision.
    pub fn set_settings_atomic(&self, entries: &[(String, String)]) -> Result<()> {
        self.forget_scope();
        let transaction = self.conn.unchecked_transaction()?;
        for (key, value) in entries {
            transaction.execute("INSERT INTO settings (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[key,value])?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// The most recently active open tab of `workspace`, if any.
    /// Discarded tabs remain open and recreate their renderer when activated.
    pub fn last_active_tab(&self, workspace: WorkspaceId) -> Result<Option<Tab>> {
        let mut tab = self
            .conn
            .query_row(
                &format!(
                    "{TAB_SELECT} WHERE workspace_id = ?1
                     ORDER BY last_active_at DESC LIMIT 1"
                ),
                [workspace.to_string()],
                tab_from_row,
            )
            .optional()?;
        if let Some(t) = tab.as_mut() {
            self.fill_favicon(t);
        }
        Ok(tab)
    }

    /// Move `Today` tabs idle longer than `max_idle` to `Discarded`; returns how many.
    pub fn archive_idle_tabs(&self, now: Timestamp, max_idle: time::Duration) -> Result<usize> {
        Ok(self.discard_idle_tabs(now, max_idle)?.len())
    }

    /// `Today` tabs in every workspace that have sat unfocused longer than
    /// `max_idle` and are still alive. The sweep decides which of these it
    /// may actually discard.
    pub fn idle_tab_candidates(
        &self,
        now: Timestamp,
        max_idle: time::Duration,
    ) -> Result<Vec<Tab>> {
        let cutoff = (now - max_idle).to_rfc3339();
        let mut stmt = self.conn.prepare(&format!(
            "{TAB_SELECT} WHERE tier = 'today' AND state != 'discarded' AND last_active_at < ?1
             ORDER BY last_active_at"
        ))?;
        let rows = stmt.query_map([&cutoff], tab_from_row)?;
        let mut tabs: Vec<Tab> = rows.collect::<std::result::Result<_, _>>()?;
        for tab in &mut tabs {
            self.fill_favicon(tab);
        }
        Ok(tabs)
    }

    /// Mark `ids` discarded and return them as they now read. Ids that no
    /// longer exist are skipped rather than reported.
    pub fn discard_tabs(&self, ids: &[TabId]) -> Result<Vec<Tab>> {
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            let n = self.conn.execute(
                "UPDATE tabs SET state = 'discarded' WHERE id = ?1 AND state != 'discarded'",
                [id.to_string()],
            )?;
            if n == 1 {
                out.push(self.tab(*id)?);
            }
        }
        Ok(out)
    }

    /// Validate and save wake state before requesting native close. The row
    /// remains active until a separate native destruction receipt arrives.
    pub fn prepare_discard(
        &self,
        candidate: &Tab,
        cutoff: Timestamp,
        scroll: (i32, i32),
        close: impl FnOnce() -> Result<()>,
    ) -> Result<bool> {
        self.transition_candidate(candidate, cutoff, scroll, false, close)
            .map(|tab| tab.is_some())
    }

    /// Conditionally finalize discard after native destruction was confirmed.
    pub fn discard_candidate(
        &self,
        candidate: &Tab,
        cutoff: Timestamp,
        scroll: (i32, i32),
        close: impl FnOnce() -> Result<()>,
    ) -> Result<Option<Tab>> {
        self.transition_candidate(candidate, cutoff, scroll, true, close)
    }

    fn transition_candidate(
        &self,
        candidate: &Tab,
        cutoff: Timestamp,
        scroll: (i32, i32),
        discard: bool,
        close: impl FnOnce() -> Result<()>,
    ) -> Result<Option<Tab>> {
        let transaction = self.conn.unchecked_transaction()?;
        let changed = transaction.execute(
            "UPDATE tabs SET state = CASE WHEN ?7 THEN 'discarded' ELSE state END
             WHERE id = ?1 AND tier = 'today' AND state = ?2 AND state != 'discarded'
             AND url = ?3 AND workspace_id IS ?4 AND last_active_at = ?5 AND last_active_at < ?6",
            params![
                candidate.id.to_string(),
                candidate.state.as_str(),
                candidate.url,
                candidate.workspace_id.map(|id| id.to_string()),
                candidate.last_active_at.to_rfc3339(),
                cutoff.to_rfc3339(),
                discard
            ],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        self.set_scroll(candidate.id, &candidate.url, scroll.0, scroll.1)?;
        close()?;
        transaction.commit()?;
        self.tab(candidate.id).map(Some)
    }

    /// Discard every idle candidate at once, with no engine-side exclusions.
    /// Offline store convenience; the live app uses prepare/receipt/finalize.
    pub fn discard_idle_tabs(&self, now: Timestamp, max_idle: time::Duration) -> Result<Vec<Tab>> {
        let ids: Vec<TabId> = self
            .idle_tab_candidates(now, max_idle)?
            .into_iter()
            .map(|t| t.id)
            .collect();
        self.discard_tabs(&ids)
    }
}

const CONTAINER_SELECT: &str = "SELECT id, name, cache_dir, persist_cookies FROM containers";
const WORKSPACE_SELECT: &str =
    "SELECT id, name, color, icon, container_id, position, created_at, profile_id FROM workspaces";
const PROFILE_SELECT: &str =
    "SELECT id, name, color, avatar, note, container_id, position, created_at FROM profiles";
const TAB_SELECT: &str =
    "SELECT id, workspace_id, tier, url, title, position, state, last_active_at, favicon FROM tabs";

/// Scheme and authority of `url`, the key an icon is remembered under.
pub fn origin_of(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    // Opaque origins (`data:`, `about:`) serialize to "null"; nothing to key on.
    let origin = parsed.origin();
    origin.is_tuple().then(|| origin.ascii_serialization())
}

fn conversion(e: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
}

fn parse_time(s: &str) -> rusqlite::Result<Timestamp> {
    Timestamp::parse(s).map_err(conversion)
}

fn parse_id<T: std::str::FromStr<Err = uuid::Error>>(s: &str) -> rusqlite::Result<T> {
    s.parse().map_err(conversion)
}

fn invalid(what: &str) -> rusqlite::Error {
    rusqlite::Error::InvalidColumnType(0, what.to_owned(), rusqlite::types::Type::Text)
}

fn container_from_row(r: &Row<'_>) -> rusqlite::Result<Container> {
    Ok(Container {
        id: parse_id(&r.get::<_, String>(0)?)?,
        name: r.get(1)?,
        cache_dir: r.get(2)?,
        persist_cookies: r.get(3)?,
    })
}

/// Quote the characters `LIKE` treats as wildcards, so a query for `100%`
/// or `a_b` matches those characters rather than anything. Pair with
/// `ESCAPE '\\'` in the statement.
fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn workspace_from_row(r: &Row<'_>) -> rusqlite::Result<Workspace> {
    Ok(Workspace {
        id: parse_id(&r.get::<_, String>(0)?)?,
        name: r.get(1)?,
        color: r.get(2)?,
        icon: r.get(3)?,
        container_id: parse_id(&r.get::<_, String>(4)?)?,
        position: r.get(5)?,
        created_at: parse_time(&r.get::<_, String>(6)?)?,
        profile_id: parse_id(&r.get::<_, String>(7)?)?,
    })
}

fn profile_from_row(r: &Row<'_>) -> rusqlite::Result<Profile> {
    Ok(Profile {
        id: parse_id(&r.get::<_, String>(0)?)?,
        name: r.get(1)?,
        color: r.get(2)?,
        avatar: r.get(3)?,
        note: r.get(4)?,
        container_id: parse_id(&r.get::<_, String>(5)?)?,
        position: r.get(6)?,
        created_at: parse_time(&r.get::<_, String>(7)?)?,
    })
}

fn address_from_row(r: &Row<'_>) -> rusqlite::Result<Address> {
    Ok(Address {
        id: r.get(0)?,
        profile_id: r.get(1)?,
        label: r.get(2)?,
        name: r.get(3)?,
        organization: r.get(4)?,
        street: r.get(5)?,
        city: r.get(6)?,
        region: r.get(7)?,
        postal_code: r.get(8)?,
        country: r.get(9)?,
        phone: r.get(10)?,
        email: r.get(11)?,
        created_at: r.get(12)?,
        last_used_at: r.get(13)?,
        uses: r.get::<_, i64>(14)?.try_into().unwrap_or(u32::MAX),
    })
}

fn card_from_row(r: &Row<'_>) -> rusqlite::Result<Card> {
    Ok(Card {
        id: r.get(0)?,
        profile_id: r.get(1)?,
        label: r.get(2)?,
        cardholder: r.get(3)?,
        last4: r.get(4)?,
        brand: r.get(5)?,
        expiry_month: r.get::<_, i64>(6)?.try_into().unwrap_or(0),
        expiry_year: r.get::<_, i64>(7)?.try_into().unwrap_or(0),
        created_at: r.get(8)?,
        last_used_at: r.get(9)?,
        uses: r.get::<_, i64>(10)?.try_into().unwrap_or(u32::MAX),
    })
}

fn tab_from_row(r: &Row<'_>) -> rusqlite::Result<Tab> {
    let tier: String = r.get(2)?;
    let state: String = r.get(6)?;
    Ok(Tab {
        id: parse_id(&r.get::<_, String>(0)?)?,
        workspace_id: r
            .get::<_, Option<String>>(1)?
            .map(|s| parse_id(&s))
            .transpose()?,
        tier: TabTier::parse(&tier).ok_or_else(|| invalid("tier"))?,
        url: r.get(3)?,
        title: r.get(4)?,
        position: r.get(5)?,
        state: TabState::parse(&state).ok_or_else(|| invalid("state"))?,
        last_active_at: parse_time(&r.get::<_, String>(7)?)?,
        favicon: r.get(8)?,
    })
}

fn credential_row(row: &Row<'_>) -> rusqlite::Result<Credential> {
    Ok(Credential {
        id: row.get(0)?,
        profile_id: row.get(1)?,
        origin: row.get(2)?,
        username: row.get(3)?,
        created_at: row.get(4)?,
        last_used_at: row.get(5)?,
        uses: row.get(6)?,
    })
}

fn form_entry_row(row: &Row<'_>) -> rusqlite::Result<FormEntry> {
    Ok(FormEntry {
        id: row.get(0)?,
        profile_id: row.get(1)?,
        field: row.get(2)?,
        value: row.get(3)?,
        uses: row.get(4)?,
        last_used_at: row.get(5)?,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn about_blank_is_never_filed_as_a_visit_title() {
        let store = Store::in_memory().unwrap();
        let now = Timestamp::now();
        store
            .record_visit("https://a.dev/", "about:blank", now)
            .unwrap();
        assert_eq!(store.search_history("a.dev", 5).unwrap()[0].title, "");
        store.record_visit("https://a.dev/", "A dev", now).unwrap();
        assert_eq!(store.search_history("a.dev", 5).unwrap()[0].title, "A dev");
        // A later blank title must not wipe the real one.
        store
            .record_visit("https://a.dev/", "about:blank", now)
            .unwrap();
        assert_eq!(store.search_history("a.dev", 5).unwrap()[0].title, "A dev");
    }

    #[test]
    fn form_entries_match_by_field_and_prefix_and_count_uses() {
        let store = Store::in_memory().unwrap();
        let profile = store.ensure_default_profile().unwrap();
        let now = Timestamp::now();
        store
            .record_form_entry(profile.id, "Email", "dale@example.com", now)
            .unwrap();
        store
            .record_form_entry(profile.id, "email", "dale@example.com", now)
            .unwrap();
        store
            .record_form_entry(profile.id, "email", "dee@example.com", now)
            .unwrap();
        let added = store
            .import_form_entries(
                profile.id,
                &[
                    ImportedFormEntry {
                        field: "email".into(),
                        value: "dale@example.com".into(),
                        uses: 9,
                        last_used_at: None,
                    },
                    ImportedFormEntry {
                        field: "name".into(),
                        value: "Dale".into(),
                        uses: 0,
                        last_used_at: Some(now),
                    },
                ],
            )
            .unwrap();
        assert_eq!(added, 1, "the duplicate is kept as it was");
        let all = store.form_entries(profile.id).unwrap();
        assert_eq!(
            all.iter()
                .map(|e| (e.field.as_str(), e.value.as_str(), e.uses))
                .collect::<Vec<_>>(),
            vec![
                ("email", "dale@example.com", 2),
                ("email", "dee@example.com", 1),
                ("name", "Dale", 1)
            ]
        );
        let d = store
            .form_entries_for(profile.id, "EMAIL", "D", 10)
            .unwrap();
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].value, "dale@example.com");
        // `%` and `_` in the prefix are literal.
        assert!(
            store
                .form_entries_for(profile.id, "email", "%", 10)
                .unwrap()
                .is_empty()
        );
        assert!(
            store.form_entries(ProfileId::new()).unwrap().is_empty(),
            "entries stay with their profile"
        );
        assert!(store.remove_form_entry(&d[1].id).unwrap());
        assert_eq!(store.clear_form_entries(profile.id).unwrap(), 2);
        assert!(store.form_entries(profile.id).unwrap().is_empty());
    }

    #[test]
    fn credentials_round_trip_per_profile_and_keep_their_id_on_resave() {
        let store = Store::in_memory().unwrap();
        let profile = store.ensure_default_profile().unwrap();
        let now = Timestamp::now();
        let first = store
            .upsert_credential("id-1", profile.id, "https://github.com", "dale", now)
            .unwrap();
        assert_eq!(first.id, "id-1");
        // Same site and username again: the row and id survive, the new id is dropped.
        let again = store
            .upsert_credential("id-2", profile.id, "https://github.com", "dale", now)
            .unwrap();
        assert_eq!(again.id, "id-1");
        store
            .upsert_credential("id-3", profile.id, "https://github.com", "eve", now)
            .unwrap();
        store.touch_credential("id-3", now).unwrap();
        let by_site = store
            .credentials_for(profile.id, "https://github.com")
            .unwrap();
        assert_eq!(
            by_site
                .iter()
                .map(|c| c.username.as_str())
                .collect::<Vec<_>>(),
            ["eve", "dale"]
        );
        assert_eq!(by_site[0].uses, 1);
        assert!(by_site[0].last_used_at.is_some());
        assert!(
            store
                .credentials_for(profile.id, "https://example.org")
                .unwrap()
                .is_empty()
        );
        let other = ProfileId::new();
        assert!(store.credentials(other).unwrap().is_empty());
        assert!(store.remove_credential("id-1").unwrap());
        assert!(!store.remove_credential("id-1").unwrap());
        assert_eq!(store.credentials(profile.id).unwrap().len(), 1);
    }

    #[test]
    fn credentials_sort_by_the_host_shown_not_the_scheme() {
        let store = Store::in_memory().unwrap();
        let profile = store.ensure_default_profile().unwrap();
        let now = Timestamp::now();
        for (id, origin, username) in [
            ("a", "https://github.com", "dale"),
            ("b", "http://localhost:3000", "dev"),
            ("c", "https://accounts.example.com", "Zoe"),
            ("d", "https://accounts.example.com", "amy"),
        ] {
            store
                .upsert_credential(id, profile.id, origin, username, now)
                .unwrap();
        }
        let order: Vec<_> = store
            .credentials(profile.id)
            .unwrap()
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(order, ["d", "c", "a", "b"]);
    }

    #[test]
    fn a_renamed_login_keeps_its_id_and_cannot_take_a_used_name() {
        let store = Store::in_memory().unwrap();
        let profile = store.ensure_default_profile().unwrap();
        let now = Timestamp::now();
        store
            .upsert_credential("id-1", profile.id, "https://x.test", "dale", now)
            .unwrap();
        store
            .upsert_credential("id-2", profile.id, "https://x.test", "eve", now)
            .unwrap();
        let renamed = store.rename_credential("id-1", "dale@x.test").unwrap();
        assert_eq!(
            (renamed.id.as_str(), renamed.username.as_str()),
            ("id-1", "dale@x.test")
        );
        assert!(store.rename_credential("id-1", "eve").is_err());
    }

    use super::*;

    impl Store {
        /// Persist `t` and read it back, so a test can assert what survived.
        fn tab_after_upsert(&self, t: &Tab) -> Tab {
            self.upsert_tab(t).unwrap();
            self.tab(t.id).unwrap()
        }
    }

    fn seeded() -> (Store, Workspace) {
        let store = Store::in_memory().unwrap();
        let c = Container::new("Personal");
        store.upsert_container(&c).unwrap();
        let profile = store.ensure_default_profile().unwrap();
        let w = Workspace::new("Work", c.id, profile.id, 0);
        store.upsert_workspace(&w).unwrap();
        (store, w)
    }

    /// A database as the build before per-address history and keyed icons
    /// left it.
    fn store_at_v16() -> Store {
        let store = Store {
            conn: Connection::open_in_memory().unwrap(),
            scope: std::cell::RefCell::new(None),
        };
        store.migrate_to(16).unwrap();
        store
    }

    fn count(store: &Store, sql: &str) -> i64 {
        store.conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn upgrading_files_every_address_once_and_every_icon_under_its_key() {
        let store = store_at_v16();
        let visits = [
            ("https://a.dev/", "", "2026-09-01T10:00:00Z"),
            ("https://a.dev/", "A dev", "2026-09-02T10:00:00Z"),
            ("https://a.dev/", "", "2026-09-03T10:00:00Z"),
            ("https://a.dev/#top", "A dev", "2026-08-01T10:00:00Z"),
            ("https://b.dev/x//", "B", "2026-09-04T10:00:00Z"),
        ];
        for (url, title, at) in visits {
            store
                .conn
                .execute(
                    "INSERT INTO history (profile_id, url, title, visited_at) VALUES ('p', ?1, ?2, ?3)",
                    params![url, title, at],
                )
                .unwrap();
        }
        let (origin_icon, tab_icon) = (
            "data:image/png;base64,T1JJRw==",
            "data:image/svg+xml;base64,VEFC",
        );
        store
            .conn
            .execute(
                "INSERT INTO favicons (origin, data, updated_at) VALUES ('https://a.dev', ?1, '2026-09-01T00:00:00Z')",
                [origin_icon],
            )
            .unwrap();
        let tab = TabId::new();
        store
            .conn
            .execute(
                "INSERT INTO tabs (id, workspace_id, tier, url, title, position, state, last_active_at, favicon)
                 VALUES (?1, NULL, 'essential', 'https://c.dev/', 'C', 0, 'active', '2026-09-01T00:00:00Z', ?2)",
                params![tab.to_string(), tab_icon],
            )
            .unwrap();

        store.migrate().unwrap();

        // One row per address, with the newest non-empty title and its count.
        let rows: Vec<(String, i64, String, String, i64)> = {
            let mut stmt = store
                .conn
                .prepare(
                    "SELECT url, key_hash, title, last_visit, visit_count FROM urls ORDER BY url",
                )
                .unwrap();
            stmt.query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap()
        };
        assert_eq!(rows.len(), 3);
        assert_eq!(
            rows[0],
            (
                "https://a.dev/".into(),
                url_hash("https://a.dev"),
                "A dev".into(),
                "2026-09-03T10:00:00Z".into(),
                3
            )
        );
        assert_eq!(rows[1].1, rows[0].1, "the fragment twin shares its key");
        assert_eq!(rows[2].1, url_hash("https://b.dev/x"));

        // Icons live once, under their key; the rows that held them hold keys.
        let key = favicon_key(origin_icon);
        assert_eq!(store.favicon("https://a.dev").unwrap(), Some(key.clone()));
        let tab_key: Option<String> = store
            .conn
            .query_row(
                "SELECT favicon FROM tabs WHERE id = ?1",
                [tab.to_string()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tab_key, Some(favicon_key(tab_icon)));
        let images = store
            .favicon_images(&[key.clone(), favicon_key(tab_icon), "missing".into()])
            .unwrap();
        assert_eq!(
            images,
            vec![
                (key, origin_icon.to_owned()),
                (favicon_key(tab_icon), tab_icon.to_owned())
            ]
        );

        // The palette reads the new table: the fragment twin folds into its page.
        *store.scope.borrow_mut() = Some("p".into());
        let found = store.search_history("a.dev", 5).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].visits, 4);
        assert_eq!(found[0].title, "A dev");
    }

    #[test]
    fn a_page_that_keeps_retitling_itself_names_its_visit_once() {
        let (store, w) = seeded();
        let mut tab = Tab::new(w.id, "https://chat.test/", 0);
        let now = Timestamp::now();
        store
            .save_tab(
                &tab,
                Some(VisitChange::Navigated {
                    url: &tab.url,
                    title: "",
                    at: now,
                }),
            )
            .unwrap();
        for title in ["about:blank", "Chat", "(1) Chat", "(2) Chat"] {
            tab.title = title.into();
            store
                .save_tab(
                    &tab,
                    Some(VisitChange::Titled {
                        url: &tab.url,
                        title,
                    }),
                )
                .unwrap();
        }
        assert_eq!(count(&store, "SELECT COUNT(*) FROM history"), 1);
        let found = store.search_history("chat", 5).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title, "Chat", "the first real title sticks");
        assert_eq!(found[0].visits, 1);
        assert_eq!(store.tab(tab.id).unwrap().title, "(2) Chat");

        // Going somewhere else is a new visit, untitled until it is named.
        tab.url = "https://chat.test/room".into();
        let later = Timestamp(now.0 + time::Duration::minutes(5));
        store
            .save_tab(
                &tab,
                Some(VisitChange::Navigated {
                    url: &tab.url,
                    title: "",
                    at: later,
                }),
            )
            .unwrap();
        assert_eq!(count(&store, "SELECT COUNT(*) FROM history"), 2);
        assert_eq!(store.tab(tab.id).unwrap().url, "https://chat.test/room");
    }

    #[test]
    fn history_ranks_frequent_pages_and_address_matches_first() {
        let store = Store::in_memory().unwrap();
        let now = Timestamp::now();
        let ago = |minutes: i64| Timestamp(now.0 - time::Duration::minutes(minutes));
        // Read twenty times over the last day, but longer ago than the others.
        for i in 0..20 {
            store
                .record_visit("https://docs.a.test/guide", "Rust guide", ago(600 + i * 5))
                .unwrap();
        }
        store
            .record_visit("https://b.test/once", "Rust, once", ago(1))
            .unwrap();
        let rust = store.search_history("rust", 5).unwrap();
        assert_eq!(rust[0].url, "https://docs.a.test/guide");
        assert_eq!(rust[0].visits, 20);

        // An address that begins with what was typed beats a busier page
        // that only mentions it.
        for i in 0..6 {
            store
                .record_visit("https://blog.test/tips", "git tips", ago(2 + i * 5))
                .unwrap();
        }
        store
            .record_visit("https://github.com/", "GitHub", ago(3 * 24 * 60))
            .unwrap();
        assert_eq!(
            store.search_history("git", 5).unwrap()[0].url,
            "https://github.com/"
        );
        assert_eq!(
            store.search_history("github.com/", 5).unwrap()[0].url,
            "https://github.com/"
        );

        // With nothing typed the list is simply the newest pages.
        let recent = store.search_history("", 3).unwrap();
        assert_eq!(recent[0].url, "https://b.test/once");
        assert_eq!(recent[1].url, "https://blog.test/tips");
    }

    #[test]
    fn frecency_weighs_count_on_a_log_scale_and_recency_in_steps() {
        let hours = time::Duration::hours;
        assert!(frecency(20, hours(10)) > frecency(1, hours(0)));
        assert!((frecency(1, hours(1)) - frecency(1, hours(20))).abs() < f64::EPSILON);
        assert!(frecency(1, hours(1)) > frecency(1, hours(24 * 5)));
        assert!(frecency(1000, hours(24 * 200)) < frecency(3, hours(1)));
        assert!(address_starts_with("https://www.GitHub.com/x", "git"));
        assert!(address_starts_with(
            "http://github.com/",
            "https://github.com/"
        ));
        assert!(!address_starts_with("https://blog.test/git", "git"));
        assert!(!address_starts_with("https://a.test/", ""));
    }

    #[test]
    fn removing_a_history_row_removes_the_twins_it_stood_for() {
        let store = Store::in_memory().unwrap();
        let now = Timestamp::now();
        for (i, url) in [
            "https://a.dev/",
            "https://a.dev",
            "https://a.dev/#section",
            "https://a.dev/?q=1",
        ]
        .into_iter()
        .enumerate()
        {
            let at = Timestamp(now.0 - time::Duration::minutes(10 * i64::try_from(i).unwrap()));
            store.record_visit(url, "A", at).unwrap();
        }
        assert_eq!(store.search_history("a.dev", 10).unwrap().len(), 2);
        assert_eq!(store.remove_history("https://a.dev").unwrap(), 3);
        let left = store.search_history("a.dev", 10).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].url, "https://a.dev/?q=1");
        assert_eq!(count(&store, "SELECT COUNT(*) FROM history"), 1);
        assert_eq!(count(&store, "SELECT COUNT(*) FROM urls"), 1);
    }

    #[test]
    fn pruning_reaches_every_profile_and_keeps_the_address_counts_true() {
        let store = Store::in_memory().unwrap();
        let now = Timestamp::now();
        let old = Timestamp(now.0 - time::Duration::days(40));
        for profile in ["p1", "p2"] {
            store.forget_scope();
            *store.scope.borrow_mut() = Some(profile.into());
            store
                .record_visit("https://kept.test/", "Kept", old)
                .unwrap();
            store
                .record_visit("https://kept.test/", "Kept", now)
                .unwrap();
            store
                .record_visit("https://gone.test/", "Gone", old)
                .unwrap();
        }
        let cutoff = Timestamp(now.0 - time::Duration::days(30));
        assert_eq!(store.prune_history(cutoff).unwrap(), 4);
        assert_eq!(count(&store, "SELECT COUNT(*) FROM history"), 2);
        let rows: Vec<(String, i64)> = {
            let mut stmt = store
                .conn
                .prepare("SELECT url, visit_count FROM urls ORDER BY profile_id")
                .unwrap();
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .collect::<std::result::Result<_, _>>()
                .unwrap()
        };
        assert_eq!(
            rows,
            vec![
                ("https://kept.test/".to_owned(), 1),
                ("https://kept.test/".to_owned(), 1)
            ]
        );
    }

    #[test]
    fn an_icon_is_written_only_when_something_about_it_changed() {
        let (store, w) = seeded();
        let data = "data:image/png;base64,QUFB";
        let key = store.set_favicon("https://a.dev", data, "links-1").unwrap();
        // Backdate it, as if it had been confirmed a while ago.
        let hour_ago = Timestamp(Timestamp::now().0 - time::Duration::hours(1));
        store
            .conn
            .execute(
                "UPDATE favicons SET updated_at = ?1",
                [hour_ago.to_rfc3339()],
            )
            .unwrap();
        let entry = || store.favicon_entry("https://a.dev").unwrap().unwrap();
        assert_eq!(
            store.set_favicon("https://a.dev", data, "links-1").unwrap(),
            key
        );
        assert_eq!(
            entry().updated_at,
            hour_ago,
            "the same icon again writes nothing"
        );
        store.set_favicon("https://a.dev", data, "links-2").unwrap();
        assert_eq!(entry().source, "links-2");
        assert!(entry().updated_at > hour_ago);

        // A replaced icon is pruned once nothing wears it; one a tab still
        // wears stays, even after the cache is cleared.
        let mut tab = Tab::new(w.id, "https://a.dev/", 0);
        tab.favicon = Some(key.clone());
        store.upsert_tab(&tab).unwrap();
        let other = store
            .set_favicon("https://a.dev", "data:image/png;base64,QkJC", "links-3")
            .unwrap();
        assert_eq!(store.prune_favicon_images().unwrap(), 0);
        assert_eq!(store.clear_favicons().unwrap(), 1);
        assert!(store.favicon_images(&[other]).unwrap().is_empty());
        assert_eq!(
            store
                .favicon_images(std::slice::from_ref(&key))
                .unwrap()
                .len(),
            1
        );
        store.remove_tab(tab.id).unwrap();
        assert_eq!(store.prune_favicon_images().unwrap(), 1);
        assert!(store.favicon_images(&[key]).unwrap().is_empty());
    }

    #[test]
    fn keys_name_content() {
        let a = favicon_key("data:image/png;base64,AAAA");
        assert_eq!(a, favicon_key("data:image/png;base64,AAAA"));
        assert_ne!(a, favicon_key("data:image/png;base64,AAAB"));
        assert!(a.bytes().all(|b| b.is_ascii_hexdigit()), "{a}");
        assert!(!a.contains(':'), "a key never reads as a URL");
        assert_eq!(url_key("https://a.dev/path//#x/y"), "https://a.dev/path");
        assert_eq!(url_key("https://a.dev/?q=1#x"), "https://a.dev/?q=1");
    }

    #[test]
    fn only_the_newest_pre_migration_copy_is_kept() {
        let dir = std::env::temp_dir().join(format!("dive-backups-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("dive.db");
        for name in [
            "dive.db.before-v14",
            "dive.db.before-v15",
            "dive.db.before-v18",
            "dive.db.before-vnext",
            "other.db.before-v3",
        ] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        remove_older_backups(&path, &dir.join("dive.db.before-v18"));
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "dive.db.before-v18",
                "dive.db.before-vnext",
                "other.db.before-v3"
            ]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_tab_keeps_its_conversation_until_the_tab_or_the_time_runs_out() {
        let (store, w) = seeded();
        let tab = Tab::new(w.id, "https://a.dev/", 0);
        store.upsert_tab(&tab).unwrap();
        assert!(store.agent_thread(tab.id).unwrap().is_none());

        store
            .agent_thread_save(tab.id, "Find what is broken", r#"[{"role":"user"}]"#)
            .unwrap();
        let kept = store.agent_thread(tab.id).unwrap().unwrap();
        assert_eq!(kept.title, "Find what is broken");
        assert_eq!(kept.messages, r#"[{"role":"user"}]"#);
        assert_eq!(kept.tab_id, tab.id.to_string());

        // Saving again replaces rather than accumulating.
        store
            .agent_thread_save(tab.id, "Find what is broken", "[]")
            .unwrap();
        assert_eq!(store.agent_thread(tab.id).unwrap().unwrap().messages, "[]");

        // A conversation nobody asked to keep goes when it is asked to.
        assert!(store.agent_thread_delete(tab.id).unwrap());
        assert!(!store.agent_thread_delete(tab.id).unwrap());
    }

    #[test]
    fn pruning_forgets_conversations_whose_tab_is_gone_or_that_are_stale() {
        let (store, w) = seeded();
        let live = Tab::new(w.id, "https://a.dev/", 0);
        let closed = Tab::new(w.id, "https://b.dev/", 1);
        store.upsert_tab(&live).unwrap();
        store.upsert_tab(&closed).unwrap();
        store.agent_thread_save(live.id, "live", "[]").unwrap();
        store.agent_thread_save(closed.id, "closed", "[]").unwrap();

        // Closing the tab takes its conversation with it: the cascade does
        // it here, and the sweep below is what catches a database whose
        // foreign keys are off.
        store.remove_tab(closed.id).unwrap();
        assert!(store.agent_thread(closed.id).unwrap().is_none());
        assert_eq!(
            store.agent_threads_prune("1970-01-01T00:00:00Z").unwrap(),
            0
        );
        assert!(store.agent_thread(live.id).unwrap().is_some());

        // Far enough in the future, everything is stale.
        assert_eq!(
            store.agent_threads_prune("2999-01-01T00:00:00Z").unwrap(),
            1
        );
        assert!(store.agent_thread(live.id).unwrap().is_none());
    }

    #[test]
    fn a_deleted_profile_leaves_no_rows_and_frees_only_its_own_container() {
        let (store, w) = seeded();
        let own = Container::new("Other");
        store.upsert_container(&own).unwrap();
        let other = Profile::new("Other", own.id, 1);
        store.upsert_profile(&other).unwrap();
        let now = Timestamp::now();
        store
            .upsert_credential("login", other.id, "https://a.test", "me", now)
            .unwrap();
        store
            .upsert_credential("kept", w.profile_id, "https://a.test", "me", now)
            .unwrap();
        store
            .record_form_entry(other.id, "email", "me@a.test", now)
            .unwrap();
        store
            .set_setting(&format!("profile_workspace:{}", other.id), "x")
            .unwrap();
        store.remove_profile(other.id).unwrap();
        store.remove_profile_data(other.id).unwrap();
        assert!(store.credentials(other.id).unwrap().is_empty());
        assert!(store.form_entries(other.id).unwrap().is_empty());
        assert!(
            store
                .setting(&format!("profile_workspace:{}", other.id))
                .unwrap()
                .is_none()
        );
        assert_eq!(store.credentials(w.profile_id).unwrap().len(), 1);
        // The shared default container is still in use; the profile's own is not.
        assert!(
            store
                .remove_container_if_unused(w.container_id)
                .unwrap()
                .is_none()
        );
        let freed = store.remove_container_if_unused(own.id).unwrap().unwrap();
        assert_eq!(freed.cache_dir, own.cache_dir);
        assert!(store.container(own.id).is_err());
    }

    #[test]
    fn keep_active_sites_are_canonical_origin_and_profile_scoped() {
        let (store, w) = seeded();
        let other = Profile::new("Other", w.container_id, 1);
        store.upsert_profile(&other).unwrap();
        store
            .set_keep_active_site(w.profile_id, "https://EXAMPLE.com:443/path?q=1", true)
            .unwrap();
        assert_eq!(
            store.keep_active_sites(w.profile_id).unwrap(),
            vec!["https://example.com"]
        );
        assert!(store.keep_active_sites(other.id).unwrap().is_empty());
        store
            .set_keep_active_site(other.id, "https://example.com:8443/", true)
            .unwrap();
        assert_eq!(
            store.keep_active_sites(other.id).unwrap(),
            vec!["https://example.com:8443"]
        );
        assert_eq!(
            store.keep_active_sites(w.profile_id).unwrap(),
            vec!["https://example.com"]
        );
        assert!(store.keep_active_sites(ProfileId::new()).is_err());
        assert!(
            store
                .set_keep_active_site(w.profile_id, "file:///private", true)
                .is_err()
        );
        assert!(
            store
                .set_keep_active_site(w.profile_id, "data:text/plain,a", true)
                .is_err()
        );
        store
            .set_keep_active_site(w.profile_id, "https://example.com/other", false)
            .unwrap();
        assert!(store.keep_active_sites(w.profile_id).unwrap().is_empty());
    }

    #[test]
    fn activity_touch_preserves_current_navigation_and_pinning() {
        let (store, w) = seeded();
        let mut tab = Tab::new(w.id, "https://new.example", 0);
        tab.tier = TabTier::Pinned;
        tab.last_active_at = Timestamp(Timestamp::now().0 - time::Duration::hours(2));
        store.upsert_tab(&tab).unwrap();
        let now = Timestamp::now();
        store.touch_tab_activity(tab.id, now).unwrap();
        tab.last_active_at = now;
        assert_eq!(store.tab(tab.id).unwrap(), tab);
    }

    #[test]
    fn migrations_are_idempotent() {
        let store = Store::in_memory().unwrap();
        store.migrate().unwrap();
        let v: i64 = store
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(usize::try_from(v).unwrap(), MIGRATIONS.len());
        let busy: i64 = store
            .conn
            .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
            .unwrap();
        assert_eq!(busy, 5_000);
    }

    #[test]
    fn workspace_roundtrip_and_ordering() {
        let (store, w) = seeded();
        let mut later = Workspace::new("Second", w.container_id, w.profile_id, 1);
        later.color = "#ABCDEF".into();
        store.upsert_workspace(&later).unwrap();
        let all = store.workspaces().unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].name, "Work");
        assert_eq!(all[1].color, "#ABCDEF");
        assert_eq!(store.workspace(w.id).unwrap().name, w.name);
        assert_eq!(store.containers().unwrap()[0].name, "Personal");
    }

    #[test]
    fn tabs_order_by_tier_then_position_and_include_essentials() {
        let (store, w) = seeded();
        let mut essential = Tab::new(w.id, "https://mail", 5);
        essential.tier = TabTier::Essential;
        essential.workspace_id = None;
        let mut pinned = Tab::new(w.id, "https://docs", 9);
        pinned.tier = TabTier::Pinned;
        let today_b = Tab::new(w.id, "https://b", 2);
        let today_a = Tab::new(w.id, "https://a", 1);
        for t in [&today_b, &today_a, &pinned, &essential] {
            store.upsert_tab(t).unwrap();
        }
        let urls: Vec<_> = store
            .tabs_for_workspace(w.id)
            .unwrap()
            .into_iter()
            .map(|t| t.url)
            .collect();
        assert_eq!(
            urls,
            ["https://mail", "https://docs", "https://a", "https://b"]
        );
    }

    #[test]
    fn origin_cache_lends_icons_to_unopened_tabs() {
        let (store, w) = seeded();
        let a = Tab::new(w.id, "https://example.com/one", 0);
        let b = Tab::new(w.id, "https://example.com/two", 1);
        let other = Tab::new(w.id, "https://elsewhere.test/", 2);
        for t in [&a, &b, &other] {
            store.upsert_tab(t).unwrap();
        }
        let key = store
            .set_favicon("https://example.com", "data:image/png;base64,AAAA", "")
            .unwrap();
        assert_eq!(key, favicon_key("data:image/png;base64,AAAA"));

        // Neither tab has an icon of its own; both wear their site's.
        let icon = Some(key.as_str());
        assert_eq!(store.tab(a.id).unwrap().favicon.as_deref(), icon);
        assert_eq!(store.tab(b.id).unwrap().favicon.as_deref(), icon);
        assert_eq!(store.tab(other.id).unwrap().favicon, None);
        // The row itself holds nothing yet: a newly resolved icon has to be
        // judged against this, or it looks like no change and is never sent.
        assert_eq!(store.tab_as_stored(a.id).unwrap().favicon, None);

        // A tab's own icon outranks the site's.
        let mut own = b.clone();
        own.favicon = Some("data:image/svg+xml;base64,BBBB".into());
        assert_eq!(
            store.tab_after_upsert(&own).favicon.as_deref(),
            Some("data:image/svg+xml;base64,BBBB")
        );

        // Listing fills icons too, and an opaque URL keys nothing.
        let opaque = Tab::new(w.id, "data:text/html,hi", 3);
        store.upsert_tab(&opaque).unwrap();
        let tabs = store.tabs_for_workspace(w.id).unwrap();
        assert_eq!(
            tabs.iter()
                .find(|t| t.id == a.id)
                .unwrap()
                .favicon
                .as_deref(),
            icon
        );
        assert_eq!(
            tabs.iter().find(|t| t.id == opaque.id).unwrap().favicon,
            None
        );
        assert_eq!(origin_of("data:text/html,hi"), None);
        assert_eq!(
            origin_of("https://example.com:443/x?q=1").as_deref(),
            Some("https://example.com")
        );
    }

    #[test]
    fn favicon_roundtrips_and_clears() {
        let (store, w) = seeded();
        let mut t = Tab::new(w.id, "https://x", 0);
        assert_eq!(store.tab_after_upsert(&t).favicon, None);
        t.favicon = Some("data:image/png;base64,AAAA".into());
        assert_eq!(
            store.tab_after_upsert(&t).favicon.as_deref(),
            Some("data:image/png;base64,AAAA")
        );
        t.favicon = None;
        assert_eq!(store.tab_after_upsert(&t).favicon, None);
    }

    #[test]
    fn opening_a_pre_profile_database_adopts_its_workspaces() {
        // Simulate a database whose v8 migration left workspaces without a
        // profile: the store must repair it on open, not fail on read.
        let store = Store::in_memory().unwrap();
        let c = Container::new("Personal");
        store.upsert_container(&c).unwrap();
        store
            .conn
            .execute(
                "INSERT INTO workspaces (id, name, color, icon, container_id, position, created_at, profile_id)
                 VALUES (?1, 'Old', '#000', 'x', ?2, 0, ?3, '')",
                params![
                    WorkspaceId::new().to_string(),
                    c.id.to_string(),
                    Timestamp::now().to_rfc3339()
                ],
            )
            .unwrap();
        assert!(
            store.workspaces().is_err(),
            "an empty profile id is unreadable"
        );
        // Reopening the same connection is what `Store::init` does after
        // migrating; run the repair path exactly as it would.
        let store = Store::init(store.conn).unwrap();
        let workspaces = store.workspaces().unwrap();
        assert_eq!(workspaces.len(), 1);
        let profiles = store.profiles().unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(workspaces[0].profile_id, profiles[0].id);
        // A second explicit call is a no-op.
        assert_eq!(store.ensure_default_profile().unwrap().id, profiles[0].id);
        assert_eq!(store.profiles().unwrap().len(), 1);
    }

    #[test]
    fn a_profile_that_still_owns_workspaces_cannot_be_removed() {
        let (store, w) = seeded();
        let profile = store.profiles().unwrap().remove(0);
        assert!(matches!(
            store.remove_profile(profile.id),
            Err(CoreError::Invalid(_))
        ));
        assert!(store.profile(profile.id).is_ok());
        store.remove_workspace(w.id).unwrap();
        store.remove_profile(profile.id).unwrap();
        assert!(matches!(
            store.remove_profile(profile.id),
            Err(CoreError::NotFound {
                kind: "profile",
                ..
            })
        ));
    }

    #[test]
    fn a_database_from_a_newer_build_is_refused() {
        let store = Store::in_memory().unwrap();
        store
            .conn
            .pragma_update(
                None,
                "user_version",
                i64::try_from(MIGRATIONS.len() + 1).unwrap(),
            )
            .unwrap();
        let err = store.migrate().unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)), "{err}");
        assert!(err.to_string().contains("newer"), "{err}");
    }

    #[test]
    fn removing_a_workspace_removes_its_scroll_rows_too() {
        let (store, w) = seeded();
        let t = Tab::new(w.id, "https://x", 0);
        store.upsert_tab(&t).unwrap();
        store.set_scroll(t.id, "https://x", 0, 40).unwrap();
        assert_eq!(store.scroll(t.id, "https://x").unwrap(), Some((0, 40)));
        store.remove_workspace(w.id).unwrap();
        let rows: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM tab_scroll", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn searches_treat_like_wildcards_literally() {
        let (store, _) = seeded();
        let now = Timestamp::now();
        store
            .record_visit("https://a.dev/100%25", "100% done", now)
            .unwrap();
        store
            .record_visit("https://a.dev/plain", "plain", now)
            .unwrap();
        store
            .record_visit("https://a.dev/a_b", "under", now)
            .unwrap();
        // Unescaped, `%` matches everything and `_` any one character.
        assert_eq!(store.search_history("%", 10).unwrap().len(), 1);
        assert_eq!(store.search_history("a_b", 10).unwrap().len(), 1);
        let found = store.search_history("a_b", 10).unwrap();
        assert_eq!(found[0].url, "https://a.dev/a_b");
        store
            .add_bookmark("https://b.dev/x", "50% off", now)
            .unwrap();
        store
            .add_bookmark("https://b.dev/y", "full price", now)
            .unwrap();
        assert_eq!(store.search_bookmarks("%", 10).unwrap().len(), 1);
        assert_eq!(store.search_bookmarks("50%", 10).unwrap().len(), 1);
    }

    #[test]
    fn removing_workspace_cascades_to_tabs() {
        let (store, w) = seeded();
        let t = Tab::new(w.id, "https://x", 0);
        store.upsert_tab(&t).unwrap();
        store.remove_workspace(w.id).unwrap();
        assert!(matches!(
            store.tab(t.id),
            Err(CoreError::NotFound { kind: "tab", .. })
        ));
        assert!(matches!(
            store.remove_workspace(w.id),
            Err(CoreError::NotFound { .. })
        ));
    }

    #[test]
    fn settings_roundtrip() {
        let (store, _) = seeded();
        assert_eq!(store.setting("active_tab").unwrap(), None);
        store.set_setting("active_tab", "x").unwrap();
        store.set_setting("active_tab", "y").unwrap();
        assert_eq!(store.setting("active_tab").unwrap().as_deref(), Some("y"));
    }

    #[test]
    fn last_active_tab_uses_recency_across_renderer_states_within_workspace() {
        let (store, w) = seeded();
        assert!(store.last_active_tab(w.id).unwrap().is_none());
        let now = Timestamp::parse("2026-09-05T12:00:00Z").unwrap();
        let mut older = Tab::new(w.id, "https://older", 0);
        older.last_active_at = now - time::Duration::hours(2);
        let mut discarded = Tab::new(w.id, "https://discarded", 1);
        discarded.state = TabState::Discarded;
        discarded.last_active_at = now - time::Duration::minutes(1);
        let mut newer = Tab::new(w.id, "https://newer", 2);
        newer.state = TabState::Sleeping;
        newer.last_active_at = now - time::Duration::hours(1);
        let other = Workspace::new("Other", w.container_id, w.profile_id, 1);
        store.upsert_workspace(&other).unwrap();
        let mut foreign = Tab::new(other.id, "https://foreign", 0);
        foreign.last_active_at = now;
        for t in [&older, &discarded, &newer, &foreign] {
            store.upsert_tab(t).unwrap();
        }
        assert_eq!(store.last_active_tab(w.id).unwrap().unwrap(), discarded);
        assert_eq!(
            store.last_active_tab(other.id).unwrap().unwrap().id,
            foreign.id
        );
    }

    #[test]
    fn last_active_tab_after_close_can_restore_discarded_remaining_tab() {
        let (store, w) = seeded();
        let now = Timestamp::parse("2026-09-05T12:00:00Z").unwrap();
        let mut alpha = Tab::new(w.id, "https://fixture.test/alpha", 0);
        alpha.last_active_at = now;
        let mut beta = Tab::new(w.id, "https://fixture.test/beta?saved=1#section", 1);
        beta.last_active_at = now - time::Duration::hours(2);
        beta.state = TabState::Discarded;
        store.upsert_tab(&alpha).unwrap();
        store.upsert_tab(&beta).unwrap();
        assert_eq!(store.last_active_tab(w.id).unwrap().unwrap().id, alpha.id);

        store.remove_tab(alpha.id).unwrap();
        // Closing a tab removes its row; discarding only releases its renderer.
        // Replacement selection must retain the identity and persisted URL to wake.
        assert_eq!(store.last_active_tab(w.id).unwrap().unwrap(), beta);

        store.remove_tab(beta.id).unwrap();
        assert!(store.last_active_tab(w.id).unwrap().is_none());
    }

    #[test]
    fn bookmarks_roundtrip() {
        let store = Store::in_memory().unwrap();
        let now = Timestamp::now();
        store.add_bookmark("https://a.dev/", "A", now).unwrap();
        store.add_bookmark("https://a.dev/", "", now).unwrap();
        assert!(store.is_bookmarked("https://a.dev/").unwrap());
        assert_eq!(
            store.search_bookmarks("a", 10).unwrap()[0].title,
            "A",
            "empty title must not clobber"
        );
        assert!(store.remove_bookmark("https://a.dev/").unwrap());
        assert!(!store.remove_bookmark("https://a.dev/").unwrap());
        assert!(!store.is_bookmarked("https://a.dev/").unwrap());
    }

    #[test]
    fn history_and_bookmarks_belong_to_the_active_profile() {
        let store = Store::in_memory().unwrap();
        let now = Timestamp::now();
        // Two profiles, each with a workspace; the active workspace decides the scope.
        let (personal, work) = (ProfileId::new(), ProfileId::new());
        for (profile, name, position) in [(personal, "Personal", 0), (work, "Work", 1)] {
            store
                .conn
                .execute(
                    "INSERT INTO containers (id, name, cache_dir) VALUES (?1, ?2, ?3)",
                    params![profile.to_string(), name, format!("c-{name}")],
                )
                .unwrap();
            store
                .conn
                .execute(
                    "INSERT INTO profiles (id, name, color, avatar, container_id, position, created_at)
                     VALUES (?1, ?2, '#000', 'a', ?1, ?3, ?4)",
                    params![profile.to_string(), name, position, now.to_rfc3339()],
                )
                .unwrap();
        }
        let ws_of = |profile: ProfileId| {
            let id = WorkspaceId::new();
            store
                .conn
                .execute(
                    "INSERT INTO workspaces (id, name, color, icon, container_id, profile_id, position, created_at)
                     VALUES (?1, 'w', '#000', 'i', ?2, ?2, 0, ?3)",
                    params![id.to_string(), profile.to_string(), now.to_rfc3339()],
                )
                .unwrap();
            id
        };
        let (ws_personal, ws_work) = (ws_of(personal), ws_of(work));

        store
            .set_setting(ACTIVE_WORKSPACE_SETTING, &ws_personal.to_string())
            .unwrap();
        store
            .record_visit("https://deque.test/rule", "Deque", now)
            .unwrap();
        store
            .add_bookmark("https://deque.test/rule", "Deque", now)
            .unwrap();
        assert_eq!(store.search_history("deque", 10).unwrap().len(), 1);
        assert!(store.is_bookmarked("https://deque.test/rule").unwrap());

        store
            .set_setting(ACTIVE_WORKSPACE_SETTING, &ws_work.to_string())
            .unwrap();
        assert!(
            store.search_history("deque", 10).unwrap().is_empty(),
            "Work must not see Personal's visits"
        );
        assert!(store.search_bookmarks("deque", 10).unwrap().is_empty());
        assert!(!store.is_bookmarked("https://deque.test/rule").unwrap());
        store
            .record_visit("https://corp.test/", "Corp", now)
            .unwrap();
        assert_eq!(
            store.clear_history().unwrap(),
            1,
            "clearing history clears only this profile"
        );

        store
            .set_setting(ACTIVE_WORKSPACE_SETTING, &ws_personal.to_string())
            .unwrap();
        assert_eq!(store.search_history("", 10).unwrap().len(), 1);
        assert!(store.remove_bookmark("https://deque.test/rule").unwrap());
    }

    #[test]
    fn history_dedupes_and_searches() {
        let store = Store::in_memory().unwrap();
        let t0 = Timestamp::now();
        store.record_visit("https://a.dev/docs", "", t0).unwrap();
        store
            .record_visit("https://a.dev/docs", "Docs", t0)
            .unwrap();
        store
            .record_visit("https://b.dev/", "B site", t0 - time::Duration::hours(1))
            .unwrap();
        store
            .record_visit(
                "https://a.dev/docs",
                "Docs again",
                t0 - time::Duration::hours(2),
            )
            .unwrap();
        let all = store.search_history("", 10).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].url, "https://a.dev/docs");
        assert_eq!(all[0].visits, 2, "same url within a minute is one visit");
        let hits = store.search_history("b site", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "B site");
    }

    #[test]
    fn history_collapses_twin_addresses_only() {
        let store = Store::in_memory().unwrap();
        let t0 = Timestamp::now();
        // The shape the palette kept showing twice: one origin, one title,
        // URLs that differ only in a slash -- and one that differs in a
        // parameter, which is a different address and stays one.
        for (i, url) in [
            "https://www.youtube.com/",
            "https://www.youtube.com",
            "https://www.youtube.com/?gl=PH",
        ]
        .iter()
        .enumerate()
        {
            let ago = time::Duration::hours(i64::try_from(i).unwrap_or(0));
            store.record_visit(url, "YouTube", t0 - ago).unwrap();
        }
        store
            .record_visit("https://b.dev/", "B site", t0 - time::Duration::days(1))
            .unwrap();

        let all = store.search_history("", 5).unwrap();
        assert_eq!(
            all.len(),
            3,
            "the two twins are one line; ?gl=PH is its own page"
        );
        assert_eq!(all[0].url, "https://www.youtube.com/", "newest wins");
        assert_eq!(all[0].visits, 2, "the twin lends its count");
        assert_eq!(all[1].url, "https://www.youtube.com/?gl=PH");
        assert_eq!(all[2].title, "B site");

        // A blank title is not enough to call two pages the same.
        store.record_visit("https://c.dev/one", "", t0).unwrap();
        store.record_visit("https://c.dev/two", "", t0).unwrap();
        let untitled = store.search_history("c.dev", 5).unwrap();
        assert_eq!(untitled.len(), 2);
    }

    #[test]
    fn history_honours_the_limit_after_collapsing() {
        let store = Store::in_memory().unwrap();
        let t0 = Timestamp::now();
        for i in 0..12 {
            let ago = time::Duration::minutes(i * 5);
            // Every page duplicated, so a naive limit would return five rows
            // that are really two and a half distinct sites.
            store
                .record_visit(&format!("https://s{i}.dev/"), "Site", t0 - ago)
                .unwrap();
            store
                .record_visit(&format!("https://s{i}.dev"), "Site", t0 - ago)
                .unwrap();
        }
        let five = store.search_history("", 5).unwrap();
        assert_eq!(five.len(), 5);
        let hosts: std::collections::HashSet<_> =
            five.iter().map(|h| crate::origin_of(&h.url)).collect();
        assert_eq!(hosts.len(), 5, "five distinct sites, not five rows");
    }

    #[test]
    fn history_and_bookmarks_wear_the_site_icon() {
        let store = Store::in_memory().unwrap();
        let now = Timestamp::now();
        let key = store
            .set_favicon("https://a.dev", "data:image/png;base64,AAAA", "")
            .unwrap();
        let icon = key.as_str();
        store
            .record_visit("https://a.dev/docs", "Docs", now)
            .unwrap();
        store.record_visit("https://b.dev/", "B", now).unwrap();
        store
            .add_bookmark("https://a.dev/docs", "Docs", now)
            .unwrap();

        let hits = store.search_history("docs", 5).unwrap();
        assert_eq!(hits[0].favicon.as_deref(), Some(icon));
        assert_eq!(
            store.search_bookmarks("docs", 5).unwrap()[0]
                .favicon
                .as_deref(),
            Some(icon)
        );
        // An origin never resolved has no icon to lend, and must not borrow one.
        assert_eq!(store.search_history("b.dev", 5).unwrap()[0].favicon, None);
    }

    #[test]
    fn workspace_counts_include_open_tabs_in_every_renderer_state() {
        let (store, w) = seeded();
        let other = Workspace::new("Other", w.container_id, w.profile_id, 1);
        store.upsert_workspace(&other).unwrap();
        let mut tabs = Vec::new();
        for state in [TabState::Active, TabState::Sleeping, TabState::Discarded] {
            let mut tab = Tab::new(w.id, "https://fixture.test", 0);
            tab.state = state;
            store.upsert_tab(&tab).unwrap();
            tabs.push(tab);
        }
        let mut sleeping_only = Tab::new(other.id, "https://other.test", 0);
        sleeping_only.state = TabState::Discarded;
        store.upsert_tab(&sleeping_only).unwrap();
        let mut essential = Tab::new(w.id, "https://essential.test", 0);
        essential.workspace_id = None;
        essential.tier = TabTier::Essential;
        store.upsert_tab(&essential).unwrap();
        let counts = || {
            store
                .tab_counts()
                .unwrap()
                .into_iter()
                .collect::<std::collections::HashMap<_, _>>()
        };
        assert_eq!(counts().get(&w.id), Some(&3));
        assert_eq!(counts().get(&other.id), Some(&1));
        store.remove_tab(tabs[2].id).unwrap();
        assert_eq!(counts().get(&w.id), Some(&2));
        for tab in &tabs[..2] {
            store.remove_tab(tab.id).unwrap();
        }
        assert!(!counts().contains_key(&w.id));
        assert_eq!(counts().get(&other.id), Some(&1));
    }

    #[test]
    fn history_prunes_by_age_and_clears() {
        let store = Store::in_memory().unwrap();
        let now = Timestamp::now();
        store.record_visit("https://new.dev/", "New", now).unwrap();
        store
            .record_visit("https://old.dev/", "Old", now - time::Duration::days(40))
            .unwrap();
        assert_eq!(
            store.prune_history(now - time::Duration::days(30)).unwrap(),
            1
        );
        let left = store.search_history("", 10).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].url, "https://new.dev/");
        store
            .record_visit("https://gone.dev/", "Gone", now)
            .unwrap();
        assert_eq!(store.remove_history("https://gone.dev/").unwrap(), 1);
        assert_eq!(store.remove_history("https://gone.dev/").unwrap(), 0);
        assert_eq!(store.clear_history().unwrap(), 1);
        assert!(store.search_history("", 10).unwrap().is_empty());
    }

    #[test]
    fn archive_idle_only_touches_today_tabs() {
        let (store, w) = seeded();
        let now = Timestamp::now();
        let mut old_today = Tab::new(w.id, "https://old", 0);
        old_today.last_active_at = now - time::Duration::hours(20);
        let mut old_pinned = Tab::new(w.id, "https://pinned", 1);
        old_pinned.tier = TabTier::Pinned;
        old_pinned.last_active_at = now - time::Duration::hours(20);
        let fresh = Tab::new(w.id, "https://fresh", 2);
        for t in [&old_today, &old_pinned, &fresh] {
            store.upsert_tab(t).unwrap();
        }
        assert_eq!(
            store
                .archive_idle_tabs(now, time::Duration::hours(12))
                .unwrap(),
            1
        );
        assert_eq!(store.tab(old_today.id).unwrap().state, TabState::Discarded);
        assert_eq!(store.tab(old_pinned.id).unwrap().state, TabState::Active);
        assert_eq!(store.tab(fresh.id).unwrap().state, TabState::Active);
    }

    #[test]
    fn discard_idle_spans_every_workspace() {
        let (store, w) = seeded();
        let other = Workspace::new("Other", w.container_id, w.profile_id, 1);
        store.upsert_workspace(&other).unwrap();
        let now = Timestamp::now();
        let mut a = Tab::new(w.id, "https://a", 0);
        a.last_active_at = now - time::Duration::hours(20);
        let mut b = Tab::new(other.id, "https://b", 0);
        b.last_active_at = now - time::Duration::hours(20);
        store.upsert_tab(&a).unwrap();
        store.upsert_tab(&b).unwrap();
        let discarded = store
            .discard_idle_tabs(now, time::Duration::hours(12))
            .unwrap();
        let ids: Vec<_> = discarded.iter().map(|t| t.id.to_string()).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&a.id.to_string()) && ids.contains(&b.id.to_string()));
        assert!(discarded.iter().all(|t| t.state == TabState::Discarded));
        assert_eq!(store.tab(b.id).unwrap().state, TabState::Discarded);
        assert!(
            store
                .discard_idle_tabs(now, time::Duration::hours(12))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn scroll_survives_only_for_the_same_url() {
        let (store, w) = seeded();
        let tab = Tab::new(w.id, "https://a/long", 0);
        store.upsert_tab(&tab).unwrap();
        assert_eq!(store.scroll(tab.id, "https://a/long").unwrap(), None);
        store
            .set_scroll(tab.id, "https://a/long", 12, 3400)
            .unwrap();
        assert_eq!(
            store.scroll(tab.id, "https://a/long").unwrap(),
            Some((12, 3400))
        );
        assert_eq!(store.scroll(tab.id, "https://a/other").unwrap(), None);
        store.set_scroll(tab.id, "https://a/long", 0, 10).unwrap();
        assert_eq!(
            store.scroll(tab.id, "https://a/long").unwrap(),
            Some((0, 10))
        );
        store.remove_tab(tab.id).unwrap();
        assert_eq!(store.scroll(tab.id, "https://a/long").unwrap(), None);
    }

    #[test]
    fn stale_discard_never_closes_a_tab_activated_pinned_or_navigated_during_probe() {
        for change in ["activate", "pin", "navigate", "workspace"] {
            let (store, workspace) = seeded();
            let now = Timestamp::now();
            let mut candidate = Tab::new(workspace.id, "https://example.com/original", 0);
            candidate.last_active_at = now - time::Duration::hours(2);
            store.upsert_tab(&candidate).unwrap();
            let mut current = candidate.clone();
            match change {
                "activate" => current.last_active_at = now,
                "pin" => current.tier = TabTier::Pinned,
                "navigate" => current.url = "https://example.com/new".into(),
                "workspace" => current.workspace_id = None,
                _ => unreachable!(),
            }
            store.upsert_tab(&current).unwrap();
            let closed = std::cell::Cell::new(false);
            let result = store
                .discard_candidate(&candidate, now - time::Duration::hours(1), (5, 8), || {
                    closed.set(true);
                    Ok(())
                })
                .unwrap();
            assert!(
                result.is_none(),
                "stale {change} candidate must be rejected"
            );
            assert!(!closed.get(), "native close must not run after {change}");
            assert_eq!(store.tab(candidate.id).unwrap(), current);
        }
    }

    #[test]
    fn native_close_request_does_not_persist_discard_before_receipt() {
        let (store, workspace) = seeded();
        let mut tab = Tab::new(workspace.id, "https://example.com", 0);
        let now = Timestamp::now();
        tab.last_active_at = now - time::Duration::hours(2);
        store.upsert_tab(&tab).unwrap();
        assert!(
            store
                .prepare_discard(&tab, now - time::Duration::hours(1), (50, 60), || Ok(()))
                .unwrap()
        );
        assert_eq!(store.tab(tab.id).unwrap().state, TabState::Active);
        assert_eq!(store.scroll(tab.id, &tab.url).unwrap(), Some((50, 60)));
    }

    #[test]
    fn failed_native_discard_leaves_persisted_state_and_scroll_unchanged() {
        let (store, workspace) = seeded();
        let now = Timestamp::now();
        let mut candidate = Tab::new(workspace.id, "https://example.com", 0);
        candidate.last_active_at = now - time::Duration::hours(2);
        store.upsert_tab(&candidate).unwrap();
        store
            .set_scroll(candidate.id, &candidate.url, 10, 20)
            .unwrap();
        let result =
            store.discard_candidate(&candidate, now - time::Duration::hours(1), (55, 66), || {
                Err(CoreError::Invalid("native close failed".into()))
            });
        assert!(result.is_err());
        assert_eq!(store.tab(candidate.id).unwrap(), candidate);
        assert_eq!(
            store.scroll(candidate.id, &candidate.url).unwrap(),
            Some((10, 20))
        );
    }

    #[test]
    fn discard_tabs_skips_missing_and_already_discarded() {
        let (store, w) = seeded();
        let a = Tab::new(w.id, "https://a", 0);
        store.upsert_tab(&a).unwrap();
        let first = store.discard_tabs(&[a.id, TabId::new()]).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].state, TabState::Discarded);
        assert!(store.discard_tabs(&[a.id]).unwrap().is_empty());
    }

    /// Every shipped migration's text, pinned. A migration that has reached
    /// users is applied exactly once per database, so changing it here does
    /// nothing for them and silently diverges new installs; the only safe
    /// change is appending a new one (and its checksum below).
    #[test]
    fn shipped_migrations_are_append_only() {
        fn djb2(s: &str) -> u64 {
            s.bytes()
                .fold(5381u64, |h, b| h.wrapping_mul(33) ^ u64::from(b))
        }
        const SHIPPED: &[u64] = &[
            0xb9e7_35ed_8a19_b103,
            0x52d5_64ee_25f8_dd05,
            0x5909_8ac2_b030_93da,
            0x9fa9_7e32_2105_32d1,
            0xff9d_3310_52cc_7359,
            0xa4b7_de1f_1a35_d3a6,
            0x1d6d_f725_f438_8a3c,
            0x0b4e_ecbb_d242_ffaf,
            0x99e5_fa52_17a9_ae16,
            0x1340_2877_32bd_71cf,
            0x755e_bc0a_ec8c_b672,
            0x4b69_716e_99b1_89aa,
            0xb4db_2559_061e_f61e,
            0xbe92_5ee4_9bbb_2be8,
            0x721f_a6d6_e53a_606b,
            0xb383_f674_f622_412e,
            0x9762_4673_813a_bd0d,
            0xa00b_35bd_dbcb_9176,
        ];
        assert!(
            MIGRATIONS.len() >= SHIPPED.len(),
            "a shipped migration was removed"
        );
        for (i, (sql, want)) in MIGRATIONS.iter().zip(SHIPPED).enumerate() {
            assert_eq!(
                djb2(sql),
                *want,
                "migration v{} changed after shipping; append a new one instead",
                i + 1
            );
        }
        assert_eq!(
            MIGRATIONS.len(),
            SHIPPED.len(),
            "a new migration needs its checksum pinned here"
        );
    }

    #[test]
    fn an_older_database_is_copied_aside_before_it_is_migrated() {
        let dir = std::env::temp_dir().join(format!("dive-store-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("dive.db");
        // A fresh file gets no backup: there is nothing to protect yet.
        drop(Store::open(&path).unwrap());
        assert!(std::fs::read_dir(&dir).unwrap().all(|e| {
            !e.unwrap()
                .file_name()
                .to_string_lossy()
                .contains("before-v")
        }));
        // Roll the file back to an older schema version and reopen.
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "user_version", 3).unwrap();
        }
        assert_eq!(Store::file_version(&path).unwrap(), 3);
        // Reopening at v3 on a v7 build is a migration (which fails on the
        // already-present tables, which is fine: the copy is what we test).
        let _ = Store::open(&path);
        let backup = path.with_file_name(format!("dive.db.before-v{}", MIGRATIONS.len()));
        assert!(backup.is_file(), "no backup at {}", backup.display());
        assert_eq!(Store::file_version(&backup).unwrap(), 3);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn grouped_settings_roll_back_when_a_later_write_fails() {
        let store = Store::in_memory().unwrap();
        store.conn.execute_batch("CREATE TRIGGER reject_second BEFORE INSERT ON settings WHEN NEW.key = 'second' BEGIN SELECT RAISE(ABORT, 'test write failure'); END;").unwrap();
        assert!(
            store
                .set_settings_atomic(&[
                    ("first".into(), "allow".into()),
                    ("second".into(), "allow".into())
                ])
                .is_err()
        );
        assert_eq!(store.setting("first").unwrap(), None);
    }

    #[test]
    fn settings_can_be_listed_by_prefix_and_removed() {
        let store = Store::in_memory().unwrap();
        store
            .set_setting("perm:https://a.dev:camera", "allow")
            .unwrap();
        store.set_setting("perm:https://b.dev:mic", "deny").unwrap();
        store.set_setting("zoom:https://a.dev", "1.25").unwrap();
        let perms = store.settings_with_prefix("perm:").unwrap();
        assert_eq!(perms.len(), 2);
        assert_eq!(perms[0].0, "perm:https://a.dev:camera");
        assert!(store.remove_setting("perm:https://b.dev:mic").unwrap());
        assert!(!store.remove_setting("perm:https://b.dev:mic").unwrap());
        assert_eq!(store.settings_with_prefix("perm:").unwrap().len(), 1);
        // A literal underscore in the prefix must not act as a wildcard.
        store.set_setting("a_b", "1").unwrap();
        store.set_setting("axb", "2").unwrap();
        assert_eq!(store.settings_with_prefix("a_").unwrap().len(), 1);
    }

    #[test]
    fn imports_skip_what_is_already_here() {
        let store = Store::in_memory().unwrap();
        let at = Timestamp::parse("2026-09-01T10:00:00Z").unwrap();
        store.add_bookmark("https://a.test/", "Mine", at).unwrap();
        let items = vec![
            ImportedEntry {
                url: "https://a.test/".into(),
                title: "Theirs".into(),
                at,
            },
            ImportedEntry {
                url: "https://b.test/".into(),
                title: "New".into(),
                at,
            },
        ];
        assert_eq!(store.import_bookmarks(&items).unwrap(), 1);
        let found = store.search_bookmarks("a.test", 5).unwrap();
        assert_eq!(found[0].title, "Mine");
        assert_eq!(store.import_history(&items).unwrap(), 2);
        // The same import again adds nothing.
        assert_eq!(store.import_history(&items).unwrap(), 0);
        assert_eq!(store.search_history("test", 10).unwrap().len(), 2);
    }

    fn sample_app(id: &str, scope: &str) -> WebApp {
        WebApp {
            id: id.into(),
            name: "Example".into(),
            short_name: "Ex".into(),
            start_url: format!("{scope}start"),
            scope: scope.into(),
            display: "standalone".into(),
            theme_color: Some("#112233".into()),
            background_color: None,
            icon_path: "/tmp/icon.png".into(),
            manifest_url: format!("{scope}manifest.json"),
            created_at: "2026-09-10T00:00:00Z".into(),
            last_opened_at: None,
            bounds: String::new(),
            workspace_id: None,
        }
    }

    #[test]
    fn web_apps_install_update_and_remove() {
        let store = Store::in_memory().unwrap();
        let app = sample_app("https://a.example/", "https://a.example/");
        store.add_web_app(&app).unwrap();
        assert_eq!(store.list_web_apps().unwrap(), vec![app.clone()]);

        // Reinstalling the same id updates in place rather than duplicating.
        let renamed = WebApp {
            name: "Example 2".into(),
            ..app.clone()
        };
        store.add_web_app(&renamed).unwrap();
        let listed = store.list_web_apps().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Example 2");

        assert!(store.remove_web_app(&app.id).unwrap());
        assert!(!store.remove_web_app(&app.id).unwrap());
        assert!(store.list_web_apps().unwrap().is_empty());
    }

    #[test]
    fn web_app_for_url_picks_the_longest_matching_scope() {
        let store = Store::in_memory().unwrap();
        store
            .add_web_app(&sample_app("root", "https://a.example/"))
            .unwrap();
        store
            .add_web_app(&sample_app("mail", "https://a.example/mail/"))
            .unwrap();
        let hit = store
            .web_app_for_url("https://a.example/mail/inbox")
            .unwrap()
            .unwrap();
        assert_eq!(hit.id, "mail");
        let root = store
            .web_app_for_url("https://a.example/docs")
            .unwrap()
            .unwrap();
        assert_eq!(root.id, "root");
        assert!(
            store
                .web_app_for_url("https://b.example/")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn web_app_open_time_and_bounds_persist() {
        let store = Store::in_memory().unwrap();
        store
            .add_web_app(&sample_app("x", "https://x.example/"))
            .unwrap();
        store.touch_web_app("x", Timestamp::now()).unwrap();
        store.set_web_app_bounds("x", "{\"x\":1}").unwrap();
        let app = store.web_app("x").unwrap().unwrap();
        assert!(app.last_opened_at.is_some());
        assert_eq!(app.bounds, "{\"x\":1}");
        // Bookkeeping survives a reinstall of the same id.
        store
            .add_web_app(&sample_app("x", "https://x.example/"))
            .unwrap();
        let again = store.web_app("x").unwrap().unwrap();
        assert!(again.last_opened_at.is_some());
        assert_eq!(again.bounds, "{\"x\":1}");
    }

    #[test]
    fn a_web_app_keeps_the_workspace_it_was_installed_from() {
        let store = Store::in_memory().unwrap();
        let workspace = WorkspaceId::new();
        let app = WebApp {
            workspace_id: Some(workspace),
            ..sample_app("x", "https://x.example/")
        };
        store.add_web_app(&app).unwrap();
        assert_eq!(
            store.web_app("x").unwrap().unwrap().workspace_id,
            Some(workspace)
        );
        // A reinstall that names no workspace keeps the one it had; one
        // from another workspace moves the app there.
        store
            .add_web_app(&sample_app("x", "https://x.example/"))
            .unwrap();
        assert_eq!(
            store.web_app("x").unwrap().unwrap().workspace_id,
            Some(workspace)
        );
        let elsewhere = WorkspaceId::new();
        store
            .add_web_app(&WebApp {
                workspace_id: Some(elsewhere),
                ..sample_app("x", "https://x.example/")
            })
            .unwrap();
        assert_eq!(
            store.web_app("x").unwrap().unwrap().workspace_id,
            Some(elsewhere)
        );
    }
}
