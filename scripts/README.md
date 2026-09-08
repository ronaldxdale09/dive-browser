# Scripts

Everything here runs against a **built bundle**, never against `pnpm dev`. Set
`DIVE_BIN` to the executable inside the `.app` (CI uses
`target/debug/bundle/macos/Dive.app/Contents/MacOS/dive-desktop`). Release
tooling lives in `release/` and is described in [`../RELEASING.md`](../RELEASING.md).

## Manual qualification scripts

| Script | What it checks |
|---|---|
| `live-check.sh` | The real app driven through its MCP server: tab open and read-back, popup/camera/PDF/localhost/offline paths, screenshot, idle discard and wake, renderer crash recovery, CDP round-trip budget. Runs in CI's `live` job. |
| `native_lifecycle_check.py` | Popout window close, detach/reattach and quit ordering across four launches of one disposable profile, verifying sibling JavaScript keeps running. Runs in CI. |
| `benchmark-startup.sh` / `startup_benchmark.py` | Cold and warm launch timings from the host's launch clock to first paint and usable controls. Runs in CI. |
| `benchmark-memory.sh` / `memory_benchmark.py` / `memory-fixture.py` | Whole-process-tree RSS at baseline, after N fixture tabs, and after discard; fails if discard does not reclaim `MEM_MIN_RECLAIM_PCT`. Runs in CI. |
| `loopback_server.py` | The loopback HTTP server every fixture uses; it skips the reverse DNS lookup that stalls `http.server` on GitHub's macOS runners. |
| `probe_process.py` | Shared runner for the probes above: external deadlines, process-group cleanup, retained logs under `target/`. |
| `mcp-call.py` | Call one MCP tool on a running instance (`--data-dir DIR --port PORT list \| call TOOL '{…}'`); reads the bearer token from `DIR/mcp-token`. |
| `fetch_filter_check.py` | DivePrivacy request filtering against a known tracker host resolved only to loopback, on the exact bundle. |
| `network_capture_check.py` | Bounded response-body capture (size limits, gzip, ranges) in the network panel. |
| `subtitles-live-check.mjs` | Live subtitles end to end over CDP: a private instance with a downloaded `base` model plays a local speech fixture and captions must appear; `DIVE_SUBTITLE_SOAK_SECS` adds a sustained-playback RSS soak. |
| `tests/test_*.py` | Unit tests for the probe runners (`pnpm test:probes`, part of `pnpm check`). |
| `app-icon.py` | Regenerates every app icon size from `assets/logo.png` (the logo on a light macOS tile); needs Pillow. |

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
