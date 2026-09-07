//! Dive's engine-independent core: the workspace/tab model, its SQLite
//! persistence, the command registry, and the event bus that the UI, the
//! agent and the MCP server all observe.

pub mod commands;
pub mod error;
pub mod events;
pub mod model;
pub mod store;

pub use commands::{Command, CommandId, CommandRegistry, CommandScope};
pub use error::CoreError;
pub use events::{CoreEvent, EventBus};
pub use model::{
    Container, ContainerId, Profile, ProfileId, Tab, TabId, TabState, TabTier, Timestamp,
    Workspace, WorkspaceId,
};
pub use store::{Bookmark, HistoryEntry, ImportedEntry, Store, origin_of};

/// Convenience alias used throughout the crate.
pub type Result<T> = std::result::Result<T, CoreError>;
