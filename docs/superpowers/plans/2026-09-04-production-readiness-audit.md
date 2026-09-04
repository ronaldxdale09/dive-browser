# Dive Production-Readiness Audit Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce an evidence-backed inventory and ranked defect register for every named Dive surface and process, drive fixes through independent test-first plans, and reconcile the final proof into one release-readiness report.

**Architecture:** `docs/production-readiness.md` is the append-only audit ledger: inventory rows establish reachability and evidence, the defect register links observations to exact source, and the verification section records commands and measurements. Independent code changes remain in the existing subsystem plans or receive a focused plan after the defect is observed, which keeps recording, privacy, frontend, and harness work separable from the audit itself.

**Tech Stack:** Tauri v2 CEF runtime, Rust 2024 workspace, React 19, TypeScript, Zustand, Tailwind 4, Vitest, Cargo, Python MCP driver, shell benchmark harnesses.

**Spec:** `/Users/dvle/.codex/attachments/67d55baf-265f-4e12-b28e-ceb8f79c3e9e/pasted-text-1.txt`

## Global Constraints

- Never run `tauri dev`, stop a user-owned Dive process, or use bare `cargo fmt`.
- Preserve every pre-existing modified or untracked file; stage and commit only explicit audit or task paths.
- Run live checks only from a copied `Probe.app` with executable name `dive-desktop`, a fresh `DIVE_DATA_DIR`, a free `DIVE_MCP_PORT`, and `DIVE_WINDOW_HIDDEN=1`.
- Native view creation, movement, and visibility changes must execute through `on_main`; acquire the host lock before the store lock and hold neither across an await.
- Schema changes append to `MIGRATIONS` and update the append-only checksum test.
- A completion claim requires current command output or a live measurement; unverified behavior is marked partial or deferred.

---

### Task 1: Freeze the audit baseline

**Files:**
- Create: `docs/production-readiness.md`
- Read: `RELEASING.md`
- Read: `docs/PLAN.md`
- Read: `docs/superpowers/specs/*.md`
- Read: `docs/superpowers/plans/*.md`

**Interfaces:**
- Consumes: the production-readiness spec and current Git worktree state.
- Produces: a dated baseline identifying branch, HEAD, owned audit files, pre-existing dirty paths, and proof vocabulary.

- [x] **Step 1: Record branch, HEAD, and pre-existing dirty paths**

Run: `git status --short --branch && git log -1 --oneline`

Expected: branch `autopilot/dive-build`; dirty recording/screen paths are explicitly treated as another session's work.

- [x] **Step 2: Read release and product requirements**

Run: `sed -n '1,260p' RELEASING.md && sed -n '1,320p' docs/PLAN.md`

Expected: exact CI/live commands, process boundaries, and product reachability are available for the inventory.

- [x] **Step 3: Establish a private live baseline**

Run after copying the bundle to `/tmp/dive-audit-probe/Probe.app`: `DIVE_WINDOW_HIDDEN=1 LIVE_MCP_PORT=17495 DIVE_BIN=/tmp/dive-audit-probe/Probe.app/Contents/MacOS/dive-desktop scripts/live-check.sh`

Expected: tab read, screenshot, discard/wake, renderer recovery, and CDP p95 output; every failed attempt is retained in the ledger as evidence.

### Task 2: Complete the surface and process inventory

**Files:**
- Modify: `docs/production-readiness.md`
- Read: `apps/desktop/src/App.tsx`
- Read: `apps/desktop/src/components/**/*.tsx`
- Read: `apps/desktop/src/store/**/*.ts`
- Read: `apps/desktop/src-tauri/src/**/*.rs`
- Read: `crates/dive-{core,cdp,mcp,agent}/src/**/*.rs`

**Interfaces:**
- Consumes: baseline proof vocabulary from Task 1.
- Produces: one row per requested chrome surface, engine process, and cross-cutting concern with entry point, reachability, state, evidence, label behavior, failure behavior, and keyboard escape behavior.

- [x] **Step 1: Map every chrome surface to its rendered entry point**

Run: `rg -n 'export function|role="dialog"|aria-label=|const PANELS|const SECTIONS' apps/desktop/src/components apps/desktop/src/App.tsx`

Expected: every surface named in the spec has a row or is marked missing with the search evidence.

- [x] **Step 2: Map every engine process to commands and ownership**

Run: `rg -n 'pub\(crate\) (async )?fn|pub (async )?fn|generate_handler|tool_catalog' apps/desktop/src-tauri/src crates`

Expected: lifecycle, persistence, housekeeping, crash, download, permission, zoom, bounds, discovery, capture, MCP, agent, keychain, updater, logging, panic, migration, and backup rows are present.

- [x] **Step 3: Map cross-cutting behavior and platform conditionals**

Run: `rg -n 'cfg\(|Escape|motion-reduce|dark|light|720|empty|Loading|offline|quit|relaunch' apps crates scripts`

Expected: every cross-cutting requirement is evidenced or explicitly marked partial/missing.

- [x] **Step 4: Verify inventory consistency**

Run: `rg -n '^\| ' docs/production-readiness.md`

Expected: every row answers all three user questions and uses only `works`, `partial`, `broken`, or `missing`.

### Task 3: Rank observed defects

**Files:**
- Modify: `docs/production-readiness.md`

**Interfaces:**
- Consumes: completed inventory rows and current test/live output.
- Produces: ranked concrete defects grouped by the seven categories in the spec, each with impact, frequency, source line, evidence, disposition, and owning plan.

- [x] **Step 1: Search for silent failures and unsafe completion claims**

Run: `rg -n 'catch\(\(\) =>|catch \{|unwrap\(|expect\(|void ipc\.|setError\(null\)' apps/desktop/src apps/desktop/src-tauri/src crates`

Expected: production sites are distinguished from test-only calls; each observed silent failure becomes a cited defect.

- [x] **Step 2: Search for unbounded rendering and cross-tab subscriptions**

Run: `rg -n '\.map\(|overflow-y-auto|use[A-Z][A-Za-z]+\(\(s\)' apps/desktop/src/components apps/desktop/src/store`

Expected: lists capable of exceeding one screen have a cap/window proof or a ranked defect.

- [x] **Step 3: Rank by impact multiplied by expected frequency**

Expected: crash/hang and loss defects precede dead controls, missing states, accessibility, performance, consistency, and platform gaps when scores tie.

- [x] **Step 4: Create or assign a focused implementation plan for every fixable defect**

Expected: each defect links to one existing plan under `docs/superpowers/plans/` or a new plan containing a failing test, minimal implementation, exact focused test, full gates, and commit boundary.

### Task 4: Execute focused fixes without crossing ownership boundaries

**Files:**
- Modify: only files named by the focused plan being executed.
- Test: the focused test paths named by that plan.

**Interfaces:**
- Consumes: one ranked defect and its focused implementation plan.
- Produces: one independently reviewable change, proof, and explicit-path commit.

- [x] **Step 1: Recheck worktree ownership before each defect**

For the first-ranked permission-state defect, run: `git status --short && git diff -- apps/desktop/src/components/SettingsDialog.tsx apps/desktop/src/components/SettingsDialog.test.tsx`

Expected: overlap with another session causes the defect to be deferred or solved in a non-overlapping path, never silently absorbed.

- [x] **Step 2: Write and run the smallest failing proof**

Expected: the focused Vitest/Cargo test or live-check assertion fails for the observed reason before implementation.

- [x] **Step 3: Implement the smallest root-cause fix**

Expected: existing store reducers, overlay hooks, focus hooks, main-thread hopping, and lock order are preserved.

- [x] **Step 4: Run the focused proof and required gates**

Run: `cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace && pnpm -r typecheck && pnpm -r lint && pnpm -r test && git diff --exit-code -- apps/desktop/src/generated`

Expected: all commands exit 0; engine/lifecycle changes additionally pass the copied-Probe live and memory harnesses.

- [x] **Step 5: Commit and push explicit task paths**

For the first-ranked permission-state defect, run: `git add apps/desktop/src/components/SettingsDialog.tsx apps/desktop/src/components/SettingsDialog.test.tsx docs/production-readiness.md && git commit -m 'fix: keep site permission failures visible and recoverable' && git push origin autopilot/dive-build`

Expected: no pre-existing dirty path enters the commit unless the ownership is explicitly reconciled first.

### Task 5: Reconcile release readiness

**Files:**
- Modify: `docs/production-readiness.md`
- Modify: `docs/PLAN.md`

**Interfaces:**
- Consumes: every defect disposition, commit, gate result, and benchmark artifact.
- Produces: the Phase D report and a product plan whose current-state claims match verified behavior.

- [x] **Step 1: Run final static and generated-binding gates**

Expected: exact command output and timestamps are copied into the verification section. Static gates passed; the generated-binding failure is isolated to the concurrent recording API and recorded as an actionable deferral.

- [x] **Step 2: Run final private live, memory, and startup probes**

Expected: CDP p95 is below 5 ms, 20-tab reclaim is at least 30 percent of growth, warm startup is below 600 ms, and every live scenario actually present in `scripts/live-check.sh` is listed without overclaiming missing scenarios.

- [x] **Step 3: Reconcile each inventory row and defect disposition**

Expected: every defect is `fixed` with proof or `deferred` with a reason and a concrete user action; no unresolved item is described as complete.

- [x] **Step 4: Update the product plan and commit the report**

Expected: `docs/PLAN.md` links to the audit and distinguishes shipped, verified behavior from roadmap intent; the audit/report commit names its exact proof.
