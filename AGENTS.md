# AGENTS.md

Orientation for coding agents. [CONTRIBUTING.md](CONTRIBUTING.md) is the
fuller version; this file lists what to run and what breaks if ignored.

## What this is

Dive is a developer browser: a Tauri v2 host embedding CEF (Chromium), a React
chrome, an MCP server and an in-app agent. It ships for macOS arm64 and
Windows x64. Rust workspace plus a pnpm workspace (`apps/desktop`).

## Where things live

The map is "Where things live" in [CONTRIBUTING.md](CONTRIBUTING.md#where-things-live).
Also:

- `scripts/` has the probes, benchmarks and release tooling; every script has a
  row in [scripts/README.md](scripts/README.md).
- `docs/` has design notes and references ([docs/README.md](docs/README.md)),
  including [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md) and
  [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md).

## Commands

```bash
pnpm install
pnpm dev          # tauri dev
pnpm check        # the gate: probes, fmt, typecheck, lint, tests, vite build, clippy, cargo test, runtime tests
pnpm typecheck
pnpm lint
cargo test -p <crate> <filter>
pnpm --filter @dive/desktop exec vitest run <file>
python3 -m unittest discover -s scripts/tests -p '<pattern>'
```

CI runs more than `pnpm check`; see "The check that has to pass" in
CONTRIBUTING.md.

## Rules that break things if ignored

- IPC commands do not run on the main thread. Hop with `run_on_main_thread`
  before touching a CEF view (CONTRIBUTING "Threading"). Follow an existing
  command exactly.
- Lock order is `host`, then `store` (doc on `AppState` in
  `apps/desktop/src-tauri/src/state.rs`).
- A script under `src-tauri/src/inject/` is registered in both loaders
  (`pagescript.rs` and `src/lib/injected.ts`) and tested by what it does to a
  DOM, not by its text (CONTRIBUTING "Injected page scripts").
- Any Rust IPC change regenerates `apps/desktop/src/generated/bindings.ts`;
  commit it in the same commit. CI diffs it.
- Clippy is pedantic with warnings denied. A lint is a build failure.
- A new `DIVE_*` environment variable must be added to
  `docs/ENVIRONMENT.md`, or `pnpm test:probes` fails.

## Gotchas

- `cargo test -p dive-desktop` without a filter rewrites `bindings.ts` (the
  `export_bindings` test). Check `git diff` afterwards.
- On macOS `scripts/native-toolchain.sh` picks a linkable SDK. If cargo still
  cannot find one, `DEVELOPER_DIR=/Library/Developer/CommandLineTools` helps.
- Throwaway instances use `DIVE_DATA_DIR=$(mktemp -d)` and
  `DIVE_USE_MOCK_KEYCHAIN=1`, never a real profile (see
  [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)).
- `vendor/tauri-runtime-cef` is excluded from the workspace; `pnpm test:runtime`
  tests it, and it keeps upstream's rustfmt style (`cargo fmt --all` skips it).
- Windows cannot be built from a Mac ([docs/WINDOWS.md](docs/WINDOWS.md)).

## Commits

Conventional commits (`type(scope): subject`), worded as what the change does
for the user, for example
`fix(memory): compile pressure notification hooks on macOS only`. One concern
per change; say what you actually verified. See CONTRIBUTING.md "Commits and
pull requests".
