//! SQLite persistence for containers, workspaces and tabs.
//!
//! One connection, WAL mode, versioned migrations. Callers own threading;
//! the store is `Send` but not `Sync`, so wrap it in a mutex or dedicate a
//! thread to it.

use std::path::Path;

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
];

/// A saved page.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct Bookmark {
    /// URL.
    pub url: String,
    /// Title at save time.
    pub title: String,
    /// RFC 3339 creation time.
    pub created_at: String,
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
            self.conn.execute_batch(sql)?;
            self.conn.pragma_update(
                None,
                "user_version",
                i64::try_from(next).unwrap_or(i64::MAX),
            )?;
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
        Ok(())
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
                })
            },
        )?;
        rows.collect::<std::result::Result<_, _>>()
            .map_err(Into::into)
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

    /// Distinct recent visits matching `query` (substring on url or title), newest first.
    pub fn search_history(&self, query: &str, limit: usize) -> Result<Vec<HistoryEntry>> {
        let like = format!("%{}%", query.trim());
        let mut stmt = self.conn.prepare(
            "SELECT url, MAX(title), MAX(visited_at), COUNT(*) FROM history
             WHERE url LIKE ?1 OR title LIKE ?1
             GROUP BY url ORDER BY MAX(visited_at) DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(
            params![like, i64::try_from(limit).unwrap_or(i64::MAX)],
            |r| {
                Ok(HistoryEntry {
                    url: r.get(0)?,
                    title: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    last_visited_at: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    visits: r.get::<_, i64>(3)?.try_into().unwrap_or(u32::MAX),
                })
            },
        )?;
        rows.collect::<std::result::Result<_, _>>()
            .map_err(Into::into)
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
        let cutoff = (now - max_idle).to_rfc3339();
        let n = self.conn.execute(
            "UPDATE tabs SET state = 'discarded'
             WHERE tier = 'today' AND state != 'discarded' AND last_active_at < ?1",
            [cutoff],
        )?;
        Ok(n)
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
}
