# Original User Request

## 2026-09-03T17:41:14Z

Audit, benchmark, and optimize the Dive browser (Tauri v2 + CEF + Rust + React 19) for elite performance, memory efficiency, and crash resilience to outperform Chrome and Brave in developer workflows.

Working directory: /Users/dvle/Documents/GitHub/dive-browser
Integrity mode: development

## Research-Backed Architectural Best Practices (Brave & Chrome Benchmarks)

1. **CEF Memory & Process Tuning**:
   - CEF does not run Chrome's automatic Memory Saver by default; the host must actively manage renderer lifecycles.
   - Configure Chromium command-line switches:
     - `--disable-extensions`: Eliminates ~40MB baseline memory overhead from unused extension systems.
     - `--process-per-site`: Consolidates multiple same-origin tabs into shared renderers.
     - `--renderer-process-limit`: Caps concurrent renderer processes to prevent memory thrashing under 20+ tab loads.
2. **Aggressive Tab Discarding (Memory Saver)**:
   - Modern Brave/Chrome standard: Unload background renderers after 15–30 minutes of inactivity.
   - Safe Discarding Rules: Never discard pinned tabs, essentials, tabs with active audio, or localhost dev server sessions.
   - Zero-Loss Restoration: Inactive tabs surrender native CEF webviews (`host.close`), preserving scroll/URL state in SQLite WAL, and recreate instantly on activation (`activate_tab`).
3. **In-Process CDP Latency**:
   - Keep CDP command round-trips under 5ms using direct CefBrowserHost DevTools message dispatch without external proxy overhead.

## Requirements

### R1. Engine Flags & Startup Performance Optimization
Configure high-efficiency Chromium command-line switches (`--disable-extensions`, `--process-per-site`, `--renderer-process-limit`) and benchmark app cold/warm startup times and initial window paint.

### R2. Tab Discarding & Memory Saver Architecture
Optimize `housekeeping.rs` idle sweeping to discard background `Today` tabs after 30 minutes. Profile memory before and after multi-tab stress (20+ tabs) to verify memory is reclaimed to the OS.

### R3. Crash Isolation & Session Recovery Hardening
Stress test renderer crash recovery under simulated process crashes. Verify that crashed tabs display a non-blocking recovery notice, preserve the navigation history stack, and recover with a single click without destabilizing sibling tabs.

### R4. Core Developer Feature Reliability & Verification
Verify all foundational developer browser capabilities (CDP event streaming, Network/Console interception, Playwright interaction recorder, and MCP server endpoints) under concurrent load to guarantee rock-solid stability.

## Acceptance Criteria

### Performance & Memory Metrics
- [ ] 20-tab memory footprint measured and verified significantly lower than baseline Chrome/Brave through active tab discarding
- [ ] Startup time and tab switching latency benchmarked with zero UI thread blocking

### Reliability & Stability
- [ ] Inactive tab discard and recreation verified with zero data loss or unhandled errors
- [ ] 100% test pass rate across all workspace crates (`cargo test --workspace`)
- [ ] Zero compiler warnings and clean clippy check (`cargo clippy --workspace --all-targets -- -D warnings`)
- [ ] Zero formatting discrepancies (`cargo fmt --all -- --check`)
