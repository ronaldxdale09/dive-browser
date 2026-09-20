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
    /// Chromium accepted a call but did not answer before the deadline.
    #[error("cdp call timed out: {method}")]
    Timeout {
        /// Fully-qualified CDP method that stalled.
        method: String,
    },
    /// A payload could not be encoded or decoded.
    #[error("serialization: {0}")]
    Serialization(#[from] serde_json::Error),
    /// A caller requested work that would be unsafe or nonsensical.
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    /// The result did not contain the field the caller expected.
    #[error("missing field in result: {0}")]
    MissingField(&'static str),
}

impl CdpError {
    /// Whether this failure is just the tab being gone.
    ///
    /// A closing tab tears its session down while a dozen subsystems are
    /// still setting themselves up on it, and each of them used to report
    /// the same event at warning level: one native view that timed out
    /// produced twelve warnings in the log, none of which was the cause. A
    /// caller that asks this can say it once, quietly, and leave warnings
    /// for things somebody could act on.
    pub fn is_gone(&self) -> bool {
        match self {
            Self::Closed => true,
            // The transport dying is the same event seen from one layer
            // down: the socket to a tab that no longer exists.
            Self::Transport(detail) => {
                detail.contains("closed") || detail.contains("channel") || detail.contains("send")
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_closed_session_is_the_tab_going_away_and_nothing_else_is() {
        assert!(CdpError::Closed.is_gone());
        assert!(CdpError::Transport("channel closed".into()).is_gone());
        assert!(
            !CdpError::Timeout {
                method: "Page.enable".into()
            }
            .is_gone()
        );
        assert!(
            !CdpError::Protocol {
                code: -32000,
                message: "Not allowed".into()
            }
            .is_gone(),
            "a refusal is a real problem and must stay visible"
        );
        assert!(!CdpError::MissingField("frameId").is_gone());
    }
}
