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
    /// The database was last written by a newer build, whose schema this
    /// one does not know. Kept apart from [`CoreError::Invalid`] so the app
    /// can tell the person to update rather than offer to start over.
    #[error(
        "database schema is version {found}, newer than the {known} this build knows; \
         open it with a newer Dive"
    )]
    NewerSchema {
        /// The schema version the file carries.
        found: usize,
        /// The newest schema version this build can migrate to.
        known: usize,
    },
}
