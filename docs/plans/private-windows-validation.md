# Private windows and live overlays

Implementation branch: `dale/private-windows`. The candidate is a separate, ad hoc signed macOS arm64 app at `target/release/bundle/macos/Dive Private Preview.app`. It has not been installed over the user's running browser or published.

Private windows use a separate browser process and an in-memory application database. Their CEF request contexts share off-the-record storage with an empty cache path. A private chrome context retains that storage until the last private window closes. Normal profile paths are never accepted as private temporary roots. Private browsing does not conceal activity from websites or networks; deliberate downloads and exports remain on disk. Agents and extensions are disabled.

Private window creation is available in the native File menu, browser menu, command palette, and Shift+Command/Control+N. New Workspace moves to Alt+Shift+Command/Control+N. Private windows have a muted violet palette, persistent shield badge, private welcome screen, and an explanatory information panel.

The macOS overlay fix raises and masks the chrome's native view while keeping web content visible and rendering. It replaces the screenshot-and-hide path on macOS CEF. Overlay geometry is scoped to the invoking chrome window, supports nested surfaces, and refreshes during animation and resize. Other platform runtimes retain the existing screenshot fallback; this work does not establish live overlays on Windows or Linux.

## Native evidence

Final candidate SHA-256: `7c1f4be92a715c19b5f064f1341e76d1db7a3195afa790e568dde78074248fd8`.

- Actual browser menu and Settings modal were opened through native computer use over a local CSS animation and canvas-stream video fixture. Each two-second sample advanced 125 animation frames and approximately 2.1 seconds of video, with document visibility remaining `visible`. Receipts: `target/overlay-native-evidence.json`.
- Native screenshots verified the browser toolbar, page, and popover remained correctly aligned. Escape restored page controls. A coordinate click on the page incremented its counter after dismissal; clicking that same location with the menu open dismissed the menu without incrementing the page counter.
- A tab was detached using the browser menu. Shift+Command+N launched a private child process from that detached window. The private session remained usable after its normal test parent terminated.
- An additional private window showed the private welcome screen, loaded the motion fixture, and displayed its information panel above a continuing video. Native window zoom resized both content and overlay correctly. Closing the extra window preserved the primary private window; closing the last private window ended the process and removed its launch-owned temporary directory.
- `scripts/private-session-check.py` passed normal-seed, private-first, private-fresh, and normal-retained against this exact binary. It verified shared private cookies/localStorage, separation from normal storage, empty native CEF cache paths, no private history/database/log files, survival after primary-window close, and final cleanup. Receipts: `target/private-check-final/results.json`.

## References

- [Chrome Incognito semantics](https://support.google.com/chrome/answer/95464)
- [Brave Private Windows](https://support.brave.com/hc/en-us/articles/360017840332-What-is-a-Private-Window)
- [CEF browser settings and windowed rendering](https://github.com/chromiumembedded/cef/blob/master/include/internal/cef_types.h)
- [CEF crash reporting behavior](https://github.com/chromiumembedded/cef/blob/master/libcef/common/crash_reporting.cc)

## Final gates

- `CEF_PATH=/Users/dvle/.local/share/cef pnpm check`: exit 0. 30 Python tests, 915 frontend tests, and 530 Rust tests passed; the existing one frontend and six Rust skips remain. Type checking, lint, formatting, production frontend build, and Clippy passed. Log: `target/private-final-gate.log`.
- Exact-candidate `scripts/live-check.sh` with `LIVE_MCP_PORT=18748`: exit 0. Native renderer sandboxing, popups, default permission denial, PDF, offline recovery, YouTube playback, tab discard/wake, and four native lifecycle/crash runs passed. CDP p95 was 0.117 ms. Log: `target/private-normal-live-check.log`.
- `codesign --verify --deep --strict` and `git diff --check`: passed.
