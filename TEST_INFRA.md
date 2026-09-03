# Dive Browser Optimization — Test Infrastructure Specification (`TEST_INFRA.md`)

## 1. Executive Summary & Test Philosophy

The Dive Browser Optimization project aims to deliver elite performance, memory efficiency, and crash resilience across four core requirement domains:
- **R1**: Engine Flags & Startup Performance Optimization
- **R2**: Tab Discarding & Memory Saver Architecture
- **R3**: Crash Isolation & Session Recovery Hardening
- **R4**: Core Developer Feature Reliability & Verification

To guarantee robust quality without relying on fragile implementation internals, the E2E test infrastructure adheres to five guiding principles:

1. **Requirement-Driven**: All test assertions derive directly from specifications in `ORIGINAL_REQUEST.md` and `PROJECT.md`, rather than internal implementation details.
2. **Complete Coverage Across Tiers 1–4**: Every feature in `PROJECT.md § Feature Inventory` is mapped to and validated by tests spanning functional coverage, boundaries, cross-feature interactions, and real-world workflows.
3. **Interface-Compatible (Opaque-Box)**: Tests exercise the system strictly through public entry points:
   - CLI flags (`--disable-extensions`, `--process-per-site`, `--renderer-process-limit`)
   - Environment variables (`DIVE_RENDERER_PROCESS_LIMIT`, `DIVE_HEADLESS`)
   - IPC command contracts (`activate_tab`, `report_startup_milestone`, `reloadTab`, `setContentBounds`)
   - SQLite WAL database store interface (`store.rs`, schema migrations, `archive_idle_tabs`)
   - In-process CDP protocol dispatch (`dive_cdp::CdpClient`, `Runtime.evaluate`, `Page.reload`, `Inspector.targetCrashed`)
   - Model Context Protocol (MCP) HTTP JSON-RPC endpoints (`POST /mcp` with bearer auth and origin checks)
4. **Progressive Testability**: Tier 1 tests provide unambiguous pass/fail signals during incremental milestones. Unimplemented milestone features are cleanly reported without stalling unrelated tests.
5. **Adversarial & Boundary Verification**: Edge cases, clock skew, process limits, malformed inputs, buffer saturation, token theft, and crash bursts are aggressively verified.

---

## 2. Test Architecture & Directory Layout

The E2E testing infrastructure is organized under `tests/e2e/` as a dedicated, fully-integrated test crate within the Dive workspace:

```
tests/e2e/
├── Cargo.toml                    # Package manifest for dive-e2e test crate
├── src/
│   ├── lib.rs                    # Test harness exports, shared mocks, test fixtures
│   ├── tier1_feature_coverage/   # Tier 1: Primary feature coverage (>=5 per area)
│   │   ├── mod.rs
│   │   ├── test_r1_startup.rs    # R1: CLI switches, StartupTimeline, paint hook
│   │   ├── test_r2_discard.rs    # R2: 30m sweep, multi-workspace, safe exemptions
│   │   ├── test_r3_crash.rs      # R3: Crash detection, backoff, isolation, recovery
│   │   └── test_r4_dev_tools.rs  # R4: CDP latency, console/net buffers, MCP tools
│   ├── tier2_boundaries/         # Tier 2: Boundary & corner cases (>=5 per area)
│   │   ├── mod.rs
│   │   ├── test_r1_limits.rs     # Extreme process limits, invalid env, clock skew
│   │   ├── test_r2_boundaries.rs # Exact 30m cutoff, extreme scroll, empty workspaces
│   │   ├── test_r3_bursts.rs     # Rapid crash loops, non-existent tabs, cross-ws crash
│   │   └── test_r4_stress.rs     # Ring buffer overflow, malformed CDP, invalid tokens
│   ├── tier3_interactions/       # Tier 3: Pairwise cross-feature interactions
│   │   ├── mod.rs
│   │   └── test_pairwise.rs      # 8 cross-feature matrix interactions
│   └── tier4_scenarios/          # Tier 4: Real-world application scenarios
│       ├── mod.rs
│       ├── test_scenario_multi_tab.rs      # 20-tab workspace workflow & memory sweep
│       ├── test_scenario_crash_load.rs     # Renderer crash resilience under load
│       └── test_scenario_dev_profiling.rs  # Full developer profiling & MCP session
scripts/
└── run-e2e-tests.sh              # Automated test runner with reporting & filtering
```

---

## 3. Feature Inventory Mapping to Test Tiers

| # | Feature | Description | Milestone | Primary Tier | Test File |
|---|---------|-------------|-----------|--------------|-----------|
| 1 | `--disable-extensions` switch | Eliminates extension system overhead | M1 | Tier 1, Tier 2 | `tier1_feature_coverage::test_r1_startup` |
| 2 | `--process-per-site` switch | Consolidates same-origin tabs | M1 | Tier 1 | `tier1_feature_coverage::test_r1_startup` |
| 3 | `--renderer-process-limit` switch | Caps concurrent renderers via env | M1 | Tier 1, Tier 2 | `tier2_boundaries::test_r1_limits` |
| 4 | Startup timeline instrumentation | Captures process milestones | M1 | Tier 1, Tier 2 | `tier1_feature_coverage::test_r1_startup` |
| 5 | Initial window paint & chrome readiness | IPC hook for React boot & paint | M1 | Tier 1 | `tier1_feature_coverage::test_r1_startup` |
| 6 | Startup benchmarking harness | Automated cold/warm startup runner | M1 | Tier 1 | `tier1_feature_coverage::test_r1_startup` |
| 7 | 30-minute idle sweeping | Discard background tabs after 30m | M2 | Tier 1, Tier 2 | `tier1_feature_coverage::test_r2_discard` |
| 8 | Multi-workspace native view sweep | Close CEF views across workspaces | M2 | Tier 1, Tier 4 | `tier1_feature_coverage::test_r2_discard` |
| 9 | Safe discard: pinned & essential | Exclude pinned/essential tabs | M2 | Tier 1 | `tier1_feature_coverage::test_r2_discard` |
| 10 | Safe discard: audio-playing tabs | Protect audio tabs from discard | M2 | Tier 1 | `tier1_feature_coverage::test_r2_discard` |
| 11 | Safe discard: localhost dev sessions | Exclude loopback/devserver URLs | M2 | Tier 1 | `tier1_feature_coverage::test_r2_discard` |
| 12 | Safe discard: active screencast/agents | Exclude active automation tabs | M2 | Tier 1 | `tier1_feature_coverage::test_r2_discard` |
| 13 | Scroll position persistence in SQLite | Schema migration for scroll_x/scroll_y | M2 | Tier 1, Tier 2 | `tier1_feature_coverage::test_r2_discard` |
| 14 | Discarded tab reactivation | Restore URL, scroll & view | M2 | Tier 1, Tier 4 | `tier1_feature_coverage::test_r2_discard` |
| 15 | TabStrip sleeping tab display | UI sleeping indicator & opacity | M2 | Tier 1 | `tier1_feature_coverage::test_r2_discard` |
| 16 | 20-tab memory profiling harness | Automated RSS measurement script | M2 | Tier 1, Tier 4 | `tier4_scenarios::test_scenario_multi_tab` |
| 17 | Native CEF termination hook | `on_web_content_process_terminate` | M3 | Tier 1 | `tier1_feature_coverage::test_r3_crash` |
| 18 | Hard crash recovery fallback | Recreate webview if Page.reload fails | M3 | Tier 1, Tier 3 | `tier1_feature_coverage::test_r3_crash` |
| 19 | Sibling tab crash isolation | Crashes in Tab A do not harm Tab B | M3 | Tier 1, Tier 4 | `tier1_feature_coverage::test_r3_crash` |
| 20 | Frontend `tabCrashed` listener | Browser store crash event handler | M3 | Tier 1 | `tier1_feature_coverage::test_r3_crash` |
| 21 | Non-blocking crash recovery notice | UI banner with 1-click reload | M3 | Tier 1 | `tier1_feature_coverage::test_r3_crash` |
| 22 | Navigation history preservation | History stack preserved across crash | M3 | Tier 1 | `tier1_feature_coverage::test_r3_crash` |
| 23 | Crash injection stress harness | Simulated crash verification | M3 | Tier 1, Tier 2 | `tier2_boundaries::test_r3_bursts` |
| 24 | In-process CDP latency benchmark | DevTools dispatch <5ms target | M4 | Tier 1, Tier 4 | `tier1_feature_coverage::test_r4_dev_tools` |
| 25 | Network/Console interception stress | Ring buffers & rules under load | M4 | Tier 1, Tier 2 | `tier1_feature_coverage::test_r4_dev_tools` |
| 26 | Playwright recorder verification | Step recording & spec generation | M4 | Tier 1, Tier 3 | `tier1_feature_coverage::test_r4_dev_tools` |
| 27 | MCP concurrent load test | 50 parallel requests to `POST /mcp` | M4 | Tier 1, Tier 2 | `tier1_feature_coverage::test_r4_dev_tools` |

---

## 4. Test Tier Specifications

### Tier 1: Feature Coverage (>=5 test cases per feature area)
- **Engine Flags & Startup (R1)**:
  1. `test_cli_flags_disable_extensions_switch`: Verifies `--disable-extensions` switch correctly formatted without value.
  2. `test_cli_flags_process_per_site_switch`: Verifies `--process-per-site` switch correctly formatted without value.
  3. `test_cli_flags_renderer_process_limit_env_config`: Verifies `DIVE_RENDERER_PROCESS_LIMIT` value formatting.
  4. `test_startup_timeline_monotonic_milestones`: Validates `StartupTimeline` captures ordered sequence of startup phases.
  5. `test_report_startup_milestone_ipc_contract`: Verifies IPC milestone reporting records chrome paint.
  6. `test_startup_benchmark_script_exists_and_executable`: Verifies benchmark script availability and format.
- **Tab Discarding & Memory Saver (R2)**:
  1. `test_idle_sweep_discards_inactive_today_tabs`: Verifies background tabs idle >30m transition to `discarded`.
  2. `test_safe_discard_protects_pinned_and_essential_tabs`: Verifies pinned and essential tabs never discarded.
  3. `test_safe_discard_protects_localhost_dev_sessions`: Verifies loopback/localhost ports never discarded.
  4. `test_safe_discard_protects_audible_and_active_tabs`: Verifies tabs playing audio or active in view never discarded.
  5. `test_multi_workspace_sweep_cleans_background_webviews`: Verifies tabs in inactive workspaces are swept.
  6. `test_tab_reactivation_restores_url_and_scroll`: Verifies tab reactivation restores URL and scroll coordinates.
- **Crash Isolation & Recovery (R3)**:
  1. `test_renderer_crash_triggers_tab_crashed_event`: Verifies crash emission with attempt counter.
  2. `test_crash_backoff_enforces_retry_ceiling`: Verifies exponential backoff caps at 3 attempts.
  3. `test_sibling_tab_isolation_on_renderer_crash`: Verifies crash in Tab A leaves Tab B intact.
  4. `test_hard_crash_recovery_fallback_to_webview_recreation`: Verifies fallback when CDP reload fails.
  5. `test_navigation_history_preserved_across_crash`: Verifies URL and navigation stack survive crash.
  6. `test_manual_reload_resets_crash_state`: Verifies 1-click reload resets attempt count.
- **Core Developer Capabilities (R4)**:
  1. `test_in_process_cdp_round_trip_latency`: Benchmarks CDP dispatch latency target <5ms.
  2. `test_console_interception_captures_all_log_levels`: Verifies Info, Warn, Error in ring buffer.
  3. `test_network_interception_tracks_request_lifecycle`: Verifies request/response lifecycle tracking.
  4. `test_playwright_recorder_generates_valid_spec`: Verifies recorded clicks generate Playwright code.
  5. `test_mcp_server_authenticates_bearer_token`: Verifies token and origin validation on `POST /mcp`.
  6. `test_mcp_concurrent_requests_handled_safely`: Verifies 50 parallel requests without error.

### Tier 2: Boundary & Corner Cases (>=5 test cases per feature area)
- **Engine Flags & Startup Boundaries**:
  1. `test_extreme_renderer_process_limits`: Boundary values (0, 1, 1024, max int).
  2. `test_invalid_and_empty_env_var_fallback`: Graceful default fallback on malformed env values.
  3. `test_clock_skew_and_zero_elapsed_milestones`: Handling out-of-order or duplicate timestamp inputs.
  4. `test_unknown_milestone_name_resilience`: Unknown milestone strings handled safely.
  5. `test_rapid_milestone_burst_concurrency`: Concurrent milestone calls do not corrupt timeline.
- **Tab Discarding Boundaries**:
  1. `test_exact_30_minute_cutoff_boundary`: 29m59s (kept) vs 30m00s (kept) vs 30m01s (discarded).
  2. `test_extreme_and_negative_scroll_coordinates`: (0,0), (100000, 50000), clamped negative coordinates.
  3. `test_empty_workspace_and_all_protected_tabs`: Sweep on empty workspace or all-pinned tabs.
  4. `test_rapid_successive_idle_sweeps_idempotency`: Back-to-back sweeps produce no spurious mutations.
  5. `test_special_url_discard_and_reactivation`: URLs with fragments (`#hash`), query strings, and data URIs.
- **Crash Recovery Boundaries**:
  1. `test_rapid_crash_loop_lockout`: 4 rapid crashes trigger lockout requiring manual intervention.
  2. `test_crash_event_for_non_existent_tab`: Crash signal for unknown tab ID handled gracefully.
  3. `test_simultaneous_crashes_across_workspaces`: Multi-workspace concurrent crashes isolated.
  4. `test_crash_handling_on_already_discarded_tab`: Crash on discarded tab handled cleanly.
  5. `test_crash_window_expiration_resets_counter`: Crashes spaced >30s apart reset attempt counter.
- **Developer Features Boundaries**:
  1. `test_mcp_invalid_bearer_token_rejection`: 401 Unauthorized on bad token or missing header.
  2. `test_mcp_unauthorized_external_origin_rejection`: 403 Forbidden on untrusted origin header.
  3. `test_ring_buffer_saturation_and_overflow`: Flooding 2,000 logs into 500-capacity ring buffer.
  4. `test_malformed_and_oversized_cdp_payloads`: Truncated JSON / oversized payloads handled safely.
  5. `test_recorder_special_character_and_empty_inputs`: Nonce validation, unicode strings, empty text.

### Tier 3: Cross-Feature Combinations (Pairwise Interactions)
1. `test_discard_while_cdp_active`: Active CDP session drops cleanly when tab is discarded.
2. `test_crash_recovery_during_navigation`: Renderer crash while page is actively navigating.
3. `test_mcp_command_on_discarded_tab`: MCP tool call on discarded tab triggers auto-activation or clear error.
4. `test_tab_discard_while_interception_streaming`: Tab discard cleans up active network/console ring buffers.
5. `test_crash_recovery_while_recording`: Crash during Playwright recording resets recorder gracefully.
6. `test_concurrent_mcp_requests_during_idle_sweep`: Concurrency test ensuring no deadlock between MCP and housekeeping.
7. `test_tab_reactivation_during_crash_recovery`: User clicking reactivate while crash reload is in flight.
8. `test_workspace_switching_during_crash_or_discard`: Workspace switch while background operations occur.

### Tier 4: Real-World Application Scenarios
1. **Scenario 1: 20-Tab Complex Developer Session**:
   - 20 tabs across 2 workspaces: active dev servers (`localhost:3000`), pinned documentation, audio streaming, and general web pages.
   - 35 minutes idle time elapsed.
   - Housekeeping sweep triggered.
   - Assert: Only non-protected background tabs discarded; native views closed; OS memory freed.
   - Reactivate 3 tabs: verify URL, scroll position, and tab state restored with zero data loss.
2. **Scenario 2: High-Concurrency Developer Load with Simulated Renderer Crash**:
   - 10 active tabs under concurrent network traffic and console logging.
   - Forced renderer crash in Tab 4.
   - Assert: Sibling tabs 1-3, 5-10 continue unhindered; Tab 4 displays crash recovery notice; 1-click reload restores tab.
3. **Scenario 3: Full End-to-End Developer Automation & Profiling**:
   - Engine flags active (`--disable-extensions`, `--process-per-site`, `--renderer-process-limit=8`).
   - Startup timeline measured.
   - MCP client authenticates via token, inspects tabs, triggers Playwright interaction recording, captures clicks, generates test script.
   - CDP latency benchmark verified <5ms.

---

## 5. Test Runner & Execution Semantics

The test suite is driven via `scripts/run-e2e-tests.sh`:

```bash
# Run complete E2E test suite (Tiers 1-4)
./scripts/run-e2e-tests.sh

# Run specific tier
./scripts/run-e2e-tests.sh --tier 1
./scripts/run-e2e-tests.sh --tier 2
./scripts/run-e2e-tests.sh --tier 3
./scripts/run-e2e-tests.sh --tier 4

# Run specific feature area
./scripts/run-e2e-tests.sh --feature r1
./scripts/run-e2e-tests.sh --feature r2
./scripts/run-e2e-tests.sh --feature r3
./scripts/run-e2e-tests.sh --feature r4

# Cargo direct command
cargo test -p dive-e2e -- --nocapture
```

### Exit Codes & Pass/Fail Semantics
- `0`: All targeted tests passed cleanly.
- `1`: One or more test assertions failed.
- `2`: Build or compilation failure.

---

## 6. Coverage Thresholds & Quality Gates

To achieve `TEST_READY.md` certification, the following quality gates must be satisfied:
- **Tier 1 Pass Rate**: 100% of implemented milestone features pass.
- **Tier 2 Pass Rate**: 100% of boundary test cases pass.
- **Tier 3 Pass Rate**: 100% of cross-feature pairwise interactions pass.
- **Tier 4 Pass Rate**: 100% of real-world multi-step application scenarios pass.
- **Clippy & Style**: Zero warnings (`cargo clippy -p dive-e2e -- -D warnings`).
- **Formatting**: Zero format discrepancies (`cargo fmt --check`).
