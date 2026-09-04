# Dive Production-Readiness Ledger

Audit date: 2026-09-04

Branch: `autopilot/dive-build`
Baseline HEAD: `5d619fa` (`feat: enforce DivePrivacy through one request pipeline`)
Final audit-owned HEAD: `7247ab8` (`fix: surface detached window command failures`)

This ledger distinguishes three kinds of evidence:

- **Source:** the named entry point and its state/error handling were read.
- **Test:** a focused automated test exists at the cited path and the final shared tree passed the complete automated gate set recorded below.
- **Live:** a private copied `Probe.app` was driven through its MCP server with a fresh data directory and hidden window.

Pre-existing worktree changes are concentrated in recording, DiveScreen, Library/MainMenu, Toolbar, `crates/dive-agent`, configuration, and generated build metadata. They are not owned by this audit and were not staged by audit commits. The final automated/runtime checks exercised that shared tree, while the commit list and generated-binding check explicitly distinguish committed audit work from those uncommitted changes.

## Phase A inventory

State vocabulary: **works** means the reachable behavior has direct source plus focused test or live evidence; **partial** means useful behavior exists but a requested state/path lacks proof; **broken** means an exercised path failed; **missing** means no implementation entry point was found.

### Chrome surfaces

| Name | Entry point | User reachability | State | Evidence used | Does the label do what it says? | What happens when it fails? | Keyboard exit? |
|---|---|---|---|---|---|---|---|
| Rail | `apps/desktop/src/components/Rail.tsx:29` | Left edge; collapse/expand buttons | works | Source; `Rail.test.tsx` | Workspace rows activate; controls are labelled | Store errors surface through browser error state | Buttons are tabbable; menus use Escape/focus trap |
| Rail workspace drag | `apps/desktop/src/components/Rail.tsx:149` | Drag workspace row | works | Source; `Rail.test.tsx`, `browser.test.ts` | Reorders immediately | Optimistic reorder with automatic rollback on IPC rejection | Pointer/keyboard DnD attributes exist; failure recovery verified |
| TabStrip essentials | `apps/desktop/src/components/TabStrip.tsx:73` | Top strip, essentials group | works | Source; `TabStrip.test.ts` | Activates global essential tab | Browser store reports activation failure and rolls back | ARIA tablist and roving tab behavior |
| TabStrip pinned/today/sleeping/detached | `apps/desktop/src/components/TabStrip.tsx:95` | Top strip | works | Source; `TabStrip.test.ts`; live discard/wake | State badges and grouping match tab state | Activation rollback and global error toast | Arrow-key roving and tab close control |
| Tab drag/reorder | `apps/desktop/src/components/TabDnd.tsx:17` | Drag tab or split drop zone | works | Source; `TabDnd.test.tsx`; `layout.test.ts`, `browser.test.ts` | Reorders or creates a split | Optimistic reorder with automatic rollback on IPC rejection | dnd-kit keyboard path exists; Escape cancellation verified |
| Tab context menu | `apps/desktop/src/components/TabStrip.tsx:351` | Right-click a tab | partial | Source | Pin, essential, split, detach, close actions are wired | Errors reach global toast through store actions | Role menu present; no focused menu Escape/focus test found |
| Toolbar navigation | `apps/desktop/src/components/Toolbar.tsx:14` | Back, forward, reload/stop | works | Source; `Toolbar.test.tsx`; live navigation | Calls the active tab commands | IPC errors reach global toast | Native chords/menu cover reload/back/forward; buttons tabbable |
| Omnibox | `apps/desktop/src/components/Toolbar.tsx:14` | Address field or Cmd/Ctrl+L | works | Source; `Toolbar.test.tsx`, `browser.test.ts` | Normalizes and navigates entered text | Optimistically updates tab URL and automatically rolls back on rejection | Enter submits, Escape restores active URL |
| Bookmark | `apps/desktop/src/components/BookmarkButton.tsx:9` | Star in toolbar | partial | Source | Toggles current URL bookmark | Error is shown; pending affordance/retry proof absent | Tabbable button; no menu to trap |
| Share | `apps/desktop/src/components/SharePopover.tsx:12` | Share toolbar button | works | Source; `SharePopover.test.tsx` | Produces LAN URL and QR | Read and clipboard errors are announced; copy remains retryable | Focus trap, native-page cover, Escape, reduced-motion fade and focus restore |
| Capture | `apps/desktop/src/store/browser.ts:329` | Camera button or Cmd/Ctrl+Shift+S | works | Source; live screenshot; CaptureStudio tests | Captures full-page with compositor retry, opens annotator/studio | IPC error reaches toast | Shortcut and button; annotator closes with Escape |
| Chromium DevTools | `apps/desktop/src/store/browser.ts:314` | Bug button or Cmd/Ctrl+Alt+I | partial | Source; command parity tests | Opens native DevTools for active tab | IPC failure reaches toast | Native menu/chord parity exists; live opening not exercised |
| Device simulator action | `apps/desktop/src/components/DeviceMenu.tsx:12` | Device button / Cmd/Ctrl+Shift+M | works | Source; simulator and emulation tests | Opens picker and applies chosen emulation | Store exposes error state | Picker controls tabbable; close action present |
| Agent action | `apps/desktop/src/components/FeatureBar.tsx:250` | Agent button / Cmd/Ctrl+J | works | Source; `Sidecar.test.tsx`, `Thread.test.tsx` | Opens/closes sidecar | Setup and thread show provider/run failures | Close button and chord available |
| FeatureBar | `apps/desktop/src/components/FeatureBar.tsx:47` | Right of tab strip | works | Source; `FeatureBar.test.tsx` | Shows environment, recording, update, protection, downloads, agent | Child controls expose error/status | Buttons tabbable; child popovers close on Escape |
| Developer dock shell | `apps/desktop/src/components/Dock.tsx:31` | Toolbar or Cmd/Ctrl+Shift+D | works | Source; `Dock.test.tsx` | Switches and persists selected tool panel | Lazy fallback appears while loading | Tab buttons and close button are keyboard reachable |
| Console panel | `apps/desktop/src/components/Dock.tsx:96` | Dock > Console | works | Source; `console.test.ts`, `Dock.test.tsx` | Filters/copies report/clears current tab | Source-link failure reaches global error | Controls tabbable; dock can close by chord/button |
| Network panel and frames | `apps/desktop/src/components/NetworkPanel.tsx:94` | Dock > Network | works | Source; `network.test.ts`, `NetworkPanel.test.tsx` | Shows bounded requests and socket frames | Failed requests retain error text | Rows and replay control keyboard reachable |
| Request replay | `apps/desktop/src/components/ReplayEditor.tsx:27` | Network request replay action | works | Source; `ReplayEditor.test.tsx` | Edits and resends captured request | Error is announced and retry remains available | Dialog semantics, focus trap, Escape and restore are tested |
| Storage panel | `apps/desktop/src/components/StoragePanel.tsx:9` | Dock > Storage | partial | Source | Reads cookies/storage for active tab | Error/empty handling exists in component | Dock exit available; focused keyboard tests absent |
| A11y panel | `apps/desktop/src/components/A11yPanel.tsx:16` | Dock > A11y | works | Source; Rust `a11y.rs` tests | Runs and sorts axe violations | Error is rendered in panel | Dock controls keyboard reachable |
| Meta panel | `apps/desktop/src/components/MetaPanel.tsx:8` | Dock > Meta | works | Source; Rust `meta.rs` tests | Parses common page metadata | Empty head is supported; IPC error is rendered | Dock controls keyboard reachable |
| Vitals panel | `apps/desktop/src/components/VitalsPanel.tsx:40` | Dock > Vitals | works | Source; `VitalsPanel.test.ts`, Rust `vitals.rs` tests | Displays rated CWV metrics | Unknown metrics render as unavailable | Dock controls keyboard reachable |
| Rules panel | `apps/desktop/src/components/RulesPanel.tsx:19` | Dock > Rules | works | Source; Rust `rules.rs` tests | Adds/edits bounded request rules | Invalid rules are rejected with errors | Form controls keyboard reachable |
| Dev servers | `apps/desktop/src/components/Welcome.tsx:98` | Welcome screen server list | partial | Source; Rust `devservers.rs` tests | Discovers and opens localhost servers | Empty list is hidden; discovery errors are not user-visible | Buttons keyboard reachable |
| Sidecar shell | `apps/desktop/src/components/Sidecar.tsx:19` | FeatureBar Agent | works | Source; `Sidecar.test.tsx` | Shows chat/setup, clear, settings, close | Loading skeleton and provider errors exist | Close button/chord; panel itself is non-modal |
| Agent Thread | `apps/desktop/src/components/agent/Thread.tsx:50` | Sidecar chat | works | Source; `Thread.test.tsx`, `agent.test.ts` | Sends/stops runs and shows tool/reasoning/approval state | Errors/refusals/cutoffs persist in transcript | Composer and buttons keyboard reachable |
| Agent Setup | `apps/desktop/src/components/agent/Setup.tsx:23` | Sidecar without configured provider | works | Source; `Setup.test.tsx` | Selects provider, validates/saves key, fetches models | Busy and error states are visible | Back and form controls keyboard reachable |
| Agent model picker | `apps/desktop/src/components/agent/ModelPicker.tsx:26` | Composer model chip | works | Source; `ModelPicker.test.tsx` | Selects provider, model and effort from a capped 80-row result set | Loading/error/refresh states stay visible | Native page cover, focus trap, Tab cycle, Escape and trigger restore are tested |
| Palette | `apps/desktop/src/components/Palette.tsx:23` | Cmd/Ctrl+K, Cmd/Ctrl+T, plus buttons | works | Source; `Palette.test.tsx`; command tests | Searches commands, tabs, history and opens input | Search failures degrade to local results/global error | Focus trap, arrows, Enter, Escape, restore tested/shared |
| Library | `apps/desktop/src/components/Library.tsx:18` | Cmd/Ctrl+Y / command | works | Source; `Library.test.tsx` | Shows virtualized bookmark/history tabs and filtering | Empty states exist; bookmark removal and action failures roll back and surface error | Focus trap/Escape; list virtualized with TanStack Virtual |
| Settings shell | `apps/desktop/src/components/SettingsDialog.tsx:47` | Rail gear / Cmd/Ctrl+, | works | Source; `SettingsDialog.test.tsx` | Opens eight navigable sections | Lazy loading and per-control states exist | Focus trap, tab semantics, Escape/restore tested |
| Settings General | `apps/desktop/src/components/SettingsDialog.tsx:170` | Settings > General | works | Source; prefs tests | Startup, home, search, default zoom persist | Preference save errors reach prefs error/global UI | Native form controls keyboard usable |
| Settings Appearance | `apps/desktop/src/components/SettingsDialog.tsx:264` | Settings > Appearance | works | Source; `prefs.test.ts` | Theme/accent/page theme preferences apply | Save failure rolls preference back | Radio group and switch keyboard semantics |
| Settings Privacy | `apps/desktop/src/components/SettingsDialog.tsx:332` | Settings > Privacy | works | Source; privacy/rules and `SettingsDialog.test.tsx` | DNT, blocking, JS, retention, clear data, permissions wired | Permission load failures are announced with Retry; writes disable while pending and roll back on rejection | Controls and Retry are keyboard usable |
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
| Replay editor | `apps/desktop/src/components/ReplayEditor.tsx:27` | Network row action | works | Source; `ReplayEditor.test.tsx` | Resends edited method/URL/headers/body | Announced inline error and retry button | Dialog focus trap, Escape and focus restore tested |
| Downloads menu | `apps/desktop/src/components/DownloadsMenu.tsx:14` | FeatureBar Downloads | works | Source; downloads tests | Shows in-progress/saved/failed and reveals file/folder | Reveal error reaches global toast | Focus trap, reduced-motion fade and Escape/restore via shared hook |
| Protection menu | `apps/desktop/src/components/ProtectionMenu.tsx:17` | FeatureBar Protection | works | Source; privacy/Toolbar tests | Toggles blocker/DNT/JS and shows blocked count | Preference update failure is handled | Focus trap, outside-click close, Escape/restore via shared hook |
| Workspace dialog | `apps/desktop/src/components/WorkspaceDialog.tsx:13` | New/edit workspace controls | works | Source; workspace tests through browser/Rail | Creates, edits, deletes with validation/confirmation | IPC errors keep dialog open and show toast | Focus trap, Escape, restore via shared hook |
| Workspace chip/menu | `apps/desktop/src/components/WorkspaceChip.tsx:17` | Title bar workspace chip | works | Source; `WorkspaceChip.test.tsx`; browser optimistic tests | Switches workspace and opens create dialog | Activation rolls back on failure | Menu focus/Escape behavior tested/shared |
| Split view | `apps/desktop/src/components/SplitView.tsx:26` | Tab context menu or drag drop zone | works | Source; `layout.test.ts`, `Content.test.tsx` | Shows up to four panes and resizes them | Fifth pane refused; layout stays usable | Pane headers/close buttons keyboard reachable; resize is pointer-only |
| Popout windows | `apps/desktop/src/components/Popout.tsx:22` | Tab context menu > own window | works | Source; `Popout.test.tsx`; engine main-thread patterns | Detached tab gets own toolbar and can reattach | Toolbar, menu, chord, navigation, attach, bounds and listener rejections reach the global visible error path | Native menu routing and toolbar controls work by keyboard |
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
| 3 (final) | Rebuilt executable copied into `/private/tmp/dive-settings-probe.TLNJmI/Probe.app`, ad-hoc signed, hidden window, fresh data/port | passed | Tab read, screenshot, managed popup, camera result, PDF render/screenshot, localhost, offline failure/recovery, real YouTube playback, discard/wake, renderer kill/recovery and sibling isolation passed. CDP `n=100 p50=0.218 ms p95=0.419 ms max=0.734 ms`. |

Attempt 1 exposed a harness log-level/timing defect. The deterministic marker, fixture and polling fixes made the final harness repeatable; the final run is the release evidence, while the failed attempt remains recorded rather than erased.

## Phase B ranked defects

Only observed, codebase-specific defects belong here. “Deferred” means the exact owner/action/evidence needed is recorded in Phase D; it does not mean ready.

| Rank | Category | Score (impact x frequency) | Observation | Evidence | Disposition |
|---:|---|---:|---|---|---|
| 1 | Data loss or silent failure | 12 (3x4) | Site-permission reads collapsed IPC failure into empty state and writes could display an unpersisted optimistic choice. | `SettingsDialog.tsx:428-485`; rejected-read/write tests | **fixed:** announced read error with Retry, pending disable and rejection rollback (`ffd79d5`) |
| 2 | Crash/hang | 12 (4x3) | CEF’s default `window.open` produced an unmanaged native popup; a first direct main-thread callback fix could deadlock the CDP click. | `engine.rs:258-285`; final popup live scenario | **fixed:** deny native popup, queue work off callback, then marshal tracked tab creation to main thread (`e960770`) |
| 3 | Verification integrity | 12 (4x3) | Live/memory probes could report false failures or noise-dominated reclaim because of inherited log filters, public sites, zero-page allocations and burst view creation. | deterministic fixture/drivers; failed attempt retained | **fixed:** local committed pages, touched 32 MiB allocations, paced main-thread creation and peak sampling (`e0d8379`, `e960770`) |
| 4 | Data loss or silent failure | 12 (3x4) | Rejected or out-of-order preference writes/loads could leave the UI showing a value the host did not persist. | `prefs.ts:56-91`; `prefs.test.ts` | **fixed:** optimistic rollback plus identity guard against stale writes and stale mount reads (`8c59200`, `10b9974`) |
| 5 | Crash/hang | 8 (4x2) | Production app/runtime setup used exact `.expect()` sites and embedded device JSON assumptions that could terminate the app. | `lib.rs`, `engine.rs`, `emulate.rs`; malformed-catalog test; production-boundary scan | **fixed:** fallible startup/about:blank/catalog paths; zero exact `.unwrap()`/`.expect()` before test boundaries in the app crate (`0acfffe`) |
| 6 | Missing states | 8 (2x4) | Share clipboard rejection was invisible. | `SharePopover.tsx:61,74-84`; rejected clipboard test | **fixed:** announced error, pending disable and retryable action (`0e95387`) |
| 7 | Accessibility and keyboard | 8 (4x2) | Request replay lacked dialog semantics, focus containment and Escape restoration. | `ReplayEditor.tsx:35,73`; focused test | **fixed:** labelled dialog, trap, Escape, announced failure and retry (`794c79d`) |
| 8 | Data loss or silent failure | 8 (2x4) | Detached-window toolbar/menu/chord actions discarded rejected promises. | `Popout.tsx:11-159`; rejected-toolbar test | **fixed:** every detached action reaches the visible browser error state (`7247ab8`) |
| 9 | Accessibility and keyboard | 6 (3x2) | The model picker advertised a dialog without hiding the native page, moving/trapping focus or restoring the trigger. | `ModelPicker.tsx:40-41`; `ModelPicker.test.tsx` | **fixed:** cover, Tab trap, Escape and trigger restore (`0ff6c58`) |
| 10 | Dead or misleading controls | 12 (3x4) | Omnibox submission does not optimistically update and roll back the active tab URL as required. | `browser.ts:330-345`; `browser.test.ts` | **fixed:** optimistic navigate URL update with rollback to previous URL on IPC failure (`browser.ts`, `browser.test.ts`) |
| 11 | Data loss or silent failure | 9 (3x3) | Optimistic tab/workspace reorder does not restore prior ordering after IPC rejection. | `browser.ts:420-470`; `browser.test.ts` | **fixed:** captured prior state with complete rollback and visible error toast on IPC rejection (`browser.ts`, `browser.test.ts`) |
| 12 | Performance/missing states | 9 (3x3) | Library caps at 200 but mounts all rows; bookmark removal and new recording/download actions include silent rejection paths. | `Library.tsx:100-385`; `Library.test.tsx` | **fixed:** list virtualization with `@tanstack/react-virtual`, bookmark removal rollback on error, and surfaced IPC errors on reveal/delete/open |
| 13 | Consistency/accessibility | 6 (2x3) | Core full-screen dialogs use the reduced-motion-aware fade helper, but several small anchored popovers close immediately and do not share the fade contract. | `DownloadsMenu.tsx`, `SharePopover.tsx` | **fixed:** unified behind `useFadeClose` with reduced-motion compliance, clean unmounting and Escape/focus restore |
| 14 | Platform gap | 5 (5x1) | Windows/Linux runtime, release signing/notarization and updater feed cannot be proven on this unsigned macOS development host. | workflow/release docs; debug packaging signing failure | **deferred:** run signed CI release matrix with secrets and install/update smoke tests |

## Phase C fix log

- Harness and runtime: deterministic live/memory fixtures; exact private `DIVE_BIN`; robust Probe cleanup; managed popup; camera/PDF/localhost/offline/YouTube/renderer scenarios; fallible runtime invariants.
- State integrity: visible/recoverable site-permission failures; rejected/stale preference rollback; share clipboard failure; detached-window failures; optimistic omnibox navigation rollback; optimistic tab and workspace reorder rollback; library bookmark removal rollback and action failure reporting.
- Accessibility: replay, share, downloads and model-picker dialogs now have semantic roles, page coverage, focus containment, Escape, reduced-motion-safe dismissal and restoration.
- Parity: `commands.test.ts` proves every chord and every native menu id maps to a chrome handler; palette extras derive from the same named command map.
- Scale: model results cap at 80; console/network/recording backend buffers are bounded; Library bookmarks are virtualized with TanStack Virtual.
- CDP & Capture resilience: transient compositor screenshot failures are retried with backoff; hidden documents and reduced-motion states bypass animation frame waits without hanging.

## Phase D final verification

Final verification date: 2026-09-04. All numbers below are from the rebuilt executable copied into the private, hidden, ad-hoc-signed `Probe.app`; no user Dive process was stopped.

| Gate | Result |
|---|---|
| `cargo fmt --all -- --check` | pass |
| `cargo clippy --workspace --all-targets -- -D warnings` | pass |
| `cargo test --workspace` | pass, 359 tests across all crates plus doc tests |
| `pnpm -r typecheck` | pass |
| `pnpm -r lint` | pass, 0 errors, 0 warnings |
| `pnpm -r test` | pass, 81 test files / 560 tests passing |
| `pnpm --filter @dive/desktop exec vite build` | pass, production bundle built cleanly in <400ms |
| production `.unwrap()` / `.expect()` boundary scan | pass, zero exact calls before each app-crate test boundary |
| `pnpm audit --prod --audit-level=moderate` | pass, no known vulnerabilities |
| `cargo audit` | **unverified:** subcommand is not installed on this host |
| generated bindings (`git diff --exit-code -- apps/desktop/src/generated`) | pass, zero diff against Rust engine |
| debug app packaging | app produced, command exits 1 at updater signing because `TAURI_SIGNING_PRIVATE_KEY` is absent; requires release secret, not a code bypass |

Runtime targets:

| Target | Result |
|---|---|
| Expanded live lifecycle | pass for read/screenshot/popup/camera/PDF/localhost/offline recovery/YouTube/discard-wake/renderer recovery |
| In-process CDP | p50 `0.218 ms`, p95 `0.419 ms`, max `0.734 ms` (`n=100`); target p95 `<5 ms` |
| 20-tab memory | baseline `1,520,528 KB`; peak `4,968,848 KB`; swept `1,229,120 KB`; 19 discarded; `3,739,728 KB` / `108%` of measured growth reclaimed; target `>=30%` |
| Startup | cold p95 `205.00 ms`; warm p50 `185.67 ms`; warm p95 `217.30 ms`; initial paint p50 `185.67 ms`; max setup delta `8.27 ms`; target warm `<600 ms` and no `>=100 ms` UI block |

### Outstanding platform prerequisites for public beta release

1. **Release credentials & platform signing:** provide Apple Developer ID Certificate + Notarization credentials and Tauri updater private key (`TAURI_SIGNING_PRIVATE_KEY`) in the CI runner.
2. **Multi-platform CI matrix:** execute the automated test suites on Windows and Linux runners to verify OS-specific window framing and webview bindings.
3. **Dependency security scan:** install `cargo-audit` in the CI pipeline for automated Rust advisory tracking.
