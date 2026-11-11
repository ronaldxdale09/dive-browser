#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source scripts/native-toolchain.sh
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) echo "skipping test:probes on Windows (POSIX-only, as in CI)" ;;
  *) pnpm test:probes ;;
esac
cargo fmt --all -- --check
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @dive/desktop exec vite build
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm test:runtime
