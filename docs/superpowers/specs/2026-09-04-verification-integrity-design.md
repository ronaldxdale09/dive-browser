# Verification Integrity Design

## Purpose

Restore a truthful, repeatable verification baseline before performance, memory-saver, or crash-recovery work continues. The repository must distinguish tests of production behavior from tests of test-only specification models, and no document or runner may describe a result as end-to-end unless it exercised the packaged application or a live CEF browser process.

## Scope

This stage covers the current Rust workspace compilation failure, test-suite naming and reporting, CI gating, and verification documentation. It does not implement the missing R1 startup measurement, R2 memory saver, or R3 crash recovery behavior. Those remain later stages and must be reported as unverified until their production implementations and runtime tests exist.

## Evidence taxonomy

Every verification claim will use one of four labels:

1. **Unit** — exercises one production module in process.
2. **Integration** — exercises multiple production modules or a real protocol boundary, such as the MCP HTTP server over loopback.
3. **Runtime E2E** — launches Dive with CEF and drives observable application behavior.
4. **Benchmark** — measures a live runtime with validated samples and explicit failure thresholds.

Tests implemented entirely with `StartupTimelineModel`, `CrashRecoveryPlan`, `TestRingBufferRegistry`, or similar test-only behavior are specification-model tests. They can document desired semantics but cannot establish that the application implements those semantics.

## Design

### 1. Restore workspace consistency

- Update every `dive_mcp::Browser` test implementation when the trait changes. The immediate missing `close` implementation must behave like the production contract: remove an existing tab and return `TabNotFound` for an unknown id.
- Keep the model-visible agent tool catalog auditable while satisfying the repository's `clippy -D warnings` policy. A focused lint allowance with a reason is acceptable for the catalog; unrelated broad lint suppression is not.
- Remove `/tests` from `.gitignore` because it is a Cargo workspace source directory. Local harness output belongs under `target/` or another already-ignored output directory.
- Preserve all unrelated edits in the dirty working tree.

### 2. Make the suite honest

- Keep the current package path and package name during this stage to avoid a high-churn directory migration in an actively edited checkout.
- Change user-facing names in the crate documentation and runner from “E2E suite” to “verification suite.”
- Identify individual tests as unit, integration, specification-model, or runtime E2E in the verification status document.
- Remove claims that specification-model tests prove production R1–R3 behavior.
- Do not use a total passing-test count as feature coverage. Counts may be reported only alongside the evidence category and the exact command that produced them.

### 3. Authoritative status reporting

- Replace the static `TEST_READY.md` success declaration with a status report generated from fresh command output or manually updated with the exact date, commit/worktree state, commands, and failures.
- Report R1–R4 requirements separately with `verified`, `partially verified`, `unverified`, or `blocked` status and link each verified claim to production-facing evidence.
- Keep `TEST_INFRA.md` as an intended test architecture, but clearly mark runtime harnesses that do not yet exist.
- The runner must propagate Cargo failures and must not print “E2E verified” for an in-process suite.

### 4. CI contract

The existing CI sequence remains the source of truth:

1. `cargo fmt --all -- --check`
2. `cargo clippy --workspace --all-targets -- -D warnings`
3. `cargo test --workspace`
4. generated-binding drift check
5. TypeScript typecheck, lint, tests, and Vite build
6. dependency audits

Stage 1 is complete only when the commands available locally pass from the same working-tree snapshot. Environmental failures, such as unavailable CEF binaries or audit network access, must be reported rather than converted to success.

## Testing strategy

Changes follow red-green-refactor:

- First reproduce the missing `Browser::close` compile failure.
- Add behavior assertions for closing an existing and unknown fake-browser tab, then implement the smallest conforming fake method.
- Add runner-output assertions where practical by extracting reporting decisions into a shell-testable function or by executing the runner against controlled Cargo exit statuses.
- Run documentation consistency searches to ensure no remaining “100% E2E” or “all features verified” claim exists without runtime evidence.
- Finish with the complete repository check, not a collection of selectively passing commands.

## Error handling

- Test compilation or execution failures produce a non-zero runner exit status.
- Missing result data is a failure, never a zero-valued sample or implicit pass.
- Status documentation records incomplete verification explicitly.
- No command may overwrite or stage unrelated user changes.

## Acceptance criteria

- `dive-e2e` compiles after all current `Browser` trait methods are implemented by its fake.
- The verification runner describes what it actually executes and propagates failure.
- `/tests` is no longer ignored.
- `TEST_READY.md` no longer claims full feature or runtime-E2E coverage.
- R1, R2, and R3 gaps from the audit remain visible rather than being represented as passing tests.
- The full local check is executed from one stable snapshot, and its exact result is reported.

## Non-goals

- Implementing the production 30-minute discard policy.
- Adding scroll persistence or sleeping-tab UI.
- Adding native renderer termination handling or webview recreation.
- Repairing startup first-paint measurement or benchmark statistics.
- Large-scale decomposition of `commands.rs` or `dive-mcp/src/lib.rs`.
