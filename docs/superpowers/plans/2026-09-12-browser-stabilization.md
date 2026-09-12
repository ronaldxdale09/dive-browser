# Browser stabilization implementation plan

> Execute task-by-task with regression tests and native qualification. The user authorized implementation of the investigation findings and specifically immediate, reliable dialogs/popups.

**Goal:** prevent delayed/hidden chrome overlays, stale UI selection, and avoidable hangs under native/CDP load.

**Architecture:** live native overlays are the normal path on macOS, with live menus and safe modal fallback on Windows. CDP control traffic has bounded failure handling and telemetry yields to native input. Existing profile, discard, security and window ownership semantics remain intact.

**Tech stack:** React/TypeScript/Zustand, Rust/Tokio/Tauri, patched CEF runtime.

**Spec:** `target/audit-20260912/REPORT.md` plus the user's approval in this task.

**Constraints:** preserve the existing generated-bindings comment deletion; no release/push/installation over the user's app; retain profile data and unrelated changes; use Xcode macOS 26.5 SDK for local native builds. Work on branch `dale/browser-stabilization` with existing dependency/build caches. One bounded implementation agent at a time; source file ownership separated from local work.

- [x] Overlay path: add regressions asserting live native dialogs do not call screenshot IPC, nested transitions leave content visible and close clears mask. Use synchronous layout-effect registration, native masks for all live overlays, and immediate solid dialog surfaces. Keep a safe bounded fallback on unsupported runtimes. Test with `vitest run src/lib/overlay.test.ts src/lib/overlay.test.tsx`.
- [x] UI state: retain the audit stale-snapshot regression; route asynchronous snapshots through a generation/version guard, cover workspace/profile transitions and boot/event ordering. Test `browser.test.ts` plus regression.
- [x] Request lifecycle: propagate native CDP acceptance failures without blocking, add a bounded per-tab request supervisor and recovery for failed terminal requests, tests for error/timeout/closed paths.
- [x] Responsiveness: byte-bound inbound protocol work with explicit overload behavior, bound native drain slices, prevent expired queued main-thread commands from executing, avoid disk writes in resize callbacks. Add tests of real helpers and native combined workload qualification.
- [x] Telemetry: batch network/console events before frontend IPC while retaining bounded host history and API compatibility. Verify stream ordering, cap behavior, navigation and close handling.
- [x] Validation/release tooling: share SDK preflight with checks, run vendored runtime tests, full repository gate, build a local bundle and perform native dialogs/popups/video/resize/tab/window tests and memory/lifecycle checks.
- [x] Review all changes and address concrete findings; record measured results and any unsupported-platform limitations.

Qualification details and remaining native-creation/Windows/media limits are recorded in `docs/audits/2026-09-13-browser-stabilization.md`. No installed application, release or commit was changed.
