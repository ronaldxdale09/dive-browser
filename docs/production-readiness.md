# Dive Production-Readiness Ledger

Audit date: 2026-09-04

Branch: `autopilot/dive-build`
Baseline HEAD: `5d619fa` (`feat: enforce DivePrivacy through one request pipeline`)

This ledger distinguishes three kinds of evidence:

- **Source:** the named entry point and its state/error handling were read.
- **Test:** a focused automated test exists at the cited path; this is not a claim that the current dirty tree has passed the full suite.
- **Live:** a private copied `Probe.app` was driven through its MCP server with a fresh data directory and hidden window.

Pre-existing worktree changes are concentrated in recording, DiveScreen, `crates/dive-agent`, configuration, and generated build metadata. They are not owned by this audit and must not be staged by an audit commit.

## Phase A inventory

State vocabulary: **works** means the reachable behavior has direct source plus focused test or live evidence; **partial** means useful behavior exists but a requested state/path lacks proof; **broken** means an exercised path failed; **missing** means no implementation entry point was found.

### Chrome surfaces

| Name | Entry point | User reachability | State | Evidence used | Does the label do what it says? | What happens when it fails? | Keyboard exit? |
|---|---|---|---|---|---|---|---|
| Rail | `apps/desktop/src/components/Rail.tsx:29` | Left edge; collapse/expand buttons | works | Source; `Rail.test.tsx` | Workspace rows activate; controls are labelled | Store errors surface through browser error state | Buttons are tabbable; menus use Escape/focus trap |
| Rail workspace drag | `apps/desktop/src/components/Rail.tsx:149` | Drag workspace row | partial | Source; `Rail.test.tsx` | Reorders immediately | IPC failure is surfaced, but optimistic order has no rollback | Pointer/keyboard DnD attributes exist; failure recovery unproved |
| TabStrip essentials | `apps/desktop/src/components/TabStrip.tsx:73` | Top strip, essentials group | works | Source; `TabStrip.test.ts` | Activates global essential tab | Browser store reports activation failure and rolls back | ARIA tablist and roving tab behavior |
| TabStrip pinned/today/sleeping/detached | `apps/desktop/src/components/TabStrip.tsx:95` | Top strip | works | Source; `TabStrip.test.ts`; live discard/wake | State badges and grouping match tab state | Activation rollback and global error toast | Arrow-key roving and tab close control |
| Tab drag/reorder | `apps/desktop/src/components/TabDnd.tsx:17` | Drag tab or split drop zone | partial | Source; `TabDnd.test.tsx`; `layout.test.ts` | Reorders or creates a split | IPC reorder failure has no local rollback proof | dnd-kit keyboard path exists; Escape cancellation unproved live |
| Tab context menu | `apps/desktop/src/components/TabStrip.tsx:351` | Right-click a tab | partial | Source | Pin, essential, split, detach, close actions are wired | Errors reach global toast through store actions | Role menu present; no focused menu Escape/focus test found |
| Toolbar navigation | `apps/desktop/src/components/Toolbar.tsx:14` | Back, forward, reload/stop | works | Source; `Toolbar.test.tsx`; live navigation | Calls the active tab commands | IPC errors reach global toast | Native chords/menu cover reload/back/forward; buttons tabbable |
| Omnibox | `apps/desktop/src/components/Toolbar.tsx:14` | Address field or Cmd/Ctrl+L | partial | Source; `Toolbar.test.tsx` | Normalizes and navigates entered text | Rejected IPC shows toast, but displayed tab URL is not optimistic/rolled back | Enter submits, Escape restores active URL |
| Bookmark | `apps/desktop/src/components/BookmarkButton.tsx:9` | Star in toolbar | partial | Source | Toggles current URL bookmark | Error is shown; pending affordance/retry proof absent | Tabbable button; no menu to trap |
| Share | `apps/desktop/src/components/SharePopover.tsx:12` | Share toolbar button | partial | Source | Produces LAN URL and QR | Read error is visible; clipboard rejection is silent | Focus trap and Escape wired; restore covered by shared hook test |
| Capture | `apps/desktop/src/store/browser.ts:329` | Camera button or Cmd/Ctrl+Shift+S | works | Source; live screenshot | Captures and opens annotator | IPC error reaches toast | Shortcut and button; annotator closes with Escape |
| Chromium DevTools | `apps/desktop/src/store/browser.ts:314` | Bug button or Cmd/Ctrl+Alt+I | partial | Source; command parity tests | Opens native DevTools for active tab | IPC failure reaches toast | Native menu/chord parity exists; live opening not exercised |
| Device simulator action | `apps/desktop/src/components/DeviceMenu.tsx:12` | Device button / Cmd/Ctrl+Shift+M | works | Source; simulator and emulation tests | Opens picker and applies chosen emulation | Store exposes error state | Picker controls tabbable; close action present |
| Agent action | `apps/desktop/src/components/FeatureBar.tsx:250` | Agent button / Cmd/Ctrl+J | works | Source; `Sidecar.test.tsx`, `Thread.test.tsx` | Opens/closes sidecar | Setup and thread show provider/run failures | Close button and chord available |
| FeatureBar | `apps/desktop/src/components/FeatureBar.tsx:47` | Right of tab strip | works | Source; `FeatureBar.test.tsx` | Shows environment, recording, update, protection, downloads, agent | Child controls expose error/status | Buttons tabbable; child popovers close on Escape |
| Developer dock shell | `apps/desktop/src/components/Dock.tsx:31` | Toolbar or Cmd/Ctrl+Shift+D | works | Source; `Dock.test.tsx` | Switches and persists selected tool panel | Lazy fallback appears while loading | Tab buttons and close button are keyboard reachable |
| Console panel | `apps/desktop/src/components/Dock.tsx:96` | Dock > Console | works | Source; `console.test.ts`, `Dock.test.tsx` | Filters/copies report/clears current tab | Source-link failure reaches global error | Controls tabbable; dock can close by chord/button |
| Network panel and frames | `apps/desktop/src/components/NetworkPanel.tsx:94` | Dock > Network | works | Source; `network.test.ts`, `NetworkPanel.test.tsx` | Shows bounded requests and socket frames | Failed requests retain error text | Rows and replay control keyboard reachable |
| Request replay | `apps/desktop/src/components/ReplayEditor.tsx:27` | Network request replay action | partial | Source; `ReplayEditor.test.ts` | Edits and resends captured request | Error rendered; retry remains available | Close button exists; Escape/focus trapping not proved |
| Storage panel | `apps/desktop/src/components/StoragePanel.tsx:9` | Dock > Storage | partial | Source | Reads cookies/storage for active tab | Error/empty handling exists in component | Dock exit available; focused keyboard tests absent |
| A11y panel | `apps/desktop/src/components/A11yPanel.tsx:16` | Dock > A11y | works | Source; Rust `a11y.rs` tests | Runs and sorts axe violations | Error is rendered in panel | Dock controls keyboard reachable |
| Meta panel | `apps/desktop/src/components/MetaPanel.tsx:8` | Dock > Meta | works | Source; Rust `meta.rs` tests | Parses common page metadata | Empty head is supported; IPC error is rendered | Dock controls keyboard reachable |
| Vitals panel | `apps/desktop/src/components/VitalsPanel.tsx:40` | Dock > Vitals | works | Source; `VitalsPanel.test.ts`, Rust `vitals.rs` tests | Displays rated CWV metrics | Unknown metrics render as unavailable | Dock controls keyboard reachable |
| Rules panel | `apps/desktop/src/components/RulesPanel.tsx:19` | Dock > Rules | works | Source; Rust `rules.rs` tests | Adds/edits bounded request rules | Invalid rules are rejected with errors | Form controls keyboard reachable |
| Dev servers | `apps/desktop/src/components/Welcome.tsx:98` | Welcome screen server list | partial | Source; Rust `devservers.rs` tests | Discovers and opens localhost servers | Empty list is hidden; discovery errors are not user-visible | Buttons keyboard reachable |
| Sidecar shell | `apps/desktop/src/components/Sidecar.tsx:19` | FeatureBar Agent | works | Source; `Sidecar.test.tsx` | Shows chat/setup, clear, settings, close | Loading skeleton and provider errors exist | Close button/chord; panel itself is non-modal |
| Agent Thread | `apps/desktop/src/components/agent/Thread.tsx:50` | Sidecar chat | works | Source; `Thread.test.tsx`, `agent.test.ts` | Sends/stops runs and shows tool/reasoning/approval state | Errors/refusals/cutoffs persist in transcript | Composer and buttons keyboard reachable |
| Agent Setup | `apps/desktop/src/components/agent/Setup.tsx:23` | Sidecar without configured provider | works | Source; `Setup.test.tsx` | Selects provider, validates/saves key, fetches models | Busy and error states are visible | Back and form controls keyboard reachable |
| Palette | `apps/desktop/src/components/Palette.tsx:23` | Cmd/Ctrl+K, Cmd/Ctrl+T, plus buttons | works | Source; `Palette.test.tsx`; command tests | Searches commands, tabs, history and opens input | Search failures degrade to local results/global error | Focus trap, arrows, Enter, Escape, restore tested/shared |
| Library | `apps/desktop/src/components/Library.tsx:18` | Cmd/Ctrl+Y / command | partial | Source; `Library.test.tsx` | Shows bookmark/history tabs and filtering | Empty states exist; load error is collapsed to empty | Focus trap/Escape; large results capped at 200 but not windowed |
| Settings shell | `apps/desktop/src/components/SettingsDialog.tsx:47` | Rail gear / Cmd/Ctrl+, | works | Source; `SettingsDialog.test.tsx` | Opens eight navigable sections | Lazy loading and per-control states exist | Focus trap, tab semantics, Escape/restore tested |
| Settings General | `apps/desktop/src/components/SettingsDialog.tsx:170` | Settings > General | works | Source; prefs tests | Startup, home, search, default zoom persist | Preference save errors reach prefs error/global UI | Native form controls keyboard usable |
| Settings Appearance | `apps/desktop/src/components/SettingsDialog.tsx:264` | Settings > Appearance | works | Source; `prefs.test.ts` | Theme/accent/page theme preferences apply | Save failure rolls preference back | Radio group and switch keyboard semantics |
| Settings Privacy | `apps/desktop/src/components/SettingsDialog.tsx:332` | Settings > Privacy | partial | Source; privacy/rules tests | DNT, blocking, JS, retention, clear data, permissions wired | Clear data reports result; permission list/read/write failures can become silent/optimistic | Controls keyboard usable; retry absent for permission load |
| Settings Downloads | `apps/desktop/src/components/SettingsDialog.tsx:503` | Settings > Downloads | works | Source; prefs tests | Persists destination path | Save failure reaches error | Text input keyboard usable |
| Settings Developer | `apps/desktop/src/components/SettingsDialog.tsx:527` | Settings > Developer | partial | Source | DevTools-on-open, editor, MCP command shown | Clipboard copy failure has no visible error | Controls keyboard usable |
| Settings Agent | `apps/desktop/src/components/SettingsDialog.tsx:583` | Settings > Agent | works | Source; agent/setup tests | Provider/model/effort/step/key controls wired | Loading/model/key errors visible with retry | Form controls keyboard usable |
| Settings Shortcuts | `apps/desktop/src/components/SettingsDialog.tsx:778` | Settings > Shortcuts | works | Source; command and shortcuts tests | Lists canonical chord map | Static view has no async failure | Settings Escape/close applies |
| Settings About/updater | `apps/desktop/src/components/SettingsDialog.tsx:814` | Settings > About | works | Source; `updates.test.ts` | Shows build/runtime and checks/installs update | Pending/current/offered/error/install states visible | Buttons keyboard usable |
| Shortcuts dialog | `apps/desktop/src/components/Shortcuts.tsx:58` | Cmd/Ctrl+/ | works | Source; `Shortcuts.test.tsx` | Groups canonical command chords | Static view | Focus trap and Escape/restore |
| Welcome | `apps/desktop/src/components/Welcome.tsx:23` | First/empty workspace | works | Source; `Welcome.test.tsx` | Starts new tab/agent and shows dev servers/tour | Skeleton for deferred reel; empty dev-server state benign | Buttons and links keyboard reachable |
| Splash | `apps/desktop/src/components/Splash.tsx:19` | Startup | works | Source; `Splash.test.tsx` | Shows branded startup until ready | Browser boot error proceeds to chrome toast | Non-interactive; does not trap user |
| Annotator | `apps/desktop/src/components/Annotator.tsx:28` | After capture | partial | Source | Draws rectangle/arrow/text/blur, undo, copy/save | Capture read/save errors reach store/global error | Dialog/close wired; focused Tab-cycle test not found |
| RecorderModal | `apps/desktop/src/components/RecorderModal.tsx:11` | Stop step recorder | works | Source; `RecorderModal.test.tsx` | Copies/downloads Playwright steps and clears | Clipboard failure handling is present in component | Dialog close/Escape/focus behavior tested/shared |
| Tab recording dialogs/HUD | `apps/desktop/src/components/record/RecordDialog.tsx:14` | Record action / Cmd/Ctrl+Shift+R | partial | Dirty source; recording store tests | Setup, countdown, pause, stop, retry states are implemented | Rejected activate/pause/stop paths remain recoverable in tests | Dialog close and HUD controls exist; current dirty tree not audited to completion |
| Replay editor | `apps/desktop/src/components/ReplayEditor.tsx:27` | Network row action | partial | Source; focused parser test | Resends edited method/URL/headers/body | Inline error and retry button | Explicit close; no Escape/focus proof |
| Downloads menu | `apps/desktop/src/components/DownloadsMenu.tsx:14` | FeatureBar Downloads | works | Source; downloads tests | Shows in-progress/saved/failed and reveals file/folder | Reveal error reaches global toast | Focus trap and Escape/restore via shared hook |
| Protection menu | `apps/desktop/src/components/ProtectionMenu.tsx:17` | FeatureBar Protection | partial | Source; privacy tests | Toggles blocker/DNT/JS and shows blocked count | Preference update failure is not locally visible in popover | Focus trap and Escape/restore via shared hook |
| Workspace dialog | `apps/desktop/src/components/WorkspaceDialog.tsx:13` | New/edit workspace controls | works | Source; workspace tests through browser/Rail | Creates, edits, deletes with validation/confirmation | IPC errors keep dialog open and show toast | Focus trap, Escape, restore via shared hook |
| Workspace chip/menu | `apps/desktop/src/components/WorkspaceChip.tsx:17` | Title bar workspace chip | works | Source; `WorkspaceChip.test.tsx`; browser optimistic tests | Switches workspace and opens create dialog | Activation rolls back on failure | Menu focus/Escape behavior tested/shared |
| Split view | `apps/desktop/src/components/SplitView.tsx:26` | Tab context menu or drag drop zone | works | Source; `layout.test.ts`, `Content.test.tsx` | Shows up to four panes and resizes them | Fifth pane refused; layout stays usable | Pane headers/close buttons keyboard reachable; resize is pointer-only |
| Popout windows | `apps/desktop/src/components/Popout.tsx:17` | Tab context menu > own window | works | Source; `Popout.test.tsx`; engine main-thread patterns | Detached tab gets own toolbar and can reattach | IPC errors surface through local state/global path | Native menu routing and toolbar controls work by keyboard |
| DeviceStage | `apps/desktop/src/components/simulator/DeviceStage.tsx:38` | Device simulator | works | Source; `DeviceStage.test.tsx`, geometry/frame tests | Frames/scales/rotates/captures selected device | Emulation and snapshot errors surface | Tool buttons reachable; leave control provided |
| DiveScreen | `apps/desktop/src/screen/DiveScreen.tsx:20` | Open `dive://screen` recording | partial | Dirty source and performance tests | Non-destructive editor/export UI exists | Pending/error paths are being changed by another session | Keyboard coverage not yet reconciled against dirty work |
| Permission banner | `apps/desktop/src/components/Content.tsx:132` | Page requests a capability | works | Source; browser permission tests | Names capability and offers allow/block | Decision failure retains request and shows toast | Buttons keyboard reachable; banner does not trap focus |
| Crash banner | `apps/desktop/src/components/Content.tsx:89` | Renderer termination | works | Source; browser/Rust crash tests; live renderer kill | Reports recovery attempt and reload action | Exhausted budget remains visible | Reload button keyboard reachable |
| Navigation error page | `apps/desktop/src/components/Content.tsx:185` | Failed main-frame navigation | works | Source; `navError.test.ts`, browser tests | Explains common error and offers retry | Failure remains visible until new navigation | Retry keyboard reachable |
| Toasts | `apps/desktop/src/components/ChromeFeedback.tsx:20` | Async success/error | works | Source; component tests through surfaces | Announces success/error and dismisses | Error persists until dismissed/replaced | Dismiss button keyboard reachable |

### Engine processes

| Name | Entry point | User reachability | State | Evidence used | Does it do what the label says? | What happens when it fails? | Keyboard exit? |
|---|---|---|---|---|---|---|---|
| Tab open/activate/close | `apps/desktop/src-tauri/src/commands.rs:874` | Toolbar, palette, tabs, MCP | works | Source; browser/store tests; live open/activate | Creates, selects and removes native tab views | Typed errors; optimistic activation rolls back | Native chords/menu cover new/close/switch |
| Tab discard/wake | `apps/desktop/src-tauri/src/housekeeping.rs:121` | Automatic; activate sleeping tab | partial | Source; keep-rule tests; one live fail then live pass | Discards eligible idle Today tabs and restores on activation | Close/scroll failures log; harness showed timing flake once | Activation uses normal tab keyboard paths |
| Tab detach/attach | `apps/desktop/src-tauri/src/commands.rs:1936` | Tab context menu / popout button | works | Source; Popout/browser tests | Moves native view between windows through main thread | IPC error surfaced; view ownership retained | Menu and popout button keyboard reachable |
| Session restore | `apps/desktop/src-tauri/src/lib.rs:533` | Launch with restore preference | partial | Source; startup tests | Restores last active non-discarded tab | Corrupt/open failures log and fall back | User can open palette/new tab after launch |
| Housekeeping sweep/keep rules | `apps/desktop/src-tauri/src/housekeeping.rs:102` | Background job | partial | Source; unit tests; mixed live result | Keeps showing/local/recording/agent/audible tabs | Sweep errors are warned, not shown to user | Not interactive |
| Crash recovery | `apps/desktop/src-tauri/src/crash.rs:1` | Automatic on renderer death | works | Source; crash tests; live renderer kill | Deduplicates and retries with budget | Exhaustion emits visible crash state | Retry available in banner |
| Downloads | `apps/desktop/src-tauri/src/engine.rs:1` | Page download link | partial | Source; frontend store tests | Chooses unique path and emits status | Failure emitted to menu/toast | Menu can be closed by Escape |
| Permissions | `apps/desktop/src-tauri/src/permissions.rs:1` | Page request / Settings | works | Source; browser tests | Queues one request and persists decision by origin/kind | Command errors surface; settings management has silent rollback gap | Banner actions keyboard reachable |
| Per-site zoom | `apps/desktop/src-tauri/src/commands.rs:1` | Cmd/Ctrl +/-/0 | partial | Source; zoom tests | Changes active tab zoom | IPC error toast; persisted per-site restore not live-tested | Native menu/chords available |
| Window/content bounds | `apps/desktop/src-tauri/src/commands.rs:1` | Resize window/panels | works | Source; bounds reporter/resize tests | Coalesces bounds and clamps panels | Unchanged rectangles skipped; IPC failures logged | Resize handles expose keyboard semantics where implemented |
| Dev-server discovery | `apps/desktop/src-tauri/src/devservers.rs:1` | Welcome screen/background watch | partial | Source; unit tests | Scans/probes supported local servers | Errors mostly degrade to absent entries | User can ignore/leave Welcome |
| Screencast/tab recording | `apps/desktop/src-tauri/src/screencast.rs:1` | Record action | partial | Dirty source; existing/new tests | Records page/window/audio and exports supported format | Store keeps failed start/pause/stop recoverable | HUD/dialog controls keyboard reachable |
| Screen recording/editor/export | `apps/desktop/src-tauri/src/screen.rs:1` | DiveScreen | partial | Dirty source; focused tests | Reads project/media and streams export | Current concurrent work not yet gated | Dialog controls exist; full keyboard proof pending |
| MCP server | `apps/desktop/src-tauri/src/mcp.rs:1` | Settings command / external client | works | Source; MCP crate tests; live calls | Authenticated loopback server exposes catalog | Structured retryability errors; token file required | External API, not interactive UI |
| MCP tool catalog | `crates/dive-mcp/src/lib.rs:1` | MCP `tools/list` | works | Source; catalog/parity tests; live `tools/list` | Lists and dispatches browser tools | Structured error codes/data | External API |
| Agent runner | `apps/desktop/src-tauri/src/agent.rs:1` | Sidecar send/stop | works | Source; Rust/frontend agent tests | Streams reasoning/text/tools and cancellation | Refusal/error/cutoff stored in thread | Stop button and approvals keyboard reachable |
| Agent tool catalog | `apps/desktop/src-tauri/src/agent_tools.rs:21` | Agent loop | works | Source; dispatch/parity tests | Matches MCP catalog minus documented exclusions | Failures label retryability | Sidecar controls |
| Keychain access | `apps/desktop/src-tauri/src/agent.rs:1` | Agent Setup/Settings | partial | Source; tests for provider validity | Saves/checks/verifies provider keys | Keychain error reaches setup/settings | Forms keyboard reachable |
| Updater | `apps/desktop/src-tauri/src/commands.rs:1` | Delayed boot check / Settings About | works | Source; updater/store tests | No-op when not release-built; checks/installs when configured | Explicit error/install states | Buttons keyboard reachable |
| Logging | `apps/desktop/src-tauri/src/lib.rs:278` | Automatic | works | Source; release docs | Daily rolling logs retained seven days | Stderr fallback if file guard cannot initialize | Not interactive |
| Panic hook | `apps/desktop/src-tauri/src/lib.rs:316` | Automatic | works | Source; release docs | Writes panic report under data-dir crashes | Falls back to previous hook/stderr | Not interactive |
| DB migrations | `crates/dive-core/src/store.rs:1` | Launch/open database | works | Source; append-only migration tests | Applies ordered migrations and version | Returns typed storage error | Startup error reaches chrome/launch logs |
| DB backups | `crates/dive-core/src/store.rs:1` | Before schema migration | works | Source; backup tests; release docs | Copies database once before target version | Migration aborts on backup error | Not interactive |

### Cross-cutting behavior

| Name | Entry point | User reachability | State | Evidence used | Does it do what the label says? | What happens when it fails? | Keyboard exit? |
|---|---|---|---|---|---|---|---|
| Shortcut/native menu parity | `apps/desktop/src/lib/commands.ts:85`; `apps/desktop/src-tauri/src/menu.rs:42` | Keyboard/native menu/palette | partial | Source; `commands.test.ts`, `Shortcuts.test.tsx` | Core chords agree across chrome and menu | Unknown IPC command shows toast | Chords work when page owns focus through native menu; palette parity needs full proof |
| Focus management | `apps/desktop/src/lib/useFocusTrap.ts:1` | Dialogs/popovers | partial | Shared hook tests; surface scan | Shared users focus first, cycle, restore | Surfaces not using hook remain gaps | Escape handled by shared hook/caller where adopted |
| Reduced motion | `apps/desktop/src/lib/useFadeClose.ts:1`; `styles.css:1` | OS preference | works | Hook tests; source class scan | Closes immediately and disables key animations | Falls back to static states | No effect on keyboard exit |
| Contrast/theme | `apps/desktop/src/store/prefs.ts:1`; `styles.css:1` | Settings Appearance | partial | Pref tests/source | Dark/light/system and readable accent foreground apply | Preference failure rolls back | Controls keyboard reachable; formal contrast audit absent |
| Narrow window at 720px | `apps/desktop/src/lib/adaptiveLayout.ts:1` | Resize main window | works | `adaptiveLayout.test.ts`; App source | Collapses rail/toolbar and allows one aux panel | Clamped layout remains usable | All retained controls keyboard reachable |
| Empty states | Multiple component entry points | First run/no data | works | Source scan; component tests | Library/downloads/welcome/panels explain absence | No silent blank surface observed in source | Empty surfaces retain close/navigation controls |
| Loading states | `apps/desktop/src/App.tsx:24`; `ChromeFeedback.tsx:5` | Boot/lazy/async panels | partial | Source/component tests | Skeletons and page load line appear | Some settings reads collapse error to empty | Dialog close available after load; lazy fallback itself non-interactive |
| Error states/offline | `apps/desktop/src/components/Content.tsx:185` | Failed navigation/IPC | works | Nav/load tests; source | Offline/refused navigation becomes dedicated alert/retry | Error retained until retry/new navigation | Retry/button/omnibox available |
| First run | `apps/desktop/src/components/Welcome.tsx:23` | Empty home page | works | Welcome/startup tests | Opens Welcome without configured home | Boot error becomes toast rather than hang | New-tab/agent actions reachable |
| Quit and relaunch | `apps/desktop/src-tauri/src/lib.rs:99`; native app menu | App quit/reopen | partial | Source/release docs | Native quit and restore wiring exist | Relaunch after corrupted state not live-tested | Native Cmd/Ctrl+Q on supported platforms |
| macOS | Tauri config/release workflow | Build/install/run | partial | Source; local private Probe | Debug bundle runs core live check | Signing/notarization requires release secrets and was not verified here | Native menu present |
| Windows | `cfg(target_os = "windows")` sites and CI | Build/install/run | partial | Source/CI configuration only | Platform code paths exist | No current live Windows evidence | Uses Ctrl/Win chord formatting |
| Linux | `cfg(target_os = "linux")` sites and CI | Build/install/run | partial | Source/CI configuration only | X11/Wayland code paths exist | No current live Linux evidence | Uses Ctrl chord formatting |
| Signing/notarization | `.github/workflows/release.yml`; `RELEASING.md` | Tagged release | partial | Source/docs | Workflow defines signing and notarization | Missing secrets block release | Not interactive |
| Updater release channel | `RELEASING.md`; `commands.rs` | Installed release startup/About | partial | Source/tests | Compiled only with public key and consumes `latest.json` | Development build reports updater unavailable safely | Settings remains closable |

## Phase A live baseline

| Attempt | Probe | Result | Measurements / failure |
|---|---|---|---|
| 1 | Copied current `target/debug/dive-desktop`, hidden window, port 17493 | failed | Open/read and screenshot passed; forced sweep did not log a discard within the harness window. Log also contained a macOS sandbox-extension warning and harmless MCP `notifications/initialized` method warnings. |
| 2 | Fresh copied Probe, identical binary and settings, debug log, port 17494 | passed | Open/read, screenshot, discard/wake, renderer-kill recovery and sibling isolation passed. CDP `n=100 p50=0.229 ms p95=0.611 ms max=5.080 ms`. |

The divergent results make the live harness or sweep timing **partial**, not fully reliable. No code fix is proposed until the trigger is isolated with retained candidate/keep evidence.

## Phase B ranked defects

Phase B remains in progress. Only observed, codebase-specific defects belong here.

| Rank | Category | Score (impact x frequency) | Observation | Evidence | Disposition |
|---:|---|---:|---|---|---|
| 1 | Data loss or silent failure | 12 (3x4) | Settings site-permission reads turned any IPC error into an empty list, and writes optimistically removed/changed a row while discarding rejection, so the UI could claim a decision that was not persisted. | Before: `apps/desktop/src/components/SettingsDialog.tsx:421-435`; after: focused tests in `SettingsDialog.test.tsx` | **fixed:** visible load error/retry, write rollback, and pending disable; 436 frontend tests pass |
| 2 | Dead or misleading controls | 12 (3x4) | Omnibox submission waits for IPC and does not optimistically update the active tab URL or roll it back, despite the explicit production-readiness outcome. | `apps/desktop/src/store/browser.ts:271-276`; `apps/desktop/src/components/Toolbar.tsx:14` | focused store test/fix needed |
| 3 | Performance | 9 (3x3) | Library caps results at 200 but mounts the full bookmark/history result set inside a scroll container; the requirement calls for windowing or a screen-sized cap with mounted-row proof. | `apps/desktop/src/components/Library.tsx:13,69,93-207` | focused component test/fix needed |
| 4 | Data loss or silent failure | 9 (3x3) | Optimistic tab and workspace reordering has no rollback when IPC rejects, leaving chrome order divergent from persisted engine order until another event/snapshot. | `apps/desktop/src/store/browser.ts:338-344,370-374` | focused reducer/store tests needed |
| 5 | Missing states | 8 (2x4) | Share-link clipboard rejection is ignored, so the icon can remain unchanged with no explanation or retry state. | `apps/desktop/src/components/SharePopover.tsx:69-74` | focused rejected-clipboard test needed |
| 6 | Accessibility and keyboard | 8 (4x2) | ReplayEditor is a floating interactive editor without `role=dialog`, `useFocusTrap`, overlay coverage, or an Escape handler. | `apps/desktop/src/components/ReplayEditor.tsx:27-91` | focused overlay/focus test needed |
| 7 | Verification integrity | 8 (4x2) | `live-check.sh` inherited `RUST_LOG=warn` while asserting on info-level discard and CDP lines, so working engine behavior was reported as failure. The memory harness had the same marker dependency. | `scripts/live-check.sh:63,87-119`; `scripts/benchmark-memory.sh:49-83`; manual MCP polling observed discard at poll 3 | **fixed:** force `dive_desktop_lib=info`; inherited-warn live check passes, CDP p95 0.868 ms |
| 8 | Verification integrity | 8 (4x2) | The 20-tab memory default depended on public HTTPS sites. A Probe logged TLS `net_error -101`, grew only 15.8 MB, and reported a noise-dominated 28% reclaim. | Before: `scripts/benchmark-memory.sh:13-17,49-102`; after: deterministic `memory-fixture.py` plus harness-only per-tab process model/local-discard override | **fixed:** 20 local tabs grew 2,452,336 KB; discarding 19 reclaimed 2,698,528 KB (110% of growth) |
| 9 | Missing states | 6 (2x3) | Protection toggles fire preference updates without a local pending/error indication; the popover can visually flip and then roll back with only indirect/global feedback. | `apps/desktop/src/components/ProtectionMenu.tsx:64-66`; `apps/desktop/src/store/prefs.ts` | assess after frontend ownership clears |
| 10 | Platform gaps | 5 (5x1) | Windows and Linux are configured but have no current live evidence for native view lifecycle, menus, signing, or updater behavior. | platform `cfg` sites and release workflows; no local runner evidence | deferred: requires Windows/Linux runners |

## Phase C fix log

Completed audit-owned changes so far:

- Site-permission loading and writes are visible and recoverable (`SettingsDialog.tsx`, `SettingsDialog.test.tsx`).
- Live and memory harnesses force their required `dive_desktop_lib` info markers even when the caller exports a stricter `RUST_LOG`.
- The memory harness now defaults to a deterministic 8 MiB/5,000-node local fixture under a harness-only per-tab process model; explicit `STRESS_URL` still profiles real sites.
- Mechanical Rust doc/format corrections clear the committed DivePrivacy clippy/fmt failures; concurrent functional privacy changes remain another session's work.

Current proof: `cargo fmt --all -- --check` pass; `cargo clippy --workspace --all-targets -- -D warnings` pass; `cargo test --workspace` pass (322 tests); `pnpm -r typecheck` pass; `pnpm -r lint` pass; `pnpm -r test` pass (436 tests). Generated bindings currently differ only where Rust documentation changes flow into generated comments, and must be committed with those exact hunks. The debug bundle was produced, then packaging returned exit 1 because concurrent updater configuration supplied a public key without the private signing key; no secret was requested. Live Probe passed after the log-filter fix with CDP p95 0.868 ms. The deterministic 20-tab memory run passed: baseline 1,288,192 KB; loaded 3,740,528 KB; swept 1,042,000 KB; 19 discarded; 2,698,528 KB and 110% of growth reclaimed.

## Phase D final verification

Not yet run. Final results must include full static gates, generated-binding cleanliness, private live check, 20-tab memory reclaim, warm startup, exact commits, and explicit deferrals.
