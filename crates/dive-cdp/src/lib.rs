//! Transport-agnostic Chrome `DevTools` Protocol (CDP) session.
//!
//! The engine layer (CEF) owns the wire: it pushes outgoing JSON through a
//! [`Transport`] and feeds every incoming message to
//! [`CdpSession::handle_incoming`]. This crate only multiplexes request ids,
//! resolves pending calls, and broadcasts events, so it can be unit-tested
//! without a browser.

pub mod error;
pub mod page;
mod session;

pub use error::CdpError;
pub use session::{CdpEvent, CdpSession, Transport};

/// Convenience alias used throughout the crate.
pub type Result<T> = std::result::Result<T, CdpError>;
