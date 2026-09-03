//! Domain entities. Ids are UUID v7 so they sort by creation time.

use serde::{Deserialize, Serialize};
use specta::Type;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

/// A UTC instant serialized as an RFC 3339 string.
///
/// Hand-written serde and specta impls so the wire type is a plain string
/// in both directions (a `#[serde(with)]` field would split the exported
/// TypeScript into Serialize/Deserialize variants).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Timestamp(pub OffsetDateTime);

impl Timestamp {
    /// Current UTC time.
    pub fn now() -> Self {
        Self(OffsetDateTime::now_utc())
    }

    /// RFC 3339 text.
    pub fn to_rfc3339(self) -> String {
        self.0.format(&Rfc3339).unwrap_or_default()
    }

    /// Parse RFC 3339 text.
    pub fn parse(s: &str) -> Result<Self, time::error::Parse> {
        OffsetDateTime::parse(s, &Rfc3339).map(Self)
    }
}

impl std::ops::Sub<time::Duration> for Timestamp {
    type Output = Self;
    fn sub(self, rhs: time::Duration) -> Self {
        Self(self.0 - rhs)
    }
}

impl Serialize for Timestamp {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_rfc3339())
    }
}

impl<'de> Deserialize<'de> for Timestamp {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = String::deserialize(d)?;
        Self::parse(&text).map_err(serde::de::Error::custom)
    }
}

impl Type for Timestamp {
    fn definition(types: &mut specta::Types) -> specta::datatype::DataType {
        String::definition(types)
    }
}

macro_rules! id_type {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
        #[serde(transparent)]
        pub struct $name(pub Uuid);

        impl $name {
            /// Generate a fresh time-ordered id.
            pub fn new() -> Self {
                Self(Uuid::now_v7())
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(f)
            }
        }

        impl std::str::FromStr for $name {
            type Err = uuid::Error;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Uuid::parse_str(s).map(Self)
            }
        }
    };
}

id_type!(
    /// Identifies a [`Workspace`].
    WorkspaceId
);
id_type!(
    /// Identifies a [`Container`].
    ContainerId
);
id_type!(
    /// Identifies a [`Tab`].
    TabId
);

/// An isolated browsing profile: cookies, storage, cache and service workers.
/// Maps 1:1 to a CEF request context with its own cache path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Container {
    /// Stable id.
    pub id: ContainerId,
    /// Human name shown in settings.
    pub name: String,
    /// Directory name under the app data dir holding this profile's cache.
    pub cache_dir: String,
    /// Whether session cookies survive restarts.
    pub persist_cookies: bool,
}

impl Container {
    /// Create a container whose cache dir is derived from its id.
    pub fn new(name: impl Into<String>) -> Self {
        let id = ContainerId::new();
        Self {
            id,
            name: name.into(),
            cache_dir: format!("container-{id}"),
            persist_cookies: true,
        }
    }
}

/// A named set of tabs bound to one container.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Workspace {
    /// Stable id.
    pub id: WorkspaceId,
    /// Display name.
    pub name: String,
    /// Accent color as a CSS hex string, e.g. `#0F6E75`.
    pub color: String,
    /// Icon identifier the UI resolves to a glyph, e.g. `layers`.
    pub icon: String,
    /// Container whose profile this workspace browses in.
    pub container_id: ContainerId,
    /// Order in the rail; lower first.
    pub position: i32,
    /// Creation timestamp.
    pub created_at: Timestamp,
}

impl Workspace {
    /// The glyph a workspace wears until someone picks another one.
    pub fn default_icon() -> &'static str {
        "layers"
    }

    /// Create a workspace in `container` appended at `position`.
    pub fn new(name: impl Into<String>, container: ContainerId, position: i32) -> Self {
        Self {
            id: WorkspaceId::new(),
            name: name.into(),
            color: "#0F6E75".into(),
            icon: Self::default_icon().into(),
            container_id: container,
            position,
            created_at: Timestamp::now(),
        }
    }
}

/// Which strip a tab lives in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TabTier {
    /// Global, shown in every workspace.
    Essential,
    /// Pinned to one workspace, never auto-archived.
    Pinned,
    /// Ordinary tab, auto-archived after inactivity.
    Today,
}

/// Lifecycle state of a tab's renderer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TabState {
    /// Renderer alive and painting.
    Active,
    /// Renderer alive but throttled.
    Sleeping,
    /// Renderer torn down; only metadata kept.
    Discarded,
}

/// A browsing tab.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Tab {
    /// Stable id.
    pub id: TabId,
    /// Owning workspace; `None` for essentials.
    pub workspace_id: Option<WorkspaceId>,
    /// Which strip it lives in.
    pub tier: TabTier,
    /// Current URL.
    pub url: String,
    /// Page title, empty until loaded.
    pub title: String,
    /// Site icon as a `data:` URL, resolved from the page once it loads.
    /// `None` until then, and cleared whenever the tab leaves its origin.
    pub favicon: Option<String>,
    /// Order within its tier; lower first.
    pub position: i32,
    /// Renderer state.
    pub state: TabState,
    /// Last time the tab was focused.
    pub last_active_at: Timestamp,
}

impl Tab {
    /// Create a `Today` tab in `workspace` at `position`.
    pub fn new(workspace: WorkspaceId, url: impl Into<String>, position: i32) -> Self {
        Self {
            id: TabId::new(),
            workspace_id: Some(workspace),
            tier: TabTier::Today,
            url: url.into(),
            title: String::new(),
            favicon: None,
            position,
            state: TabState::Active,
            last_active_at: Timestamp::now(),
        }
    }
}

impl TabTier {
    /// Stable string form stored in the database.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Essential => "essential",
            Self::Pinned => "pinned",
            Self::Today => "today",
        }
    }

    /// Parse the stored string form.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "essential" => Some(Self::Essential),
            "pinned" => Some(Self::Pinned),
            "today" => Some(Self::Today),
            _ => None,
        }
    }
}

impl TabState {
    /// Stable string form stored in the database.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Sleeping => "sleeping",
            Self::Discarded => "discarded",
        }
    }

    /// Parse the stored string form.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "active" => Some(Self::Active),
            "sleeping" => Some(Self::Sleeping),
            "discarded" => Some(Self::Discarded),
            _ => None,
        }
    }
}
