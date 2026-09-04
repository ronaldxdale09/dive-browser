# Optional panel isolation

Implemented local render/lazy-import error boundaries around the developer dock, agent, extension manager, image annotator, capture editor and recording editor. Navigation and sibling tools remain mounted. Closing/reopening mounts a fresh boundary; a permanently failed lazy import remains honestly unavailable until a fresh application load.

Modal wrappers retain the native-content cover independently of the failed child and while lazy loading. The fallback has an accessible Close button, focus trap and Escape handling. Inline fallbacks preserve focus in other chrome controls. Internal editor Close targets only its own tab; source capture/recording files are not deleted.

## Evidence

- Three boundary regressions cover a healthy modal becoming broken without uncovering its page, keyboard close/release, rejected lazy imports, live siblings, toolbar focus and reopen recovery.
- Two additional tests prove actual capture/recording route containment and exact tab-close targeting. The four existing capture editor/annotation/copy/PDF-export tests remain unchanged and pass. Nine focused tests pass: `/tmp/dive-panels-focused-final.log`.
- Full frontend checkpoint: 672 pass, one opt-in benchmark skipped (`/tmp/dive-panels-full.log`); two new internal isolation tests subsequently passed in the focused run. Typecheck and ESLint pass. Independent source review found no actionable issue.
- Exact native binary `c3e1fdab6491b1fde7802a4921f0d34984a5d2e96cf99bcc67e5bdaebc555744` built successfully. Four supported-permission/history/IPC/popout/reattach/normal-exit cycles passed in 2.09/1.77/2.05/1.71s, with helper drain and incomplete-startup exit1 control: `target/lifecycle-probes-1788563540042715000`.
- CUA on that binary at1200x768 verified extensions above an actual native data page, keyboard Escape dismissal, developer dock layout, simultaneous agent panel, both panel close controls and native content resizing back. Normal Quit/helper drain: `target/panels-ui-native.log`. Interactive session78.39s is not shutdown duration. Every launch used a disposable profile, mock keychain and volatile AppKit ignore-state flag.

## Limits and follow-ups

Native render-failure injection was not performed; failure/cover invariants are component tests, while ordinary native modal/panel layout was inspected live. Async/event-handler failures are not caught by React render boundaries and need explicit workflow handling. The agent body remained Loading during this live session; this is an actionable Task9 investigation, not a passed agent feature check. The separate permission WebUI diagnostic failed because the current native view cannot navigate to Settings; it is not a panel regression and has no migration success claim. Whole Tasks4/9 and production readiness remain open.
