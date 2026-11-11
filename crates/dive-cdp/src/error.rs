//! Error type for CDP calls.

use thiserror::Error;

/// What Chromium answers (code -32000) when a call lands while the page's
/// document is being replaced. The one list every caller shares: it used to be
/// copied into five places, and only one of them knew the third entry.
pub const NAVIGATION_RACE_MESSAGES: [&str; 3] = [
    "Inspected target navigated or closed",
    "Not attached to an active page",
    "Execution context was destroyed.",
];

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
    /// The browser's reply was too large to accept; the call is failed and
    /// the session kept.
    #[error("the browser's reply was {bytes} bytes, over the {limit}-byte limit")]
    ResponseTooLarge {
        /// Size of the refused reply.
        bytes: usize,
        /// The limit it exceeded.
        limit: usize,
    },
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

    /// Whether the call failed only because the page's document went away while
    /// it was in flight: a navigation, a reload, a frame swap. Worth one retry;
    /// never a reason to tell the person something broke.
    pub fn is_navigation_race(&self) -> bool {
        matches!(self, Self::Protocol { code: -32000, message }
            if NAVIGATION_RACE_MESSAGES.contains(&message.as_str()))
    }

    /// [`Self::is_navigation_race`] for an error that has already been
    /// flattened to its `Display` text (`cdp error -32000: ...`), as
    /// `locator::Failure::Engine` and `BrowserError::Other` carry it.
    pub fn is_navigation_race_text(text: &str) -> bool {
        text.strip_prefix("cdp error -32000: ")
            .is_some_and(|message| NAVIGATION_RACE_MESSAGES.contains(&message))
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

    #[test]
    fn is_navigation_race_is_the_listed_messages_under_code_32000_only() {
        for message in NAVIGATION_RACE_MESSAGES {
            let race = CdpError::Protocol {
                code: -32000,
                message: message.into(),
            };
            assert!(race.is_navigation_race(), "{message}");
            assert!(CdpError::is_navigation_race_text(&race.to_string()));
            assert!(
                !CdpError::Protocol {
                    code: -32601,
                    message: message.into()
                }
                .is_navigation_race(),
                "{message} under another code is a different failure"
            );
        }
        assert!(!CdpError::Closed.is_navigation_race());
        assert!(
            !CdpError::Protocol {
                code: -32000,
                message: "Not allowed".into()
            }
            .is_navigation_race()
        );
        assert!(!CdpError::is_navigation_race_text("session closed"));
        assert!(!CdpError::is_navigation_race_text(
            "cdp error -32601: Not attached to an active page"
        ));
    }
}
