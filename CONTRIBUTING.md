# Contributing to Dive

Thanks for taking a look. This file is the short version of how the repo
expects to be worked in; `docs/PLAN.md` has the architecture reasoning behind
most of it.

## Prerequisites

- macOS 13+ (Apple Silicon or Intel)
- Windows 10/11 x64 — needs the MSVC toolchain, and cannot be built from a Mac; see [docs/WINDOWS.md](docs/WINDOWS.md)
- Node.js 20.19+ or 22.12+ (CI uses 24) and pnpm ≥ 10.33.0
- Rust 1.98+ (2024 edition)
- CMake and Ninja, which `cef-dll-sys` needs to build `libcef_dll_wrapper`

```bash
brew install cmake ninja pnpm
pnpm install
pnpm dev
```

The first build downloads and compiles against CEF, which takes a while. CI
caches it under `.cef` keyed on the CEF version in `Cargo.lock`; locally, set `CEF_PATH` to reuse
a copy you already have.

Lighter builds when you do not need the whole engine:

```bash
# Skip the whisper.cpp toolchain (live subtitles become unavailable)
cargo build -p dive-desktop --no-default-features --features cef
```

Dive keeps its data under `~/Library/Application Support/app.dive.browser/`:
the SQLite store, per-workspace Chromium profiles (`profiles/`), the MCP bearer
token (`mcp-token`, user-readable only) and downloaded speech models
(`models/`). These variables point a throwaway instance elsewhere:

| Variable | Effect |
|---|---|
| `DIVE_DATA_DIR` | Use another data directory (a private profile for tests) |
| `DIVE_MCP_PORT` | MCP server port; default `7391`, `0` disables the server |
| `DIVE_USE_MOCK_KEYCHAIN=1` | Skip the macOS keychain for throwaway instances (no Safe Storage prompt) |
| `DIVE_SKIP_ONBOARDING=1` | Start a fresh data directory past the first-run flow, so a probe can drive the page at once |
| `DIVE_OPEN_URL` | Open this URL (or several, whitespace-separated) at launch, like passing them as arguments |
| `--remote-debugging-port=P` (argument) | Chrome DevTools Protocol on `P` for the chrome and pages; a private window's process then listens on `P + 1` |

Every other `DIVE_*` variable is listed in [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md).

## The check that has to pass

One command is the local gate:

```bash
pnpm check
```

That is `pnpm test:probes` (the Python probe tests; skipped on Windows),
`cargo fmt --all -- --check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, a
production `vite build`, `cargo clippy --workspace --all-targets -- -D warnings`,
`cargo test --workspace`, and `pnpm test:runtime` (format check and tests of the
vendored runtime; `scripts/vendor-runtime-diff.sh` shows what it changes
against upstream). Clippy runs at `pedantic` with warnings denied, so
a lint is a build failure, not a suggestion.

The integration suites live in `tests/e2e` as the `dive-integration` crate
(`cargo test -p dive-integration`, or a tier such as
`cargo test -p dive-integration tier2_boundaries`); `cargo test --workspace`
already includes them.

CI additionally runs: clippy on the build without the local transcription
engine (`--no-default-features --features cef`), `cargo audit`, `cargo deny
check`, a diff of the generated bindings, `pnpm audit --prod`, the Rust
build, clippy and tests on Windows too (the frontend checks run on macOS only),
the vendored runtime's format check and tests, and a `live` job that builds
the real app bundle and drives it through its own MCP server
(`scripts/live-check.sh`), plus the memory and startup benchmarks. Unit tests
cannot see the things that job checks — renderer crash recovery, tab discard
actually reclaiming memory — so expect to be asked for live evidence on
anything touching the engine lifecycle. `scripts/README.md` lists every manual
probe and how to run it against a bundle.

### Generated bindings

Rust command signatures are exported to TypeScript by a test in the desktop
crate. CI fails on `git diff --exit-code -- apps/desktop/src/generated`, so run
`cargo test --workspace` and commit the regenerated files **in the same commit**
as the Rust change.

## Where things live

```
apps/desktop/src/          React 19 chrome (Zustand stores, Tailwind v4)
apps/desktop/src-tauri/    Tauri host: CEF lifecycle, CDP, commands
apps/desktop/src-tauri/src/inject/   JavaScript injected into pages
crates/dive-cdp/           In-process CDP client
crates/dive-core/          SQLite (WAL), migrations, event bus
crates/dive-mcp/           MCP server
crates/dive-agent/         Agent loop, provider dialects, tool dispatch
tests/e2e/                 dive-integration: tiered integration and stress suites
vendor/tauri-runtime-cef/  Patched Tauri CEF runtime; see its UPSTREAM.md
docs/design/               Design notes for larger features
```

### Injected page scripts

Scripts under `src-tauri/src/inject/` are real `.js` files, not Rust string
literals, so they can be exercised against a DOM. Adding one means registering
it in **both** loaders — `FRAGMENTS` in `src-tauri/src/pagescript.rs` and
`FRAGMENTS` in `src/lib/injected.ts` — and testing its behaviour from
TypeScript. Assert on what the script *does* to a DOM, not on its text: a
string assertion cannot catch a wrong `:nth-of-type` index.

Each script is composed into an IIFE before evaluation, so a fragment is not
valid standalone, and `return` at top level is how a result gets out.

### Threading

Tauri IPC commands do not run on the main thread. Anything touching a CEF view
has to hop with `run_on_main_thread` first. This is the single most common
source of intermittent crashes in this codebase — if you are adding a command
that reaches the engine, follow an existing one exactly.

## Agent skills for the animations

The first-run intro (`apps/desktop/src/video/Intro.tsx`) and the feature reel
are Remotion compositions written to the Remotion and HyperFrames motion
guidance. Those skills install locally into `.claude/skills/` (ignored by git)
so Claude Code picks them up when editing the animations:

```bash
npx skills add remotion-dev/skills
npx skills add heygen-com/hyperframes
```

## Debugging

- **Logs**: `<data dir>/logs/dive.<date>.log`, one file a day, the last 7 kept. The data dir is `~/Library/Application Support/app.dive.browser` on macOS, `%APPDATA%\dive` on Windows and `~/.local/share/dive` on Linux; `DIVE_DATA_DIR` overrides it. The default filter is `info,dive=debug` in every build. Set `RUST_LOG=dive=trace` (or any `EnvFilter` string) for more. The console carries the same lines. Per-request lines belong at `trace`, never `debug`: the debug lines are the trail a freeze report is diagnosed from, so they stay off the hot paths.
- **Crash reports**: a Rust panic is written to `<data dir>/crashes/` with the version and a backtrace.
- **Private windows** write neither logs nor crash reports, so reproduce in a normal window.
- **DevTools on the chrome and pages**: start Dive with `--remote-debugging-port=P`, or with `DIVE_CHROMIUM_FLAGS=remote-debugging-port=P`. Then open `chrome://inspect` in Chrome, or point a CDP client at `127.0.0.1:P`. A private window's process listens on `P + 1`.
- **Environment variables**: every `DIVE_*` switch is in [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md).
- **A throwaway instance**: `DIVE_DATA_DIR=$(mktemp -d) DIVE_USE_MOCK_KEYCHAIN=1 DIVE_SKIP_ONBOARDING=1 <binary>`, never a real profile.
- **Calling one MCP tool from a shell**: `python3 scripts/mcp-call.py --data-dir DIR --port 7391 call tabs_list '{}'`. Every tool and its parameters: [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md).

## Commits and pull requests

- Use a conventional-commit subject (`type(scope): ...`) worded as what the
  change does for the user: `fix(subtitles): audio reaches the transcriber
  again`, or the real `fix(memory): compile pressure notification hooks on
  macOS only`, not `fix bug`.
- Explain *why* in the body when the reason is not obvious from the diff. The
  comments in this repo lean the same way — they say why, not what.
- One concern per PR. A formatting sweep mixed into a behaviour change makes
  the behaviour change unreviewable.
- Say what you actually verified. "Ran `pnpm check`" and "drove it in a live
  window" are different claims; do not make the second one unless you did it.

## Dependencies

New dependencies need a reason in the PR description. `cargo deny` enforces the
license allow-list and rejects unknown registries and git sources, so a crate
from an unlisted source fails CI until it is explicitly allowed in `deny.toml`.

Dive redistributes third-party components under their own terms, notably the
Chromium Embedded Framework (BSD-3-Clause) and Chromium itself. Dive's own
source is MIT; see `LICENSE`.

## Security

Do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).
