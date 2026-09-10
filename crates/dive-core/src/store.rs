//! SQLite persistence for containers, workspaces and tabs.
//!
//! One connection, WAL mode, versioned migrations. Callers own threading;
//! the store is `Send` but not `Sync`, so wrap it in a mutex or dedicate a
//! thread to it.

use std::path::Path;
use std::time::Duration;

use crate::model::{
    Container, ContainerId, Profile, ProfileId, Tab, TabId, TabState, TabTier, Timestamp,
    Workspace, WorkspaceId,
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
];

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
    Ok(Some(backup))
}

/// How a history row reads on screen: its origin and title.
///
/// Two visits that differ only in a trailing slash or a tracking parameter
/// share this, and are worth one line rather than two. An untitled page falls
/// back to its full URL, since collapsing every blank title on a host would
/// hide real pages.
fn display_key(entry: &HistoryEntry) -> String {
    let origin = crate::origin_of(&entry.url).unwrap_or_default();
    if entry.title.is_empty() {
        entry.url.clone()
    } else {
        format!("{origin}\u{1f}{}", entry.title)
    }
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
    /// The site's remembered icon as a `data:` URL, when one is known.
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
    /// The site's remembered icon as a `data:` URL, when one is known.
    pub favicon: Option<String>,
}

/// Persistent store backed by SQLite.
pub struct Store {
    conn: Connection,
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
        let store = Self { conn };
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
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version) {
            let next = i + 1;
            tracing::info!(version = next, "applying migration");
            // Schema changes and their version marker are one unit. Without a
            // transaction, a crash between them leaves a half-applied migration
            // that cannot be safely retried on the next launch.
            let tx = self.conn.unchecked_transaction()?;
            tx.execute_batch(sql)?;
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

    /// Make sure a profile exists and every workspace belongs to one: a
    /// database from before profiles gets a "Personal" profile in the first
    /// container that adopts all its workspaces. Returns the first profile.
    pub fn ensure_default_profile(&self) -> Result<Profile> {
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
        self.conn.execute(
            "INSERT INTO tabs (id, workspace_id, tier, url, title, position, state, last_active_at, favicon)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, tier = excluded.tier,
             url = excluded.url, title = excluded.title, position = excluded.position,
             state = excluded.state, last_active_at = excluded.last_active_at,
             favicon = excluded.favicon",
            params![
                t.id.to_string(),
                t.workspace_id.map(|w| w.to_string()),
                t.tier.as_str(),
                t.url,
                t.title,
                t.position,
                t.state.as_str(),
                t.last_active_at.to_rfc3339(),
                t.favicon
            ],
        )?;
        Ok(())
    }

    /// Fetch one tab.
    pub fn tab(&self, id: TabId) -> Result<Tab> {
        let mut tab = self
            .conn
            .query_row(
                &format!("{TAB_SELECT} WHERE id = ?1"),
                [id.to_string()],
                tab_from_row,
            )
            .optional()?
            .ok_or_else(|| CoreError::NotFound {
                kind: "tab",
                id: id.to_string(),
            })?;
        self.fill_favicon(&mut tab);
        Ok(tab)
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

    /// Remember `data` as the icon every tab on `origin` should wear.
    pub fn set_favicon(&self, origin: &str, data: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO favicons (origin, data, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(origin) DO UPDATE SET data = excluded.data,
             updated_at = excluded.updated_at",
            params![origin, data, Timestamp::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// The icon remembered for `origin`, if one has ever been resolved.
    pub fn favicon(&self, origin: &str) -> Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT data FROM favicons WHERE origin = ?1",
                [origin],
                |r| r.get(0),
            )
            .optional()
            .map_err(Into::into)
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
    fn scope(&self) -> Result<String> {
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

    /// Saved logins for `profile`, by site then username.
    pub fn credentials(&self, profile: ProfileId) -> Result<Vec<Credential>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, profile_id, origin, username, created_at, last_used_at, uses
             FROM credentials WHERE profile_id = ?1 ORDER BY origin, username",
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
                theme_color, background_color, icon_path, manifest_url, created_at, last_opened_at, bounds)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(profile_id, id) DO UPDATE SET
                name = excluded.name, short_name = excluded.short_name,
                start_url = excluded.start_url, scope = excluded.scope, display = excluded.display,
                theme_color = excluded.theme_color, background_color = excluded.background_color,
                icon_path = excluded.icon_path, manifest_url = excluded.manifest_url",
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
            ],
        )?;
        Ok(())
    }

    /// Installed web apps for the current profile, most recently opened first.
    pub fn list_web_apps(&self) -> Result<Vec<WebApp>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, short_name, start_url, scope, display, theme_color, background_color,
                    icon_path, manifest_url, created_at, last_opened_at, bounds
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
                    icon_path, manifest_url, created_at, last_opened_at, bounds
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
                added +=
                    stmt.execute(params![item.url, item.title, item.at.to_rfc3339(), scope])?;
            }
        }
        tx.commit()?;
        Ok(added)
    }

    // ----- history -----

    /// Record a visit. Same URL within a minute updates the title instead of adding a row.
    /// "about:blank" is never filed as a title: it names the empty document, not the page.
    pub fn record_visit(&self, url: &str, title: &str, at: Timestamp) -> Result<()> {
        let title = if title == "about:blank" { "" } else { title };
        let scope = self.scope()?;
        let recent: Option<i64> = self
            .conn
            .query_row(
                "SELECT id FROM history WHERE url = ?1 AND profile_id = ?2 ORDER BY visited_at DESC LIMIT 1",
                params![url, scope],
                |r| r.get(0),
            )
            .optional()?;
        let last_at: Option<String> = match recent {
            Some(id) => self
                .conn
                .query_row("SELECT visited_at FROM history WHERE id = ?1", [id], |r| {
                    r.get(0)
                })
                .optional()?,
            None => None,
        };
        let fresh = last_at
            .and_then(|t| Timestamp::parse(&t).ok())
            .is_some_and(|t| (at.0 - t.0).abs() < time::Duration::minutes(1));
        if fresh && let Some(id) = recent {
            self.conn.execute(
                "UPDATE history SET title = ?1 WHERE id = ?2 AND ?1 != ''",
                params![title, id],
            )?;
            return Ok(());
        }
        self.conn.execute(
            "INSERT INTO history (profile_id, url, title, visited_at) VALUES (?4, ?1, ?2, ?3)",
            params![url, title, at.to_rfc3339(), scope],
        )?;
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

    /// Forget every visit to one URL; returns how many rows went.
    pub fn remove_history(&self, url: &str) -> Result<usize> {
        Ok(self.conn.execute(
            "DELETE FROM history WHERE url = ?1 AND profile_id = ?2",
            params![url, self.scope()?],
        )?)
    }

    /// Delete every visit of this profile; returns how many rows went.
    pub fn clear_history(&self) -> Result<usize> {
        Ok(self
            .conn
            .execute("DELETE FROM history WHERE profile_id = ?1", [self.scope()?])?)
    }

    /// Forget every cached site icon. Icons record which origins were
    /// visited, so clearing history clears them too.
    pub fn clear_favicons(&self) -> Result<usize> {
        Ok(self.conn.execute("DELETE FROM favicons", [])?)
    }

    /// Delete visits older than `cutoff`; returns how many rows went.
    pub fn prune_history(&self, cutoff: Timestamp) -> Result<usize> {
        Ok(self.conn.execute(
            "DELETE FROM history WHERE visited_at < ?1 AND profile_id = ?2",
            params![cutoff.to_rfc3339(), self.scope()?],
        )?)
    }

    /// Distinct recent visits matching `query` (substring on url or title), newest first.
    ///
    /// `GROUP BY url` alone still yields rows a reader cannot tell apart: a
    /// trailing slash or a stray query parameter makes two URLs distinct while
    /// the title and host stay identical, so a short list fills up with what
    /// looks like the same entry twice. Rows are collapsed by what is actually
    /// on screen -- see [`display_key`] -- which is why the query over-fetches
    /// before the caller's `limit` is applied.
    pub fn search_history(&self, query: &str, limit: usize) -> Result<Vec<HistoryEntry>> {
        let like = format!("%{}%", like_escape(query.trim()));
        // Enough headroom that a run of near-duplicates cannot starve the
        // list, capped so an empty query never walks the whole table.
        let fetch = limit.saturating_mul(4).clamp(limit, 200);
        let mut stmt = self.conn.prepare(
            "SELECT url, MAX(title), MAX(visited_at), COUNT(*) FROM history
             WHERE profile_id = ?3 AND (url LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\')
             GROUP BY url ORDER BY MAX(visited_at) DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(
            params![
                like,
                i64::try_from(fetch).unwrap_or(i64::MAX),
                self.scope()?
            ],
            |r| {
                Ok(HistoryEntry {
                    url: r.get(0)?,
                    title: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    last_visited_at: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    visits: r.get::<_, i64>(3)?.try_into().unwrap_or(u32::MAX),
                    favicon: None,
                })
            },
        )?;

        let mut out: Vec<HistoryEntry> = Vec::with_capacity(limit);
        let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for entry in rows {
            let entry = entry?;
            match seen.get(&display_key(&entry)) {
                // Newest wins, because the rows arrive newest first; the older
                // twin only lends its visit count to the one on screen.
                Some(&i) => out[i].visits = out[i].visits.saturating_add(entry.visits),
                None if out.len() < limit => {
                    seen.insert(display_key(&entry), out.len());
                    out.push(entry);
                }
                // Full, but keep folding counts into the rows already chosen.
                None => {}
            }
        }
        for entry in &mut out {
            entry.favicon = self.site_favicon(&entry.url);
        }
        Ok(out)
    }

    /// The icon remembered for `url`'s origin, if any.
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
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }

    /// Write a related set of settings as one all-or-nothing decision.
    pub fn set_settings_atomic(&self, entries: &[(String, String)]) -> Result<()> {
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
        store
            .set_favicon("https://example.com", "data:image/png;base64,AAAA")
            .unwrap();

        // Neither tab has an icon of its own; both wear their site's.
        let icon = Some("data:image/png;base64,AAAA");
        assert_eq!(store.tab(a.id).unwrap().favicon.as_deref(), icon);
        assert_eq!(store.tab(b.id).unwrap().favicon.as_deref(), icon);
        assert_eq!(store.tab(other.id).unwrap().favicon, None);

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
    fn history_collapses_rows_that_read_the_same() {
        let store = Store::in_memory().unwrap();
        let t0 = Timestamp::now();
        // The shape the palette kept showing twice: one origin, one title,
        // URLs that differ only in a slash or a stray parameter.
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
        assert_eq!(all.len(), 2, "three YouTube URLs are one line");
        assert_eq!(all[0].url, "https://www.youtube.com/", "newest wins");
        assert_eq!(all[0].visits, 3, "the twins lend their counts");
        assert_eq!(all[1].title, "B site");

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
        let icon = "data:image/png;base64,AAAA";
        store.set_favicon("https://a.dev", icon).unwrap();
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
}
