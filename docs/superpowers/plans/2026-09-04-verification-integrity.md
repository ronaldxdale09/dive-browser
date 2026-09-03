# Verification Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a compiling workspace and make every test, runner, CI gate, and status document accurately describe the evidence it provides.

**Architecture:** Preserve the current `tests/e2e` path and `dive-e2e` package for compatibility, but relabel their public surface as a verification suite. Add executable tests around the runner and documentation, then record one complete repository check from a stable working-tree snapshot.

**Tech Stack:** Rust 2024, Cargo, Bash, Node.js 24 `node:test`, pnpm, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-04-verification-integrity-design.md`

## Global Constraints

- Use “Runtime E2E” only for a test that launches Dive with CEF and drives externally observable behavior.
- Specification-model tests document semantics but do not prove production R1–R3 behavior.
- Keep `tests/e2e` and `dive-e2e` during this stage.
- Preserve unrelated edits and stage only the exact files named by each task.
- Missing results and command failures remain failures.
- Do not implement R1 startup measurement, R2 memory saver, or R3 crash recovery here.

---

### Task 1: Restore the verification crate's Browser contract

**Files:**
- Modify: `tests/e2e/src/fixtures.rs:350`
- Test: `tests/e2e/src/fixtures.rs`

**Interfaces:**
- Consumes: `Browser::close(&self, TabId) -> Result<(), BrowserError>`.
- Produces: `TestFakeBrowser::close` with existing-tab removal and `TabNotFound` for an unknown id.

- [ ] **Step 1: Reproduce the current failure**

```bash
cargo check -p dive-e2e --tests
```

Expected: `E0046` for missing `close`. If another process already changed the shared checkout, inspect and record that baseline rather than overwriting it.

- [ ] **Step 2: Add focused behavior tests**

Append to the fixture test module:

```rust
#[tokio::test]
async fn fake_browser_close_removes_an_existing_tab() {
    let tab = TabInfo {
        id: TabId::new().to_string(),
        url: "https://example.test".into(),
        title: "Example".into(),
        active: true,
    };
    let id = tab.id.parse().expect("fixture id");
    let browser = TestFakeBrowser::with_initial_tabs(vec![tab]);
    browser.close(id).await.expect("existing tab closes");
    assert!(browser.tabs().await.expect("tab list").is_empty());
}

#[tokio::test]
async fn fake_browser_close_rejects_an_unknown_tab() {
    let browser = TestFakeBrowser::default();
    let id = TabId::new();
    let error = browser.close(id).await.expect_err("unknown tab is rejected");
    assert!(matches!(error, BrowserError::TabNotFound(found) if found == id.to_string()));
}
```

- [ ] **Step 3: Verify the intended red state**

```bash
cargo test -p dive-e2e fake_browser_close -- --nocapture
```

Expected: compilation fails because the fake lacks `close`, not because the tests are malformed.

- [ ] **Step 4: Implement the minimal fake method**

Add beside `activate`:

```rust
async fn close(&self, tab: TabId) -> Result<(), BrowserError> {
    let mut tabs = self.tabs.lock().unwrap();
    let before = tabs.len();
    tabs.retain(|candidate| candidate.id != tab.to_string());
    if tabs.len() == before {
        return Err(BrowserError::TabNotFound(tab.to_string()));
    }
    Ok(())
}
```

- [ ] **Step 5: Verify and commit**

```bash
cargo test -p dive-e2e fake_browser_close -- --nocapture
cargo check -p dive-e2e --tests
git add tests/e2e/src/fixtures.rs
git diff --cached --check
git commit -m "test: restore verification browser contract"
```

Expected: two focused tests pass, the crate checks, and only the fixture is committed.

---

### Task 2: Add a truthful, failure-propagating runner

**Files:**
- Create: `scripts/run-verification-tests.sh`
- Create: `scripts/run-verification-tests.test.mjs`
- Modify: `scripts/run-e2e-tests.sh:1`
- Modify: `package.json:6`
- Modify: `.github/workflows/ci.yml:48`

**Interfaces:**
- Consumes: `cargo test -p dive-e2e` plus existing tier/feature filters.
- Produces: canonical `run-verification-tests.sh`, compatibility wrapper, and `pnpm test:verification-runner`.

- [ ] **Step 1: Write black-box runner tests**

Create `scripts/run-verification-tests.test.mjs`:

```javascript
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const runner = join(root, "scripts/run-verification-tests.sh");

async function runWithFakeCargo(exitCode, args = []) {
  const dir = await mkdtemp(join(tmpdir(), "dive-verification-"));
  const cargo = join(dir, "cargo");
  await writeFile(cargo, "#!/usr/bin/env bash\nexit " + exitCode + "\n");
  await chmod(cargo, 0o755);
  try {
    return spawnSync("bash", [runner, ...args], {
      cwd: root,
      env: { ...process.env, PATH: dir + ":" + process.env.PATH },
      encoding: "utf8",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("runner uses verification terminology", async () => {
  const source = await readFile(runner, "utf8");
  assert.match(source, /Dive Browser Optimization — Verification Suite/);
  assert.doesNotMatch(source, /All requirement-driven E2E tests verified successfully/);
});

test("runner propagates Cargo failure", async () => {
  const result = await runWithFakeCargo(23);
  assert.equal(result.status, 23);
  assert.match(result.stdout, /STATUS: FAILED/);
});

test("runner reports successful verification", async () => {
  const result = await runWithFakeCargo(0, ["--tier", "2", "--feature", "R3"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Verification tests completed successfully/);
});
```

- [ ] **Step 2: Verify red**

```bash
node --test scripts/run-verification-tests.test.mjs
```

Expected: `ENOENT` for the canonical runner.

- [ ] **Step 3: Implement the canonical runner and wrapper**

Copy the current argument parsing and filter construction into the new runner. Keep:

```bash
CARGO_CMD=("cargo" "test" "-p" "dive-e2e")
```

Use heading `Dive Browser Optimization — Verification Suite`. Print `Verification tests completed successfully.` only after Cargo exits zero. Print `STATUS: FAILED` otherwise and finish with `exit "$EXIT_CODE"`.

Replace the old runner with:

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
printf '%s\n' "run-e2e-tests.sh is retained for compatibility; running the verification suite." >&2
exec "$SCRIPT_DIR/run-verification-tests.sh" "$@"
```

Make both scripts executable.

- [ ] **Step 4: Wire local and CI checks**

Add:

```json
"test:verification-runner": "node --test scripts/run-verification-tests.test.mjs"
```

Change root `test` to:

```json
"test": "pnpm test:verification-runner && pnpm --filter @dive/desktop test"
```

Add after `cargo test --workspace` in CI:

```yaml
      - run: pnpm test:verification-runner
```

- [ ] **Step 5: Verify and commit**

```bash
node --test scripts/run-verification-tests.test.mjs
bash -n scripts/run-verification-tests.sh scripts/run-e2e-tests.sh
pnpm test:verification-runner
git add scripts/run-verification-tests.sh scripts/run-verification-tests.test.mjs scripts/run-e2e-tests.sh package.json .github/workflows/ci.yml
git diff --cached --check
git commit -m "test: make verification runner truthful"
```

Expected: three Node tests pass and only the five named files are committed.

---

### Task 3: Replace unsupported readiness claims

**Files:**
- Modify: `.gitignore:19`
- Modify: `tests/e2e/src/lib.rs:1`
- Modify: `TEST_READY.md:1`
- Modify: `TEST_INFRA.md:1`
- Create: `scripts/verification-docs.test.mjs`
- Modify: `package.json:6`

**Interfaces:**
- Consumes: the approved evidence taxonomy.
- Produces: honest status/infrastructure documents and automated consistency assertions.

- [ ] **Step 1: Add documentation tests**

Create `scripts/verification-docs.test.mjs`:

```javascript
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("status avoids unsupported completion claims", async () => {
  const status = await read("TEST_READY.md");
  assert.doesNotMatch(status, /COMPLETE — 100% PASS RATE/);
  assert.doesNotMatch(status, /Complete coverage of all 27 features/);
  assert.match(status, /Specification-model/);
  assert.match(status, /Runtime E2E/);
});

test("infrastructure distinguishes intended evidence", async () => {
  const infrastructure = await read("TEST_INFRA.md");
  assert.match(infrastructure, /Intended architecture/);
  assert.match(infrastructure, /does not launch Dive with CEF/);
});

test("workspace tests are not ignored", async () => {
  const ignore = await read(".gitignore");
  assert.equal(ignore.split(/\r?\n/).some((line) => line.trim() === "/tests"), false);
});

test("crate metadata uses verification terminology", async () => {
  const lib = await read("tests/e2e/src/lib.rs");
  assert.match(lib, /Verification Suite/);
  assert.doesNotMatch(lib, /opaque-box integration and E2E tests covering/);
});
```

- [ ] **Step 2: Verify all assertions are red**

```bash
node --test scripts/verification-docs.test.mjs
```

Expected: failures for the readiness claim, infrastructure wording, ignored source directory, and crate metadata.

- [ ] **Step 3: Rewrite status and infrastructure**

Replace `TEST_READY.md` with `# TEST STATUS — Dive Browser Optimization`. Include evidence-category definitions and this requirement status:

| Requirement | Status | Missing production evidence |
| --- | --- | --- |
| R1 | Partially verified | Live first paint and validated cold/warm benchmark |
| R2 | Unverified | Safe discard, scroll restoration, live CEF memory measurement |
| R3 | Partially verified | Native termination, recreation fallback, frontend recovery, real crash |
| R4 | Partially verified | Live CEF latency and sustained runtime load |

State that `dive-e2e` mixes production-facing integration tests with specification-model tests and launches no packaged CEF application.

Rewrite `TEST_INFRA.md` with title `Verification Infrastructure`, status `Intended architecture`, the taxonomy, current inventory, and planned runtime coverage. Include:

```markdown
The current `dive-e2e` crate runs in process and does not launch Dive with CEF. Its fake-browser and specification-model scenarios are not Runtime E2E evidence.
```

Remove static pass transcripts and label evidence `unit`, `integration`, `specification-model`, or `planned`.

- [ ] **Step 4: Update metadata and ignore rules**

Use `Dive Browser Optimization Verification Suite` in `tests/e2e/src/lib.rs` documentation and metadata. Delete only the exact `/tests` line from `.gitignore`. Retain `/.agents`.

Change:

```json
"test:verification-runner": "node --test scripts/run-verification-tests.test.mjs scripts/verification-docs.test.mjs"
```

- [ ] **Step 5: Verify, search, and commit**

```bash
node --test scripts/verification-docs.test.mjs
pnpm test:verification-runner
cargo test -p dive-e2e test_suite_initialization -- --nocapture
rg -n "COMPLETE — 100% PASS RATE|Complete coverage of all 27 features|All requirement-driven E2E tests verified" TEST_READY.md TEST_INFRA.md tests/e2e/src scripts
git add .gitignore tests/e2e/src/lib.rs TEST_READY.md TEST_INFRA.md scripts/verification-docs.test.mjs package.json
git diff --cached --check
git commit -m "docs: report verification evidence honestly"
```

Expected: tests pass, the search has no matches, and only the six named paths are committed.

---

### Task 4: Run the authoritative gate and record its snapshot

**Files:**
- Modify: `TEST_READY.md`

**Interfaces:**
- Consumes: root `pnpm check` and the canonical verification runner.
- Produces: a dated record tied to an exact commit and worktree state.

- [ ] **Step 1: Capture a stable snapshot**

```bash
git rev-parse --short HEAD
git status --short
ps -axo pid,etime,command | rg '[c]argo|[r]ustc|[p]npm|[v]itest'
```

Record the commit and modified/untracked counts. Wait for concurrent writers before the full gate; do not terminate another process.

- [ ] **Step 2: Run the complete gate**

```bash
pnpm check
```

Expected: formatting, TypeScript, ESLint, Node/Vitest, Vite, Clippy with warnings denied, and all Rust workspace tests execute from the same snapshot. Preserve output and exit code.

- [ ] **Step 3: Run the canonical suite**

```bash
./scripts/run-verification-tests.sh
```

Expected: the runner returns Cargo's status and uses verification terminology.

- [ ] **Step 4: Record observed results**

Append `## Latest local verification` to `TEST_READY.md` with date `2026-09-04`, exact commit, clean/dirty counts, command exit statuses, Cargo passed/failed/ignored totals, Vite warnings, and environmental limits. If anything fails, record the concise failure and retain incomplete statuses. Do not write `ready`, `complete`, or `100%`.

- [ ] **Step 5: Re-run evidence checks and commit**

```bash
pnpm test:verification-runner
cargo fmt --all -- --check
git diff --check
git add TEST_READY.md
git diff --cached --check
git commit -m "docs: record verification snapshot"
git log --oneline --max-count=5
git status --short
```

Expected: documentation checks and formatting pass; the final commit contains only `TEST_READY.md`.
