#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source scripts/native-toolchain.sh
pnpm test:probes
cargo fmt --all -- --check
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @dive/desktop exec vite build
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm test:runtime
