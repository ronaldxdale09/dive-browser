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
];

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
            "INSERT INTO tabs (id, workspace_id, tier, url, title, position, state, last_active_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, tier = excluded.tier,
             url = excluded.url, title = excluded.title, position = excluded.position,
             state = excluded.state, last_active_at = excluded.last_active_at",
            params![
                t.id.to_string(),
                t.workspace_id.map(|w| w.to_string()),
                t.tier.as_str(),
                t.url,
                t.title,
                t.position,
                t.state.as_str(),
                t.last_active_at.to_rfc3339()
            ],
        )?;
        Ok(())
    }

    /// Fetch one tab.
    pub fn tab(&self, id: TabId) -> Result<Tab> {
        self.conn
            .query_row(
                &format!("{TAB_SELECT} WHERE id = ?1"),
                [id.to_string()],
                tab_from_row,
            )
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
        rows.collect::<std::result::Result<_, _>>()
            .map_err(Into::into)
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
    "SELECT id, workspace_id, tier, url, title, position, state, last_active_at FROM tabs";

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
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
