# DiveScreen project lifecycle correction

Scope: screen/store.ts, screen/DiveScreen.tsx and two new focused test files only. Source checkpoint ready for root build/review. No native application launch/build or full gate run by this subagent.

Each open/close now has a generation, including reopening the same recording. Async media/project/event results are admitted only while that generation still owns the source. DiveScreen captures its ownership token for cleanup, including load retry, so an older unmount cannot clear a replacement session.

Edits retain immutable project snapshots with revisions. Writes are serialized per source and capture source plus JSON before dispatch. An acknowledgment clears dirty only for the matching active generation and revision. Update/Undo/Redo share one debounce scheduler. Closing an editor queues its dirty snapshot before clearing view state; reopening that source waits for its queued write before reading its sidecar.

Failed writes retain the latest draft in memory until a successful retry. Reopening prefers that draft over stale disk content. A separate saveError renders a recoverable banner and Retry save while leaving preview/editor controls mounted; background save failures name the recording in the app error notice. Failed load/preview behavior remains separate.

## Red/green evidence

- Eight delayed-IPC store regressions failed the original implementation: stale A media load after B; stale project-read failure after B; close before600ms debounce; ordered writes/newer dirty acknowledgment; same-source reopen waiting for close flush; failed-draft reopen/retry; old save failure after another source; old same-source ownership cleanup. `/tmp/dive-screen-lifecycle-red.log`.
- Those eight passed after store implementation. `/tmp/dive-screen-lifecycle-green.log`.
- Two component regressions failed before integration: saveError/retry without losing preview/edits; old component cleanup cannot close replacement session. `/tmp/dive-screen-component-red.log`.
- Final focused run: four files,12 tests PASS, including the two existing Stage/Timeline render-performance checks. `/tmp/dive-screen-lifecycle-all-green.log`.
- Scoped ESLint and complete frontend `tsc --noEmit` pass. Evidence copies are in `target/screen-lifecycle-regression/`.

## Limits and native acceptance

Tab switch/close flush is qualified by controlled IPC, not a whole-process shutdown guarantee. In-memory failed drafts do not survive process termination. Native screen_project_write still uses truncating std::fs::write; crash-safe atomic sidecar replacement remains a separate requirement. Export cancellation and recording discard errors from the earlier audit remain unchanged.

Root native sequence: open synthetic recording, modify padding/text, switch away within600ms, return and verify edits; repeat with two recordings rapidly; Save and reopen after app restart to inspect actual sidecar persistence. Use a controlled disposable write failure to verify preview remains, retry works, and no other recording is marked saved or replaced. Exact native pointer/layout/decode behavior and full gate remain root-owned.

## Reviewer correction: copied sidecar media identity

Reviewer found that remember() keyed drafts by project.media.source, while save/open used state.source. A copied B sidecar naming A therefore lost B's failed draft and could direct export to A. A new delayed-write regression reproduced edit73 reopening as default50 (RED `/tmp/dive-screen-identity-red.log`). Draft keys now use explicit state.source, and opening overlays actual probed media before normalization, so copied sidecar media cannot replace source, playable/event paths, dimensions or duration. Editor settings still migrate normally. The regression also checks all persisted payloads and write targets name B. Final focused run13/13 passes (`/tmp/dive-screen-identity-green.log`), with scoped ESLint, full frontend typechecking and diffcheck clean. Source frozen for root build/re-review.


## Final native identity and save recovery

Run14 exact `fdf8a77c0b37c3e83913d8a261ae65b7c8c69ce78b185d0236a43c50e19609ed` launched an isolated mock profile with a copied sidecar pointing to an old source/playable path. The current Silent recording opened with its saved padding61. Root temporarily renamed only the disposable project file and created a directory at its destination to force a real write error. Computer use changed padding83; the inline save error and Retry appeared while the editor/preview stayed available. A tab round trip retained83 despite the failed write. Root restored the owned destination; Retry cleared the error and showed Saved. The actual written sidecar has padding83, source matching the current recording, and probed640x360geometry. Evidence `target/screen-ui-14/retry-evidence.json`, saved sidecar and CUA screenshots.

A subsequent MP4 export exposed a separate native decoder failure: Stage reported its preview decode error, unmounted the editor/export UI, and no edited output file appeared. There was no asset-scope denial in this run. Decoder reopen/resource lifetime and exporter cleanup remain unresolved; this is not a fully verified editor/export workflow. Normal Quit and helper drain passed540.68seconds (session duration).

Final prelaunch `pnpm check` passed718frontend tests (one optional benchmark skipped),451Rust tests (four opt-in real-media tests separately passed),19Python harness tests, formatting, typecheck, lint, Vite and strict Clippy. Evidence `/tmp/dive-screen-routing-final-check.log`; exact release build `/tmp/dive-screen-routing-final-build.log`.
