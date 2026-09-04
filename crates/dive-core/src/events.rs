//! Broadcast bus for state changes. The UI, agent and MCP server subscribe.

use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::sync::broadcast;

use crate::model::{Profile, ProfileId, Tab, TabId, Workspace, WorkspaceId};

/// Something changed in the core state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum CoreEvent {
    /// A workspace was created or updated.
    WorkspaceUpserted(Workspace),
    /// A workspace was removed.
    WorkspaceRemoved(WorkspaceId),
    /// The active workspace changed.
    WorkspaceActivated(WorkspaceId),
    /// A tab was created or updated.
    TabUpserted(Tab),
    /// A tab was closed.
    TabClosed(TabId),
    /// The focused tab changed.
    TabActivated(TabId),
    /// A profile was created or updated.
    ProfileUpserted(Profile),
    /// A profile was removed.
    ProfileRemoved(ProfileId),
    /// The active profile changed.
    ProfileActivated(ProfileId),
}

/// Cheap-to-clone handle to the event bus.
#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<CoreEvent>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl EventBus {
    /// Create a bus with a bounded buffer per subscriber.
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self { tx }
    }

    /// Publish an event; returns how many subscribers received it.
    pub fn publish(&self, event: CoreEvent) -> usize {
        self.tx.send(event).unwrap_or(0)
    }

    /// Subscribe to all future events.
    pub fn subscribe(&self) -> broadcast::Receiver<CoreEvent> {
        self.tx.subscribe()
    }
}
