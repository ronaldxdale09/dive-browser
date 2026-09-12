#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source scripts/native-toolchain.sh
cargo test --manifest-path vendor/tauri-runtime-cef/Cargo.toml --lib
