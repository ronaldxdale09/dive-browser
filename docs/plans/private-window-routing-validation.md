# Private window routing and exit fixes

Branch: `dale/private-windows`. This builds on the uncommitted private-window and live-overlay implementation. The separate macOS arm64 candidate is `target/release/bundle/macos/Dive Window Fix Preview.app`; it has not replaced `/Applications/Dive.app` or been published.

Candidate executable SHA-256: `37c66045b1080a8648d5e51330a59532b273d9fc168a4a7bb32ea6d9d2af8705`.

## Behavior

- New Window and Command+N always request a normal window. New Private Window and Shift+Command+N retain the private-session boundary. This applies to the native menu, browser menu, command palette, and detached chrome shortcuts.
- The private badge provides separate Open a normal window and Exit Private Mode actions. Exit is also in the browser and native File menus. A failed or pending normal-window request does not disable Exit.
- Exit ends the private process, including its hidden main host and detached windows. Closing one window preserves the other private windows. Command+W closes an empty private home; closing the final attached private tab closes its window.
- A normal-profile file lock prevents two updated normal processes from opening the same database and CEF cache. An authenticated loopback channel accepts window requests. Request IDs make retries idempotent; private callers send no private URLs. If no normal host exists, a new normal process starts with private environment flags removed.
- Repeated private-window requests receive acknowledgements from the existing private process. A closed channel allows a fresh session; a slow ambiguous reply reports an error instead of spawning a duplicate private process.

## Interactive native checks

Performed through macOS accessibility and real keyboard/menu input using disposable profiles. Earlier routing checks used the first candidate of this fix; the final candidate repeated private creation, parent quit, close-one-window, hidden-main exit, normal-window fallback, private Quit, and visual checks after the helper extraction and final error-title adjustment.

| Scenario | Observed result |
| --- | --- |
| Private main browser menu → New Window, normal host running | New non-private window in the normal host; private session retained |
| Private detached window → Command+N | Another normal window; private window unchanged |
| No normal host → private badge Open a normal window | Normal process launched, normal Personal profile and developer home shown |
| Exit private session after fallback normal launch | Private process exited; normal window remained usable |
| Empty private home → Command+W | Process exited successfully |
| Single private tab → Command+W | Final tab and private process closed successfully |
| Normal host → three private-window requests, including two consecutive requests | One private process with main window and two distinct detached windows |
| Quit normal parent with private windows open | Private windows remained usable |
| Close the two detached private windows individually | Remaining private main window stayed open |
| Create another private window from Private Mode | New detached window in the same private process |
| Close private main with detached window open | Main host hidden; detached window remained usable |
| Exit from detached private badge with main hidden | All remaining private windows and the private process closed |
| Final packaged private Command+N with no normal host | Normal process launched; Personal profile, Agent, and normal developer home verified |
| Final packaged private Command+Q after opening normal window | Private process exited successfully; normal process and window remained usable |
| Badge layout in final detached window | Both actions visible, clear violet styling, no clipping at tested window size |

## Automated evidence

- `CEF_PATH=/Users/dvle/.local/share/cef pnpm check`: exit 0, 30 Python tests, 919 frontend tests, and 532 Rust tests passed. Existing skips: one frontend and six Rust tests. Includes type checking, lint, frontend production build, formatting, and Clippy. Log: `target/private-window-fix-gate.log`. The later error-dialog title adjustment compiled in the final build; formatting and diff checks were repeated.
- New regression cases cover an empty private close command, distinct normal/private commands, normal-launch failure with Exit still available, explicit exit, one-owner normal-profile locking, stale endpoint replacement, rejected unauthenticated requests, and idempotent retries.
- Exact-candidate `scripts/private-session-check.py`: all four runs passed (normal-seed, private-first, private-fresh, normal-retained). Verified cookies/localStorage separation and private sharing, empty private native cache paths, no private history/database/log files, hidden-host lifetime, temporary-root cleanup, and retained normal storage. Receipt: `target/private-window-fix-storage/results.json`.
- Deep strict ad hoc signature verification and `git diff --check` passed.
- Exact-candidate `scripts/live-check.sh` with port 18768: exit 0. Renderer sandboxing, popups, default permission denial, PDF, offline recovery, YouTube playback, in-flight tool protection, tab discard/wake, and four lifecycle/crash runs passed. CDP p95 was 0.239 ms. Incomplete startup correctly returned a failure exit status. Log: `target/private-window-fix-live.log`.

## Scope and limits

Native behavior was verified on macOS with updated test binaries. An already-running older DIVE binary has no normal-window broker and must be restarted into the updated build. The candidate does not update an existing running process. Windows and Linux native interaction were not tested.

Private-session reuse is scoped to a normal process and its private child. If that normal process quits, surviving private windows remain usable, but a subsequently launched normal process does not adopt the orphaned private session for its own New Private Window requests. Exit Private Mode ends the selected session; it does not target unrelated browser processes or other separately launched preview builds.
