//! Error type for core operations.

use thiserror::Error;

/// Failure modes of the core layer.
#[derive(Debug, Error)]
pub enum CoreError {
    /// A database operation failed.
    #[error("database: {0}")]
    Db(#[from] rusqlite::Error),
    /// An entity was not found.
    #[error("{kind} not found: {id}")]
    NotFound {
        /// Entity kind, e.g. `workspace`.
        kind: &'static str,
        /// Identifier that was looked up.
        id: String,
    },
    /// A command id was registered twice.
    #[error("command already registered: {0}")]
    DuplicateCommand(String),
    /// A command run failed.
    #[error("command {id} failed: {message}")]
    CommandFailed {
        /// Command id.
        id: String,
        /// Failure detail.
        message: String,
    },
    /// Invalid input.
    #[error("invalid: {0}")]
    Invalid(String),
}
