//! SQLite persistence for containers, workspaces and tabs.
//!
//! One connection, WAL mode, versioned migrations. Callers own threading;
//! the store is `Send` but not `Sync`, so wrap it in a mutex or dedicate a
//! thread to it.

use std::path::Path;
use std::time::Duration;

use crate::model::{
    Container, ContainerId, Tab, TabId, TabState, TabTier, Timestamp, Workspace, WorkspaceId,
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
];

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
        Self::init(Connection::open(path)?)
    }

    /// Open an in-memory database, for tests and previews.
    pub fn in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
        // A second Dive process or a short-lived SQLite checkpoint should wait
        // instead of surfacing an immediate, user-visible `database is locked`.
        conn.busy_timeout(Duration::from_secs(5))?;
        let store = Self { conn };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<()> {
        let version: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))?;
        let version = usize::try_from(version).unwrap_or(0);
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
            "INSERT INTO workspaces (id, name, color, icon, container_id, position, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color,
             icon = excluded.icon, container_id = excluded.container_id, position = excluded.position",
            params![
                w.id.to_string(),
                w.name,
                w.color,
                w.icon,
                w.container_id.to_string(),
                w.position,
                w.created_at.to_rfc3339()
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
        let n = self
            .conn
            .execute("DELETE FROM tabs WHERE id = ?1", [id.to_string()])?;
        if n == 0 {
            return Err(CoreError::NotFound {
                kind: "tab",
                id: id.to_string(),
            });
        }
        self.conn
            .execute("DELETE FROM tab_scroll WHERE tab_id = ?1", [id.to_string()])?;
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

    // ----- bookmarks -----

    /// Add or refresh a bookmark.
    pub fn add_bookmark(&self, url: &str, title: &str, at: Timestamp) -> Result<()> {
        self.conn.execute(
            "INSERT INTO bookmarks (url, title, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(url) DO UPDATE SET title = CASE WHEN excluded.title != '' THEN excluded.title ELSE bookmarks.title END",
            params![url, title, at.to_rfc3339()],
        )?;
        Ok(())
    }

    /// Remove a bookmark; returns whether one existed.
    pub fn remove_bookmark(&self, url: &str) -> Result<bool> {
        Ok(self
            .conn
            .execute("DELETE FROM bookmarks WHERE url = ?1", [url])?
            > 0)
    }

    /// Whether `url` is bookmarked.
    pub fn is_bookmarked(&self, url: &str) -> Result<bool> {
        Ok(self
            .conn
            .query_row("SELECT 1 FROM bookmarks WHERE url = ?1", [url], |_| Ok(()))
            .optional()?
            .is_some())
    }

    /// Bookmarks matching `query`, newest first.
    pub fn search_bookmarks(&self, query: &str, limit: usize) -> Result<Vec<Bookmark>> {
        let like = format!("%{}%", query.trim());
        let mut stmt = self.conn.prepare("SELECT url, title, created_at FROM bookmarks WHERE url LIKE ?1 OR title LIKE ?1 ORDER BY created_at DESC LIMIT ?2")?;
        let rows = stmt.query_map(
            params![like, i64::try_from(limit).unwrap_or(i64::MAX)],
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

    // ----- history -----

    /// Record a visit. Same URL within a minute updates the title instead of adding a row.
    pub fn record_visit(&self, url: &str, title: &str, at: Timestamp) -> Result<()> {
        let recent: Option<i64> = self
            .conn
            .query_row(
                "SELECT id FROM history WHERE url = ?1 ORDER BY visited_at DESC LIMIT 1",
                [url],
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
            "INSERT INTO history (url, title, visited_at) VALUES (?1, ?2, ?3)",
            params![url, title, at.to_rfc3339()],
        )?;
        Ok(())
    }

    /// Live tab count per workspace, for the rail's badges. Discarded tabs are
    /// left out: they are metadata for a tab that is no longer really open.
    pub fn tab_counts(&self) -> Result<Vec<(WorkspaceId, u32)>> {
        let mut stmt = self.conn.prepare(
            "SELECT workspace_id, COUNT(*) FROM tabs
             WHERE workspace_id IS NOT NULL AND state != 'discarded'
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

    /// Delete every visit; returns how many rows went.
    pub fn clear_history(&self) -> Result<usize> {
        Ok(self.conn.execute("DELETE FROM history", [])?)
    }

    /// Delete visits older than `cutoff`; returns how many rows went.
    pub fn prune_history(&self, cutoff: Timestamp) -> Result<usize> {
        Ok(self.conn.execute(
            "DELETE FROM history WHERE visited_at < ?1",
            [cutoff.to_rfc3339()],
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
        let like = format!("%{}%", query.trim());
        // Enough headroom that a run of near-duplicates cannot starve the
        // list, capped so an empty query never walks the whole table.
        let fetch = limit.saturating_mul(4).clamp(limit, 200);
        let mut stmt = self.conn.prepare(
            "SELECT url, MAX(title), MAX(visited_at), COUNT(*) FROM history
             WHERE url LIKE ?1 OR title LIKE ?1
             GROUP BY url ORDER BY MAX(visited_at) DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(
            params![like, i64::try_from(fetch).unwrap_or(i64::MAX)],
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

    /// Write a setting.
    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }

    /// The most recently active, non-discarded tab of `workspace`, if any.
    pub fn last_active_tab(&self, workspace: WorkspaceId) -> Result<Option<Tab>> {
        let mut tab = self
            .conn
            .query_row(
                &format!(
                    "{TAB_SELECT} WHERE workspace_id = ?1 AND state != 'discarded'
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

    /// Discard every idle candidate at once, with no engine-side exclusions.
    /// The app's sweep applies its rules first and calls [`Store::discard_tabs`].
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
    "SELECT id, name, color, icon, container_id, position, created_at FROM workspaces";
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

fn workspace_from_row(r: &Row<'_>) -> rusqlite::Result<Workspace> {
    Ok(Workspace {
        id: parse_id(&r.get::<_, String>(0)?)?,
        name: r.get(1)?,
        color: r.get(2)?,
        icon: r.get(3)?,
        container_id: parse_id(&r.get::<_, String>(4)?)?,
        position: r.get(5)?,
        created_at: parse_time(&r.get::<_, String>(6)?)?,
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

#[cfg(test)]
mod tests {
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
        let w = Workspace::new("Work", c.id, 0);
        store.upsert_workspace(&w).unwrap();
        (store, w)
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
        let mut later = Workspace::new("Second", w.container_id, 1);
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
    fn settings_roundtrip_and_last_active_tab() {
        let (store, w) = seeded();
        assert_eq!(store.setting("active_tab").unwrap(), None);
        store.set_setting("active_tab", "x").unwrap();
        store.set_setting("active_tab", "y").unwrap();
        assert_eq!(store.setting("active_tab").unwrap().as_deref(), Some("y"));

        assert!(store.last_active_tab(w.id).unwrap().is_none());
        let now = Timestamp::now();
        let mut older = Tab::new(w.id, "https://older", 0);
        older.last_active_at = now - time::Duration::hours(2);
        let mut newest_but_discarded = Tab::new(w.id, "https://gone", 1);
        newest_but_discarded.state = TabState::Discarded;
        let mut newer = Tab::new(w.id, "https://newer", 2);
        newer.last_active_at = now - time::Duration::hours(1);
        for t in [&older, &newest_but_discarded, &newer] {
            store.upsert_tab(t).unwrap();
        }
        assert_eq!(
            store.last_active_tab(w.id).unwrap().unwrap().url,
            "https://newer"
        );
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
    fn tab_counts_skip_discarded_tabs() {
        let (store, w) = seeded();
        store
            .upsert_tab(&Tab::new(w.id, "https://a.dev", 0))
            .unwrap();
        let mut gone = Tab::new(w.id, "https://b.dev", 1);
        gone.state = TabState::Discarded;
        store.upsert_tab(&gone).unwrap();
        assert_eq!(store.tab_counts().unwrap(), vec![(w.id, 1)]);
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
        let other = Workspace::new("Other", w.container_id, 1);
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
    fn discard_tabs_skips_missing_and_already_discarded() {
        let (store, w) = seeded();
        let a = Tab::new(w.id, "https://a", 0);
        store.upsert_tab(&a).unwrap();
        let first = store.discard_tabs(&[a.id, TabId::new()]).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].state, TabState::Discarded);
        assert!(store.discard_tabs(&[a.id]).unwrap().is_empty());
    }
}
