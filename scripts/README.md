# Scripts

Everything here runs against a **built bundle**, never against `pnpm dev`. Set
`DIVE_BIN` to the executable inside the `.app` (CI uses
`target/debug/bundle/macos/Dive.app/Contents/MacOS/dive-desktop`). Release
tooling lives in `release/` and is described in [`../RELEASING.md`](../RELEASING.md).

## Checks and probes

| Script | What it does | Runs in |
|---|---|---|
| `live-check.sh` | The real app driven through its MCP server: tab open and read-back, popup/camera/PDF/localhost/offline paths, screenshot, idle discard and wake, renderer crash recovery, CDP round-trip budget. The camera and microphone fail-closed step needs macOS's own consent for the bundle, so it runs only with `LIVE_MEDIA_CONSENT=1`. | CI (`live` job) |
| `native_lifecycle_check.py` | Popout window close, detach/reattach and quit ordering across four launches of one disposable profile, verifying sibling JavaScript keeps running. | CI |
| `benchmark-startup.sh` / `startup_benchmark.py` | Cold and warm launch timings from the host's launch clock to first paint and usable controls. | CI |
| `benchmark-memory.sh` / `memory_benchmark.py` / `memory-fixture.py` | Whole-process-tree RSS at baseline, after N fixture tabs, and after discard; fails if discard does not reclaim `MEM_MIN_RECLAIM_PCT`. | CI |
| `fetch_filter_check.py` | DivePrivacy request filtering against a known tracker host resolved only to loopback, on the exact bundle. | by hand |
| `network_capture_check.py` | Bounded response-body capture (size limits, gzip, ranges) in the network panel. | by hand |
| `private-session-check.py` | Private CEF storage and lifetime against an exact, disposable app binary. | by hand |
| `media-playback-check.py` | Sustained media playback through Dive's trusted MCP input path. | by hand |
| `browser_sandbox.py` | Asks macOS Seatbelt whether every live renderer under an owned test browser is sandboxed (`python3 scripts/browser_sandbox.py OWNED_BROWSER_PID`). Also run by `live-check.sh`. | CI |
| `agent_bench.py` | Scores Dive's automation surface against fixed agent flows (a locator finds the button, a wait waits, page text comes back whole) and what each costs in bytes and milliseconds, against local fixtures. Run with `DIVE_BIN=/path/to/Dive.app/Contents/MacOS/dive-desktop scripts/agent_bench.py`, or `--port 7391 --data-dir DIR` for a running instance. | by hand |
| `subtitles-live-check.mjs` | Live subtitles end to end over CDP: a private instance with a downloaded `base` model plays a local speech fixture and captions must appear; `DIVE_SUBTITLE_SOAK_SECS` adds a sustained-playback RSS soak. | by hand |
| `stack-color-live-check.mjs` | The stack detector and the colour picker's palette read against a real page, over CDP (`DIVE_CHROMIUM_FLAGS=remote-debugging-port=9343`). The eyedropper is checked by hand. | by hand |
| `webapp-live-check.mjs` | Web-app install end to end against a private instance with remote debugging: probe, install, app window, launcher bundle, uninstall. | by hand |
| `browser-comparison.mjs` | Cross-browser footprint and readiness comparison; see "Cross-browser comparison on macOS" below. | by hand |
| `tests/test_*.py` | Unit tests for the probe runners and these scripts (`pnpm test:probes`). | pnpm check |

## Shared helpers

| Script | What it does | Runs in |
|---|---|---|
| `mcp_client.py` | The one implementation of the MCP protocol in `scripts/`: a session that counts each call's cost. `mcp-call.py` and `agent_bench.py` use it, so they cannot drift. | CI (via `live-check.sh`) |
| `mcp-call.py` | Call one MCP tool on a running instance (`--data-dir DIR --port PORT list \| call TOOL '{...}'`); reads the bearer token from `DIR/mcp-token`. | CI (via `live-check.sh`) |
| `probe_process.py` | Shared runner for the probes: external deadlines, process-group cleanup, retained logs under `target/`. | CI |
| `loopback_server.py` | The loopback HTTP server every fixture uses; it skips the reverse DNS lookup that stalls `http.server` on GitHub's macOS runners. | CI |
| `browser_footprint.py` | macOS physical footprint of an owned browser tree, distinct from RSS. | by hand |
| `native-toolchain.sh` | Sourced before a native build or check so one linkable macOS SDK is used consistently. | pnpm check |

## Build and maintenance

| Script | What it does | Runs in |
|---|---|---|
| `check.sh` | What `pnpm check` runs: probe tests, format, typecheck, lint, JS tests, Vite build, clippy, `cargo test --workspace`, runtime tests. | pnpm check |
| `test-runtime.sh` | Format check and library tests of the vendored `tauri-runtime-cef` (`pnpm test:runtime`). | pnpm check |
| `vendor-runtime-diff.sh` | What Dive changed in the vendored `tauri-runtime-cef` relative to its pinned upstream revision; writes the patch to `target/vendor-runtime.patch`. | by hand |
| `app-icon.py` | Regenerates every app icon size from `assets/logo.png` (the logo on a light macOS tile); needs Pillow. | by hand |
| `generate-default-avatars.mjs` | Rewrites `apps/desktop/src/lib/defaultAvatars.json` from the avatar generator, byte-identical to the worker's. | by hand |
| `ci/ggml-portable.cmake` | Toolchain file the workflows hand to whisper.cpp so it builds for a fixed Apple Silicon baseline instead of probing the virtualised runner CPU. | CI |
| `release/` | Version stamping, bundle preparation, signing secrets, update manifest and release asset checks; see [`../RELEASING.md`](../RELEASING.md). | release |

## Windows (`windows/`)

Setup and the build flow are in [`../docs/WINDOWS.md`](../docs/WINDOWS.md).

| Script | What it does | Runs in |
|---|---|---|
| `bootstrap.ps1` | Everything Dive needs to build on a fresh Windows machine, installed machine-wide under `C:\dev`. See `docs/WINDOWS.md`. | by hand |
| `first-build.ps1` | Clone or update the repo in a prepared VM and take a compile pass, logging to `C:\dev\logs\first-build.log`. See `docs/WINDOWS.md`. | by hand |
| `rebuild.ps1` | Pull and rebuild the release binary in a prepared VM, detached so it outlives the session. See `docs/WINDOWS.md`. | by hand |
| `msvc-runtime.ps1` | Dot-sourced before building so whisper.cpp and CEF agree on the static C++ runtime. | by hand |
| `run-in-session.ps1` | Run a script on the interactive desktop from session 0, as the logged-on user, and print what it wrote. | by hand |
| `check-window-controls.ps1` | Clicks the chrome's own minimise button and asks the window whether it minimised. | by hand |
| `show-suggestions.ps1` | Stages the address bar suggestions on screen for a screenshot from the host. | by hand |
| `eyedropper-live-check.mjs` | The Windows eyedropper end to end against a pixel painted a known colour. | by hand |
| `features-live-check.mjs` | The Windows halves of four features that existed only on macOS, checking artefacts on disk or in the registry. | by hand |
| `make-ico.py` | Builds the Windows `.ico` from the macOS artwork, trimming Apple's transparent margin. | by hand |

## Benchmark and probe details

Use a built bundle and set `DIVE_BIN` to its executable. Each runner creates its own disposable profile, retains logs under `target`, and signals only the process groups it created. Do not point `DIVE_DATA_DIR` at a real profile for a probe. These POSIX runners currently target the macOS application and CI runner.

- `scripts/benchmark-startup.sh`: three fresh-profile launches, one warmup, five subsequent launches by default. `BENCH_COLD_RUNS` and `BENCH_WARM_RUNS` change the measured counts. Both actual contentful paint and usable controls must reach the host, and every process must exit normally. Timings use the host's monotonic launch clock at IPC receipt; renderer scheduling and IPC latency are included. Setup duration is not a measure of UI blocking.
- `scripts/benchmark-memory.sh`: twenty memory-bearing same-site fixture tabs by default, using DIVE's normal process model. `STRESS_URL` accepts whitespace-separated real URLs; `STRESS_TABS`, `STRESS_SETTLE_SECS`, and `MEM_MIN_RECLAIM_PCT` control the workload. The harness measures live whole-process-tree RSS at baseline, loaded, and discarded phases and rejects incomplete tab counts. It excludes app-shutdown samples. Same-site processes can retain shared allocator memory after discard; a failed reclaim threshold is a real investigation result, not a reason to force process-per-tab.
- `DIVE_BIN=/absolute/path/to/bundle/executable python3 scripts/native_lifecycle_check.py`: open real tabs, close a detached window, verify sibling JavaScript still runs, detach/reattach it, verify JavaScript again, then alternate Quit-with-popout and main-window close across four launches of the same disposable profile.
- `pnpm test:probes`: controlled executable regressions for invalid reports, failed launch, process hangs, leaked helpers, and successful startup/memory records. Included in `pnpm check` and CI.
- `python3 scripts/browser_sandbox.py OWNED_BROWSER_PID`: on macOS, ask Seatbelt whether every live renderer descended from the specified test browser is sandboxed. Missing renderers, query failures, or an unsandboxed renderer fail verification. Included in `scripts/live-check.sh`; command-line flags and IPC permission tests alone are not sandbox evidence.

`DIVE_PROBE_TIMEOUT_SECS` sets an external per-process deadline for startup and memory checks. Expiring the deadline or leaving helpers alive fails the run even if a report was already written. New failed runs remove stale fixed-path summaries; detailed run directories remain. Successful summaries include the exact executable SHA-256, logs, process-model overrides, sample counts, and measurements. Explicit Chromium environment overrides remain available for diagnosis and are recorded; they are never added automatically.

A benchmark pass is evidence for that workload and binary, not release qualification. Final release checks additionally require signed/notarized artifacts, user-profile persistence and compatibility tests, accessibility/visual review, and long-running stability tests.

All disposable native test profiles use `DIVE_USE_MOCK_KEYCHAIN=1`, including the live check, startup, memory, and lifecycle probes. This prevents macOS Chromium Safe Storage prompts during repeated ad hoc builds. Normal application launches retain the system keychain. These probes do not validate production keychain encryption or signed-build keychain continuity.

## Cross-browser comparison on macOS

`browser-comparison.mjs` uses graphical browsers, private profiles, rotating order and whole owned-process-tree physical footprint from `browser_footprint.py`. Set exact `BENCH_DIVE_BIN`, `BENCH_CHROME_BIN`, `BENCH_BRAVE_BIN`, `BENCH_RUNS` and a fresh `BENCH_OUTPUT`; Node 22+ is required.

Method `2-visible-reload-persistent-cdp` keeps CDP sessions attached so device emulation survives navigation. It asserts a 1280×720 viewport and DPR 1 in measured phases, retains both loadEventEnd and the visible post-load double-requestAnimationFrame milestone, and finishes that milestone before triggering the next reload. This is a rendering-readiness proxy, not a physical display scan-out measurement. Startup remains host spawn to the first such receipt with a usable visible native viewport. Earlier load-only/short-lived-connection results must be labelled separately: Chrome was observed reverting to native dimensions after disconnection.

Each run retains five samples after one-tab/eight-second and ten-tab/ten-second settling periods. Every fixture retains 32 MiB and 5,000 DOM rows. Metadata fingerprints the harness, memory helper, main executables, fixture and host. Failed profiles and partial batches remain available for diagnosis; they are not scored as successful comparisons.
