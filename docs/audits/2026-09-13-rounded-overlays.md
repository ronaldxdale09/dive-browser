# Rounded popup, dialog and dropdown audit — 13 September 2026

All 42 floating surfaces in the source inventory already declare rounded corners. Their native mask discarded that shape: only rectangular bounds crossed IPC, leaving opaque browser-chrome corners over page content.

## Changes

- Carry the computed circular corner radius with overlay bounds; clamp it to the surface dimensions.
- macOS: cut page bounds out of the chrome mask, then union rounded surfaces back into its alpha. Overlapping surfaces use nonzero fill, so their overlap stays visible.
- Windows: subtract page bounds, then union rounded window regions. The existing modal screenshot fallback is retained. Native Windows execution remains unverified.
- Register individual toast cards as overlay surfaces so neither their corners nor the empty space between notifications become a square opaque block.
- Preserve theme corner preferences, full-page layers, and docked panels. Native operating-system menus and file pickers retain platform styling.

## Source inventory

The scan found 52 role/overlay elements. The ten non-floating entries are seven full-page layers (error, private welcome, splash, split cover and three onboarding screens), two lists inside rounded dialogs, and the docked request replay editor.

| Floating surface source | Declared rounding |
| --- | --- |
| `apps/desktop/src/components/AddressSuggestions.tsx:88` | `rounded-xl` |
| `apps/desktop/src/components/AppWindow.tsx:115` | `rounded-xl` |
| `apps/desktop/src/components/AppsDialog.tsx:72` | `rounded-2xl` |
| `apps/desktop/src/components/BookmarkButton.tsx:136` | `rounded-xl` |
| `apps/desktop/src/components/BuildBadge.tsx:83` | `rounded-xl` |
| `apps/desktop/src/components/ChromeFeedback.tsx:15` | `rounded-2xl` |
| `apps/desktop/src/components/ChromeFeedback.tsx:68` | `rounded-xl` |
| `apps/desktop/src/components/Content.tsx:165` | `rounded-2xl` |
| `apps/desktop/src/components/CredentialPromptCard.tsx:36` | `rounded-2xl` |
| `apps/desktop/src/components/DefaultBrowserDialog.tsx:199` | `rounded-2xl` |
| `apps/desktop/src/components/DownloadsMenu.tsx:74` | `rounded-xl` |
| `apps/desktop/src/components/Extensions.tsx:42` | `rounded-2xl` |
| `apps/desktop/src/components/ImportDialog.tsx:29` | `rounded-2xl` |
| `apps/desktop/src/components/InstallAppDialog.tsx:29` | `rounded-2xl` |
| `apps/desktop/src/components/IsolatedPanel.tsx:25` | `rounded-2xl` |
| `apps/desktop/src/components/JsDialogCard.tsx:47` | `rounded-2xl` |
| `apps/desktop/src/components/Library.tsx:57` | `rounded-2xl` |
| `apps/desktop/src/components/MainMenu.tsx:117` | `rounded-2xl` |
| `apps/desktop/src/components/McpDialog.tsx:93` | `rounded-2xl` |
| `apps/desktop/src/components/NavigationButtons.tsx:54` | `rounded-xl` |
| `apps/desktop/src/components/Palette.tsx:151` | `rounded-2xl` |
| `apps/desktop/src/components/PrivateMode.tsx:34` | `rounded-xl` |
| `apps/desktop/src/components/ProfileChip.tsx:66` | `rounded-2xl` |
| `apps/desktop/src/components/ProfileDialog.tsx:52` | `rounded-2xl` |
| `apps/desktop/src/components/ProtectionMenu.tsx:101` | `rounded-2xl` |
| `apps/desktop/src/components/Rail.tsx:410` | `rounded-xl` |
| `apps/desktop/src/components/RailTooltip.tsx:29` | `rounded-md` |
| `apps/desktop/src/components/RecorderModal.tsx:68` | `rounded-2xl` |
| `apps/desktop/src/components/SettingsDialog.tsx:105` | `rounded-2xl` |
| `apps/desktop/src/components/SharePopover.tsx:68` | `rounded-xl` |
| `apps/desktop/src/components/Shortcuts.tsx:80` | `rounded-2xl` |
| `apps/desktop/src/components/Subtitles.tsx:29` | `rounded-2xl` |
| `apps/desktop/src/components/TabDnd.tsx:174` | `rounded-lg` |
| `apps/desktop/src/components/TabStrip.tsx:692` | `rounded-xl` |
| `apps/desktop/src/components/Toolbar.tsx:253` | `rounded-xl` |
| `apps/desktop/src/components/Tooltip.tsx:58` | `rounded-md` |
| `apps/desktop/src/components/UpdateDialog.tsx:53` | `rounded-2xl` |
| `apps/desktop/src/components/WorkspaceDialog.tsx:53` | `rounded-2xl` |
| `apps/desktop/src/components/agent/ModelPicker.tsx:90` | `rounded-xl` |
| `apps/desktop/src/components/record/RecordDialog.tsx:52` | `rounded-2xl` |
| `apps/desktop/src/components/record/RecordingDoneDialog.tsx:45` | `rounded-2xl` |
| `apps/desktop/src/screen/ExportDialog.tsx:98` | `rounded-2xl` |

## Verification

The frontend regression failed before the change and passed afterward. Native path coverage checks transparent corners, opaque centres, coordinate conversion and overlapping surfaces. Final repository and native visual results are recorded below.

Evidence: `target/stabilization-20260912/corner-surface-inventory.json`, `corners-before.log`, `corners-after.log`, and `corners-gate.log`.

- Repository checks passed: 1,276 frontend tests, 658 workspace Rust tests, 31 Python probes, TypeScript, ESLint, formatting, production frontend build and Clippy. The final vendored-runtime step initially failed on a test-only point-type import; correcting that import and rerunning `pnpm test:runtime` passed all 51 tests, including the new native corner/overlap test. One frontend test remains skipped and six Rust tests ignored.
- Native macOS debug bundle rebuilt successfully. A separately named `Dive Corners.app` used disposable data and the mock keychain; the installed application was not replaced.
- Direct native screenshots verified Settings, Apps, Library, command palette, address suggestions, protection, JavaScript alert and Share surfaces over a high-contrast checkerboard page. All showed rounded corners with the page visible outside the curved border. Dialog switching and Escape dismissal worked.
- The macOS main menu and settings select menu opened and dismissed through native accessibility. The app screenshot tool cannot capture the native menu window while it is open, so those menus are not claimed as visually verified. They retain operating-system styling.
- This is complete source coverage of app-owned floating surfaces with representative native visual checks, not a claim that every conditional dialog was triggered. Windows execution and native OS-menu pixel verification remain unperformed.

Verified copied binary SHA-256: `1c51e935cfd0242aff7f715dd634e83418e408b146a1023910d400424271c9c3`.
