# Agent initialization and disposable credentials

Live CUA on native c3e1fdab6491b1fde7802a4921f0d34984a5d2e96cf99bcc67e5bdaebc555744 found the agent shell remained on Loading throughout its inspection. Source showed unbounded Promise.all over catalog/key discovery and duplicate discovery from the initial Settings effect. Source also exposed a test-isolation gap: DIVE_USE_MOCK_KEYCHAIN reached Chromium but agent::init_keychain still created the native macOS store. This establishes a credential-isolation defect; it does not yet prove the exact source of the observed pending IPC.

## Changes

The existing explicit mock switch now selects keyring-core's process-only in-memory store before any native store creation. Ordinary launches preserve native behavior. Tests assert native initialization is never invoked in mock mode, exercise save/present/list/remove against fresh entries, and verify a new mock store is empty. No credentials are printed or persisted by the fixture.

Frontend initialization coalesces concurrent requests, has a10s deadline, reports errors with a Retry loading agent action, and ignores late timed-out results. Key-refresh generations prevent stale discovery replacing a newer refresh. Sidecar no longer sends a duplicate initial discovery and refreshes when Settings actually closes. Local panel close remains available on initialization errors.

## Validation so far

Three initial frontend regressions failed against the old behavior, then passed. Focused store/Sidecar tests21 pass, full frontend679 pass/one opt-in benchmark skipped, typecheck/ESLint/strict workspace Clippy pass. One Rust credential-store regression passed. Independent source review found no actionable issue.

Exact native binary126e9c7322a0d16eee3580c4d33bc838406c70e5ea402c286b6007eeeebb290c built and CUA verified immediate first-run Connect Model Provider setup, provider switching, close/reopen and normal Quit/helper drain (`target/agent-ui-native.log`). The startup log positively identifies the isolated in-memory test credential store. No keychain interaction occurred. Four supported permission/history/IPC/popout/reattach/exit/restart cycles passed2.18/1.73/2.46/1.64s plus negative incomplete-startup exit1 (`target/lifecycle-probes-1788564211906493000`). Interactive58.90s is session length, not shutdown latency. A frontend timeout does not cancel the underlying OS operation in normal native-keychain mode. OS credential cancellation/error reporting, successful provider networking, streaming/action approvals and broader Task9 remain open.
