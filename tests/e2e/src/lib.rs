//! Dive integration test suite (Tiers 1 - 4).
//!
//! These tests run against an in-memory store, a scripted CDP transport and
//! a fake `Browser`; they never start CEF or a window. The live end-to-end
//! checks that drive the real app are `scripts/live-check.sh` and
//! `scripts/benchmark-memory.sh`, run by the `live` CI job.
//!
//! Requirement-driven, opaque-box integration tests covering:
//! - R1: Engine Flags & Startup Performance
//! - R2: Tab Discarding & Memory Saver Architecture
//! - R3: Crash Isolation & Session Recovery Hardening
//! - R4: Core Developer Feature Reliability & Verification

#[cfg(test)]
mod fixtures;
#[cfg(test)]
mod tier1_feature_coverage;
#[cfg(test)]
mod tier2_boundaries;
#[cfg(test)]
mod tier3_interactions;
#[cfg(test)]
mod tier4_scenarios;

/// Return metadata on total tests and feature areas for runner verification.
pub fn test_suite_metadata() -> &'static str {
    "Dive Browser E2E Test Suite v1.0.0 (Tiers 1-4)"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_suite_initialization() {
        assert!(test_suite_metadata().contains("Dive Browser E2E"));
    }
}
