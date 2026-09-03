# Project: Dive Browser Optimization & Hardening

## Architecture
Dive browser is built on Tauri v2 (`tauri` git rev `dd2e5d91b60a6402ce270ceb03b0ff9679664d79`) + CEF (Chromium Embedded Framework) + Rust backend + React 19 frontend.
- **Backend Crates**:
  - `apps/desktop/src-tauri` (`dive-desktop`): Main Tauri application, CEF host window/views lifecycle (`engine.rs`), housekeeping (`housekeeping.rs`), crash handling (`crash.rs`), IPC commands (`commands.rs`), devservers (`devservers.rs`), recorder (`recorder.rs`), MCP startup (`mcp.rs`).
  - `crates/dive-core`: SQLite WAL database store (`store.rs`), data models (`model.rs`), bus events (`event.rs`).
  - `crates/dive-cdp`: In-process CDP client, types, transport traits.
  - `crates/dive-mcp`: Axum HTTP server hosting Model Context Protocol endpoints.
  - `crates/dive-agent`: Agent runner and task execution.
- **Frontend App**:
  - `apps/desktop`: React 19 + TypeScript + Zustand (`store/browser.ts`) + Vite + Tailwind.
  - UI chrome: `App.tsx`, `TabStrip.tsx`, `Content.tsx`, `Omnibar.tsx`, `Splash.tsx`.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | `--disable-extensions` Chromium switch | Eliminate ~40MB baseline overhead from unused extension systems | M1 | R1 Survey |
| 2 | `--process-per-site` Chromium switch | Consolidate same-origin tabs into shared renderers | M1 | R1 Survey |
| 3 | `--renderer-process-limit` switch | Cap concurrent renderer processes (configurable via env) | M1 | R1 Survey |
| 4 | Startup timeline instrumentation | Capture process start, SQLite init, window creation, setup complete | M1 | R1 Survey |
| 5 | Initial window paint & chrome readiness | IPC hook reporting React boot and first paint | M1 | R1 Survey |
| 6 | Startup benchmarking harness | Automated cold/warm startup benchmark script with p50/p95 reporting | M1 | R1 Survey |
| 7 | 30-minute idle sweeping in `housekeeping.rs` | Reduce `MAX_IDLE` from 12h to 30m, sweep every 1-2m | M2 | R2 Survey |
| 8 | Multi-workspace native view sweep | Close native CEF webviews across all workspaces upon discard | M2 | R2 Survey |
| 9 | Safe discard: pinned & essential tabs | Exclude pinned and essential tabs from idle discarding | M2 | R2 Survey |
| 10 | Safe discard: audio-playing tabs | Detect and protect tabs playing audio from discard | M2 | R2 Survey |
| 11 | Safe discard: localhost dev sessions | Exclude loopback/devserver URLs from discard | M2 | R2 Survey |
| 12 | Safe discard: active screencast/agents | Exclude tabs under active automation or screencast | M2 | R2 Survey |
| 13 | Scroll position persistence in SQLite | Schema migration adding scroll_x/scroll_y to tabs | M2 | R2 Survey |
| 14 | Discarded tab reactivation | Restore URL, scroll position, and state on tab click | M2 | R2 Survey |
| 15 | TabStrip sleeping tab display | Keep discarded tabs in UI with sleeping indicator | M2 | R2 Survey |
| 16 | 20-tab memory stress & profiling harness | Automated script measuring RSS before/after multi-tab load | M2 | R2 Survey |
| 17 | Native CEF termination hook | Register `on_web_content_process_terminate` on Tauri builder | M3 | R3 Survey |
| 18 | Hard crash recovery fallback | Fall back to webview recreation if CDP Page.reload fails | M3 | R3 Survey |
| 19 | Sibling tab crash isolation | Verify crashes in one tab do not affect other tabs | M3 | R3 Survey |
| 20 | Frontend `tabCrashed` listener | Subscribe to crash events in browser Zustand store | M3 | R3 Survey |
| 21 | Non-blocking crash recovery notice | UI banner with 1-click reload button for crashed tabs | M3 | R3 Survey |
| 22 | Navigation history stack preservation | Maintain session back/forward stack across crashes | M3 | R3 Survey |
| 23 | Crash injection stress harness | Automated test simulating renderer crashes and verifying recovery | M3 | R3 Survey |
| 24 | In-process CDP latency benchmarking | Benchmark DevTools dispatch to verify <5ms target | M4 | R4 Survey |
| 25 | Network & Console interception stress | High-throughput verification of ring buffers & rules under load | M4 | R4 Survey |
| 26 | Playwright recorder verification | Verify step recording and spec generation under load | M4 | R4 Survey |
| 27 | MCP concurrent load test | Stress test Axum MCP endpoints under concurrent requests | M4 | R4 Survey |
| 28 | E2E Test Suite Tiers 1-4 | 100% pass of requirement-driven opaque-box test suite | M5 | Dual Track |
| 29 | Tier 5 Adversarial hardening | White-box vulnerability/edge-case discovery & hardening | M5 | Dual Track |
| 30 | Workspace quality & compliance | Zero warnings (`cargo test`, `clippy -D warnings`, `fmt --check`) | M5 | Acceptance |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Engine Flags & Startup Performance | Chromium switches, startup timeline instrumentation, startup benchmark harness | none | IN_PROGRESS |
| M2 | Tab Discarding & Memory Saver Architecture | 30m idle sweep, multi-workspace teardown, safe discard rules, scroll persistence, sleeping tab UI, 20-tab RSS harness | M1 | PLANNED |
| M3 | Crash Isolation & Session Recovery Hardening | Native CEF termination hook, hard crash recreation, frontend crash notice, history preservation, crash stress test | M1 | PLANNED |
| M4 | Core Developer Feature Reliability | In-process CDP latency benchmark (<5ms), Network/Console stress test, Playwright recorder verification, MCP concurrency test | M1 | PLANNED |
| M5 | E2E Integration, 100% Pass & Adversarial Hardening | E2E test suite integration (Tiers 1-4), Tier 5 adversarial hardening, workspace cargo test/clippy/fmt compliance | M2, M3, M4 | PLANNED |

## Interface Contracts

### M1: Startup Instrumentation Contract
- Rust module: `apps/desktop/src-tauri/src/startup.rs`
- Data struct: `StartupTimeline { process_start: Instant, state_init_ms: f64, window_created_ms: f64, setup_complete_ms: f64, chrome_paint_ms: Option<f64> }`
- IPC Command: `report_startup_milestone(milestone: String, elapsed_ms: f64)`

### M2: Tab Discarding & Memory Saver Contract
- Store Schema Migration v7:
  - Add `scroll_x INTEGER NOT NULL DEFAULT 0`
  - Add `scroll_y INTEGER NOT NULL DEFAULT 0`
- `housekeeping::sweep`:
  - Iterates over all tabs in `state.host.views` across workspaces
  - Excludes active/showing tab, pinned tabs, essential tabs, tabs with `is_audible = true`, tabs with `is_local_bind(url) == true`
  - Closes CEF native webview via `host.close(tab.id)`
  - Sets `tab.state = TabState::Discarded`
- `commands::activate_tab`:
  - If `!host.has(tab_id)`: creates webview, loads URL, injects script `window.scrollTo(scroll_x, scroll_y)`
- Frontend: `TabStrip.tsx` renders discarded tabs with sleeping indicator/opacity, allows click to activate.

### M3: Crash Recovery Contract
- Event: `TabCrashed { tab_id: TabId, attempt: u32, recovering: bool, can_manual_reload: bool }`
- Frontend Store: `crashedTabs: Record<TabId, { attempt: number, recovering: boolean }>`
- Frontend UI: `TabCrashNotice.tsx` rendered when active tab is in `crashedTabs`, offers non-blocking reload button calling `ipc.reloadTab(tab_id)`
- Backend: `crash::recover` checks if CDP reload succeeds; if CDP connection dropped or closed, invokes native webview recreation via `activate_tab`.

### M4: Developer Browser Capabilities Benchmarking
- CDP Round-trip: `test_cdp_latency` measuring `Runtime.evaluate` round-trip over 1000 iterations (target < 5ms).
- Interception: `test_network_console_stress` verifying 1000 console entries and network events without buffer corruption.
- MCP Server: `test_mcp_concurrency` sending 50 parallel requests to `POST /mcp` verifying 0 errors and zero deadlock.

## Code Layout
- `apps/desktop/src-tauri/src/`:
  - `lib.rs`: Builder config, switches, startup hooks, plugin mounts.
  - `startup.rs`: Startup timeline recording & benchmark exports.
  - `housekeeping.rs`: Idle sweeps, safe discard evaluation, host cleanup.
  - `crash.rs`: Crash detection, backoff, recovery fallback, Specta event emission.
  - `engine.rs`: CEF webview lifecycle (`open`, `close`, `show`, `hide`, bounds).
  - `commands.rs`: IPC commands (`activate_tab`, `reloadTab`, etc.).
- `crates/dive-core/src/`:
  - `store.rs`: SQLite schema, migrations (v7 scroll), `archive_idle_tabs`.
  - `model.rs`: `Tab` struct with `scroll_x`, `scroll_y`.
- `apps/desktop/src/`:
  - `components/TabStrip.tsx`: Tab strip rendering (including sleeping tabs).
  - `components/TabCrashNotice.tsx`: Crash notification banner with 1-click reload.
  - `store/browser.ts`: Browser state store, listening to `tabCrashed`.
- `tests/` & `scripts/`:
  - `scripts/benchmark-startup.sh`: Startup benchmark runner.
  - `scripts/benchmark-memory.sh`: 20-tab memory stress and RSS profiling runner.
  - `tests/`: Integration & stress test suites.
