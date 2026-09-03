//! Error type crossing the IPC boundary.

use serde::Serialize;
use specta::Type;

/// A failure reported to the chrome as a plain message.
#[derive(Debug, Clone, Serialize, Type, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    /// Human-readable description.
    pub message: String,
}

impl AppError {
    /// Build from anything displayable.
    pub fn new(message: impl std::fmt::Display) -> Self {
        Self {
            message: message.to_string(),
        }
    }
}

macro_rules! from_display {
    ($($t:ty),*) => {$(
        impl From<$t> for AppError {
            fn from(e: $t) -> Self { Self::new(e) }
        }
    )*};
}

from_display!(
    dive_core::CoreError,
    tauri::Error,
    url::ParseError,
    std::io::Error,
    anyhow::Error
);

/// Result alias for command handlers.
pub type AppResult<T> = std::result::Result<T, AppError>;
