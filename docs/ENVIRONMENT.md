# Environment variables

Every `DIVE_*` variable the Rust code reads. A test
(`scripts/tests/test_env_reference.py`, part of `pnpm test:probes`) fails when
a variable appears in the code and not here, so a new one has to be added to
this file.

"Where" is the file and line of the read, under `apps/desktop/src-tauri/src/`
unless a crate path is given. "Build" says whether a variable is read in every
build (`any`), only compiled into tests (`test`) or baked in when the binary is
compiled (`compile-time`). Switches that say "set to `1`" are tested for the
literal `1` unless noted; the MCP switches accept `1` or `true` only.

Throwaway instance recipe, used by every probe below:
`DIVE_DATA_DIR=$(mktemp -d) DIVE_USE_MOCK_KEYCHAIN=1 DIVE_SKIP_ONBOARDING=1 <binary>`.

## For people running Dive

| Variable | Where | What it does | Build |
|---|---|---|---|
| `DIVE_DATA_DIR` | `state.rs` (data root), `crash_probe.rs:417` | Use another data directory: store, profiles, MCP token, logs, models. A private profile for tests; probes also require it so they never run on a real profile. | any |
| `DIVE_USE_MOCK_KEYCHAIN` | `crash_probe.rs:416`, `private_session.rs:457` | Set to `1` to skip the macOS keychain (no Safe Storage prompt) for throwaway instances. Probes require it as proof the profile is disposable. | any |
| `DIVE_SKIP_ONBOARDING` | `prefs.rs:870` | Set to `1` so a fresh data directory starts past the first-run flow. | any |
| `DIVE_OPEN_URL` | `lib.rs:747` | Open this URL (or several, whitespace-separated) at launch, like passing them as arguments. | any |
| `DIVE_OPEN_PANEL` | `lib.rs:882` | Comma-separated chrome panels to toggle once the chrome is up (for example `sidecar,dock`); for automation that cannot click. | any |
| `DIVE_SIMULATE` | `commands.rs:212` | Device preset to put the first active tab on at startup, so a screenshot script can bring the simulator up without a click. | any |
| `DIVE_CHROMIUM_FLAGS` | `startup.rs:434` | Extra Chromium switches, shell-quoted, either `--name` or `name=value` (for example `remote-debugging-port=9339`). Malformed quoting is ignored with a warning. | any |
| `DIVE_RENDERER_PROCESS_LIMIT` | `startup.rs:464` | Renderer process limit; default `6`. | any |
| `DIVE_DEFAULT_PROCESS_MODEL` | `startup.rs:493` | Any value: leave Chromium's own process model in place (no `renderer-process-limit`), to tell a process-model fault from anything else. | any |
| `DIVE_DISABLE_FEEDS` | `engine.rs:1006` | Any value: leave the per-tab DevTools session idle, to tell an engine fault from one our own traffic provokes. | any |
| `DIVE_DISCARD_LOCAL_TABS` | `housekeeping.rs:282` | Set to `1` to let the discard sweep take local development-server tabs, which are protected otherwise. | any |
| `DIVE_MAX_IDLE_SECS` | `housekeeping.rs:100` | Seconds a `Today` tab may sit unfocused before it is discarded; set small (or `0`) so a harness can force a sweep. | any |
| `DIVE_SWEEP_SECS` | `housekeeping.rs:104` | Seconds between discard sweeps (positive values only). | any |
| `DIVE_UPLOAD_DIRS` | `mcp.rs:1129` | Extra absolute directories (path-list syntax) the MCP upload tool may read from, besides Downloads, Desktop and Documents. | any |
| `DIVE_SUBTITLE_WINDOW_SECS` | `subtitles.rs:718` | Live subtitles: audio window length per transcription pass (minimum 2). | any |
| `DIVE_SUBTITLE_STEP_SECS` | `subtitles.rs:719` | Live subtitles: seconds between passes (minimum 0.2, capped at 5). | any |

## MCP

| Variable | Where | What it does | Build |
|---|---|---|---|
| `DIVE_MCP_PORT` | `mcp.rs` (`advertised_port`), `normal_window.rs:256` | MCP server port; default `7391`, `0` disables the server. | any |
| `DIVE_MCP_ALLOW_EVAL` | `mcp.rs:3877` | `1` or `true` turns on `page_evaluate` (arbitrary JavaScript in pages) for MCP clients. Logs a warning at start. | any |
| `DIVE_MCP_SKIP_CONFIRM` | `mcp.rs:1770` | `1` or `true` skips the consent prompts for MCP uploads, cookie and storage reads and writes, and rule changes. **Meant only for unattended, trusted rigs (CI, test machines).** Anyone who can set it can already run code as you, so it is not build-gated; it logs a warning at start. | any |

## Build-time

| Variable | Where | What it does | Build |
|---|---|---|---|
| `DIVE_BUILD_COMMIT` | `commands.rs:200`; set by `build.rs` | Short git commit shown in About. | compile-time |
| `DIVE_BUILD_NUMBER` | `commands.rs:199`; set by `build.rs` | Commit count, the build number shown in About. | compile-time |
| `DIVE_BUILD_UNIX` | `commands.rs:202`; set by `build.rs` | Build timestamp (Unix seconds). | compile-time |
| `DIVE_UPDATER_PUBKEY` | `updater.rs:71` | Updater signing public key, supplied by release CI (`.github/workflows/release.yml`). Without it the build has no updater. | compile-time |

These are set by the build, not by hand.

## Probes and benchmarks

Opt-in harnesses, driven by the scripts in `scripts/` (see
`scripts/README.md`). Almost all refuse to run unless the profile is
disposable (`DIVE_DATA_DIR` set and `DIVE_USE_MOCK_KEYCHAIN=1`). Any launch
with one of them set is treated as automated by `recovery.rs:116`
(`DIVE_*_PROBE*`, `DIVE_SUBTITLE_TEST_*`, `DIVE_SMOKE`, `DIVE_STRESS_TABS`,
`DIVE_WINDOW_HIDDEN`, `DIVE_CDP_BENCH`, `DIVE_AGENT_EVAL`,
`DIVE_STARTUP_BENCHMARK`, `DIVE_DISPOSABLE_PROFILE`), so crash-recovery
safe-start never holds a harness's tabs back.

| Variable | Where | What it does | Build |
|---|---|---|---|
| `DIVE_SMOKE` | `recovery.rs:119` (read in `lib.rs:1064`) | Set to `1`: a few seconds after start, capture the active tab to a PNG and exit. | any |
| `DIVE_SMOKE_GIF` | `lib.rs:1075` | With `DIVE_SMOKE`: also record a short GIF. | any |
| `DIVE_WINDOW_HIDDEN` | `engine.rs:2876` | Set to `1`: keep the window off screen so a person at the machine cannot close a trial by accident. | any |
| `DIVE_CDP_BENCH` | `lib.rs:1016` | Set to `1`: time a burst of trivial DevTools round trips on the first tab and log the distribution. | any |
| `DIVE_STRESS_TABS` | `lib.rs:1108` (and `recovery.rs:120`) | Open this many tabs, let them settle, force a discard sweep and exit; logs `stress:` markers the memory harness samples at. | any |
| `DIVE_STRESS_URLS` | `lib.rs:1116` | Whitespace-separated URLs the stress tabs cycle through (give distinct sites). | any |
| `DIVE_STRESS_SETTLE_SECS` | `lib.rs:1112` | Seconds to let stress tabs settle; default 15. | any |
| `DIVE_STRESS_HEAP_METRICS` | `memory_probe.rs:79` | Record read-only heap metrics at each stress phase (needs the mock keychain). | any |
| `DIVE_STARTUP_BENCHMARK` | `startup.rs:318` (and `recovery.rs:124`) | Set to `1`: record startup milestones and write them out. See `scripts/startup_benchmark.py`. | any |
| `DIVE_BENCHMARK_OUTPUT` | `startup.rs:279` | File the startup benchmark JSON is written to; default `target/startup-benchmark.json`. | any |
| `DIVE_BENCHMARK_TIMEOUT_MS` | `startup.rs:323` | How long the startup benchmark waits for its milestones; default 10000. | any |
| `DIVE_COLD_START` | `startup.rs:193` | `1`/`true` forces the launch to count as cold, otherwise a missing database means cold. | any |
| `DIVE_AGENT_EVAL` | `recovery.rs:122` (read in `agent_probe.rs:580`) | Run the scripted-model agent-loop scoreboard in a real window; exits 0 if every task passed. | any |
| `DIVE_DISPOSABLE_PROFILE` | `responsiveness.rs:1088` | Set to `1`: declares the profile disposable for the responsiveness fault diagnostics. | any |
| `DIVE_RESPONSIVENESS_DIAGNOSTIC` | `responsiveness.rs:1087` | Set to `1`: write local UI responsiveness fault diagnostics under the profile (needs `DIVE_DISPOSABLE_PROFILE=1`, the mock keychain and `DIVE_DATA_DIR`). | any |
| `DIVE_NATIVE_LIFECYCLE_PROBE` | `ui_probe.rs:86`, `fetch_filter_probe.rs:62` | Run the native tab detach/attach/window-close regression. See `scripts/native_lifecycle_check.py`. | any |
| `DIVE_CRASH_PROBE` | `crash_probe.rs:415` | Set to `1`: renderer crash-recovery probe. Refused when any process-model override is set. | any |
| `DIVE_UI_PROBE` | `ui_probe.rs:82` | Opt-in diagnostics for an interactive native UI run; records no keystrokes, values or URLs. | any |
| `DIVE_UI_PROBE_ON_DEMAND` | `ui_probe.rs:379` | Set to `1`: the UI probe runs in manual (on-demand) mode instead of its default. | any |
| `DIVE_UI_INPUT_NATIVE_TRACE` | `ui_probe.rs:80` | Set to `1` with `DIVE_UI_PROBE`: trace native input for tab, palette and search commands. | any |
| `DIVE_FETCH_FILTER_PROBE` | `fetch_filter_probe.rs:62` | Native qualification of the Fetch owner and privacy filters. | any |
| `DIVE_FETCH_FILTER_PROBE_URL` | `fetch_filter_probe.rs:66` | The page the Fetch filter probe loads. | any |
| `DIVE_PERMISSION_CACHE_PROBE` | `lifecycle_probe.rs:49` | Native permission-cache qualification (seeds content settings; asks for no device). | any |
| `DIVE_PERMISSION_WEBUI_PROBE` | `permission_probe.rs:202` | Set to `1` with the permission probe: also check the chooser and protocol services. | any |
| `DIVE_NETWORK_CAPTURE_PROBE_URL` | `lifecycle_probe.rs:49` | Page the network-capture probe loads; see `scripts/network_capture_check.py`. | any |
| `DIVE_WELCOME_PROBE` | `lifecycle_probe.rs:61` | Check the native welcome artwork and the on-demand tour. | any |
| `DIVE_AVATAR_PROBE` | `lifecycle_probe.rs:65` | `bundled`, `warm` or `cold`: check profile avatar artwork in that cache state. | any |
| `DIVE_PRIVATE_STORAGE_PROBE` | `private_probe.rs:188` | URL: check the private-session storage boundary against that page. | any |
| `DIVE_PRIVATE_STORAGE_EXPECT` | `private_probe.rs:201` | What the private-storage probe expects to find; default `empty`. | any |
| `DIVE_SUBTITLE_TEST_` | `recovery.rs:116` | Prefix only: any variable starting with it marks the launch as automated. | any |
| `DIVE_SUBTITLE_TEST_MODEL` | `subtitles.rs:1411` | Path to a whisper model for the ignored real-audio transcription test. | test |
| `DIVE_SUBTITLE_TEST_WAV` | `subtitles.rs:1413` | Path to the WAV that test transcribes. | test |
| `DIVE_SUBTITLE_EXPECT_LANGUAGE` | `subtitles.rs:1407` | Language the test expects; default `en`. | test |
| `DIVE_SUBTITLE_EXPECT_WORD` | `subtitles.rs:1409` | Word the test expects in the transcript; default `country`. | test |
| `DIVE_SUBTITLE_TRANSLATE` | `subtitles.rs:1410` | Any value: run that test in translate mode. | test |
| `DIVE_IMPORT_FIXTURE` | `screen.rs:1034` | An H.264 MP4 with audio for the ignored media import test (needs ffmpeg). | test |
| `DIVE_PERF_ASSERT` | `tests/e2e/src/tier4_scenarios/test_mcp_concurrency.rs:154` | Set to `1` to enforce the MCP latency p95 budget; otherwise percentiles are only printed. | test |

## Internal handoff

Set by Dive for its own child processes. Do not set by hand.

| Variable | Where | What it does | Build |
|---|---|---|---|
| `DIVE_PRIVATE_SESSION` | `private_session.rs:26` | `1` in the process that hosts a private window. | any |
| `DIVE_PRIVATE_LAUNCH_TOKEN` | `private_session.rs:36` | Names the private process's temporary root so it is cleaned up. | any |
| `DIVE_NORMAL_DATA_DIR` | `normal_window.rs:215` | The normal profile's data root, so a private process can open a normal window against it. | any |
| `DIVE_NORMAL_MOCK_KEYCHAIN` | `normal_window.rs:253` | Forwarded mock-keychain choice: the normal window it launches then gets `DIVE_USE_MOCK_KEYCHAIN=1` and `DIVE_MCP_PORT=0`. | any |
| `DIVE_NORMAL_FRESH_WINDOW` | `lib.rs:500`, `normal_window.rs:89` | Any value: this process starts with an empty window instead of restoring the session; set (to `1`) on the normal window a private window opens. | any |
| `DIVE_RESTART_FROM` | `lib.rs:724` | Read as an alternative to the `--dive-restart-from=<pid>` argument Dive passes itself on restart: tells the new process the profile lock it finds held belongs to the process on its way out. Nothing in the tree sets it. | any |
| `DIVE_SHORTCUT_PATH`, `DIVE_SHORTCUT_TARGET`, `DIVE_SHORTCUT_ARGUMENTS`, `DIVE_SHORTCUT_ICON`, `DIVE_SHORTCUT_DESCRIPTION` | `webapp.rs:1028-1036` | Passed to the Windows script that writes a web app's Start-menu shortcut: link path, target, `--app=<id>` argument, icon and description. | any |
