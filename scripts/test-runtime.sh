#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source scripts/native-toolchain.sh
# Upstream's style (vendor/tauri-runtime-cef/rustfmt.toml), so the patch
# against upstream stays readable; the workspace `cargo fmt --all` skips it.
cargo fmt --manifest-path vendor/tauri-runtime-cef/Cargo.toml -- --check
cargo test --manifest-path vendor/tauri-runtime-cef/Cargo.toml --lib --features native-test-manifest
