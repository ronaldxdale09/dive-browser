//! Error type for CDP calls.

use thiserror::Error;

/// Failure modes of a CDP call.
#[derive(Debug, Error)]
pub enum CdpError {
    /// The browser answered with a protocol-level error object.
    #[error("cdp error {code}: {message}")]
    Protocol {
        /// Numeric code from the `error.code` field.
        code: i64,
        /// Human-readable message from the `error.message` field.
        message: String,
    },
    /// The transport could not deliver the message.
    #[error("transport failure: {0}")]
    Transport(String),
    /// The session was closed before the call completed.
    #[error("session closed")]
    Closed,
    /// A payload could not be encoded or decoded.
    #[error("serialization: {0}")]
    Serialization(#[from] serde_json::Error),
    /// The result did not contain the field the caller expected.
    #[error("missing field in result: {0}")]
    MissingField(&'static str),
}
