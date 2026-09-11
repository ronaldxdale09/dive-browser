# Windows

Dive runs on Windows. This is what the port cost, what is verified, and what
is still missing -- kept as a status rather than a plan, because the parts
that surprised us are the parts worth writing down.

## What cannot be done on a Mac

Nothing Windows can be built here. Two independent blockers, both hard:

- **CEF for Windows is MSVC-built.** `cef-dll-sys` compiles
  `libcef_dll_wrapper` with CMake against MSVC headers and links MSVC import
  libraries. macOS has no MSVC toolchain, and the mingw path cannot consume
  those `.lib` files.
- **So is the crypto.** `aws-lc-sys`, pulled in through reqwest's rustls,
  fails on `#include <windows.h>` for the same reason. Even the four
  CEF-free engine crates (`dive-core`, `dive-cdp`, `dive-mcp`, `dive-agent`)
  cannot be checked for a Windows target from here.

`cargo check --target x86_64-pc-windows-msvc` therefore fails in a build
script before it reaches any of Dive's own code. There is no partial local
signal to work from: the compiler lives on Windows.

Everything else -- writing the code, reviewing it, planning it -- happens
wherever you like.

## Getting a Windows machine

Windows 11 on ARM in a VM on Apple Silicon is the cheapest route that still
lets you *see* the browser, and CEF publishes `windowsarm64` alongside
`windows64`, so it runs natively rather than under emulation.

`scripts/windows/bootstrap.ps1` sets a fresh Windows machine up in one go:
MSVC build tools, Rust, Node, pnpm, CMake, Ninja, the repo, and a persisted
`CEF_PATH`. Run it in an admin PowerShell. CEF itself (~500 MB) is downloaded
by the first build, the same as on macOS.

Ship `windows64`. Test on whichever you have.

## The work, as it turned out

The static estimate below was wrong in an instructive way, so it is worth
recording what actually bit.

A count of `#[cfg(target_os = "macos")]` sites says almost nothing about how
much is broken: a gated function called only from gated code compiles fine.
The first Windows build produced **three** errors, not the 29 a crude count
suggested. The expensive problems were all runtime ones, and none of them
announced themselves.

| What | Where it went wrong | Why it was hard to see |
|---|---|---|
| CEF would not start | `RuntimeStyle::DEFAULT` resolves to Chrome style, which cannot be a child HWND | Access violation inside `libcef.dll`, no message |
| Three stacked title bars | Tauri decorations plus the native menu plus the chrome's own bar | Only visible on screen |
| Window buttons dead | The capability list did not grant `core:window:*`, and the rejection was swallowed | A denied Tauri command rejects silently -- identical to a button that does nothing |
| Dropdowns behind the page | The chrome carries the same z-order pin every webview gets, and the pin vetoes the runtime's own `SetWindowPos` | The mask was punched correctly; the list rendered, just underneath |
| Agent keys never saved | `keyring_core` had no default store on Windows at all | Every save failed; nothing said why |
| Black window, no error | Building with `cargo build` instead of `tauri build` | The webview is created and simply loads nothing |

That last one is worth its own line: **build through the Tauri CLI.** A bare
`cargo build --release` produces a binary that starts, logs a clean startup,
serves MCP, and shows a black window forever. Use `scripts/windows/rebuild.ps1`.

### The overlay mask

On macOS the chrome is one native view raised above the page views with a
`CAShapeLayer` mask punched through it, so the page shows where no overlay is
drawn. On Windows the webviews are sibling child HWNDs, and the equivalent is
a window region: build a region from the window bounds, subtract each hole
with `CombineRgn(RGN_DIFF)`, and the chrome paints and hit-tests only where
an overlay is. Clipping hit-testing as well as painting is the point -- a
click outside an overlay has to reach the page beneath it.

The trap is the z-order pin. Every webview is raised above its siblings when
it is created and then pinned by a `WM_WINDOWPOSCHANGING` subclass that
stamps `SWP_NOZORDER` on every later z-order change, so Chromium's focus
handling cannot reshuffle them. The chrome is a webview too, so it carries
that pin -- and the pin does not distinguish the runtime's own calls from
anyone else's. Raising the chrome for an overlay therefore has to go through
`restack_pinned`, which lifts the pin, moves the window, and re-engages it.
Without the lift the call is dropped on the floor and every menu, dropdown
and suggestion list renders behind the page.

Both masks are built from rectangles, so neither has soft edges.

## Testing from a Mac

`prlctl exec` lands in **session 0** as SYSTEM. That is a different window
station: it can see Dive's processes, but every `MainWindowHandle` reads 0
and anything it launches is invisible. Window-level checks have to run where
the windows are, which is what `scripts/windows/run-in-session.ps1` is for --
it hands a script to the Task Scheduler as the logged-on user.

Other things that cost time and are not obvious:

- The VM allows **one `prlctl exec` session at a time**. A long build in the
  foreground blocks every other call, so builds run detached via the Task
  Scheduler and the log is polled.
- The logged-on user is **not elevated**: a task writing to `C:\` root exits 1
  with no output.
- `$home` is **read-only** in PowerShell. Assigning to it fails without
  stopping the script, so a path built from it silently stays SYSTEM's.
- Piping a native build tool into `Add-Content` can **take the whole script
  down** mid-run, with no error and no further output. Give each step its own
  `cmd` redirect.

## Live subtitles on Windows-on-ARM

`whisper-rs-sys` builds whisper.cpp with CMake, and ggml stops with "MSVC is
not supported for ARM, use clang". It is an ARM problem rather than a Windows
one: the x64 build we would ship compiles with MSVC fine, and this only
appears because the development VM is Windows-on-ARM.

The obvious fix does not work. ggml's test is

    if (MSVC AND NOT CMAKE_C_COMPILER_ID STREQUAL "Clang")

which clang-cl satisfies, but `CMAKE_GENERATOR_TOOLSET=ClangCL` cannot reach
it: the `cmake` crate already passes `-Thost=x64` for Visual Studio
generators and adds a second `-T` for the environment variable, which CMake
rejects. And the Tauri CLI has no `--no-default-features`, so the feature
cannot simply be turned off for one build either.

So the target decides instead. `whisper-rs` is not a dependency at all on
`windows-aarch64`, and `build.rs` emits a `whisper_enabled` cfg only when the
feature is on *and* the target can have it. The eight gates in
`subtitles.rs` follow that cfg rather than the bare feature, and the
`not(...)` fallbacks it already had do the rest. macOS and Windows x64 are
unaffected -- verified by checking the build script still emits
`whisper_enabled` there and that `whisper-rs` is still linked.

## Status

Portable and needing nothing: CEF itself, CDP, the MCP server and its whole
tool surface, the agent, the React chrome, the store.

Ported and working: the overlay mask, window controls and rounded corners,
the frameless title bar, shortcut labels, screen recording (`gdigrab`), the
eyedropper, the credential store, default-browser registration, and web-app
launchers as Start Menu shortcuts.

Building x64 locally needs one thing CI sets for itself: whisper.cpp and
CEF's wrapper must agree on a C++ runtime. `cef-dll-sys` builds the wrapper
with the static one -- CEF's own convention, not configurable from here --
and whisper.cpp defaults to the dynamic one, so the link ends in fifty-odd
duplicate `std::locale` symbols.

    $env:CFLAGS = "/MT"; $env:CXXFLAGS = "/MT"

Not `CMAKE_MSVC_RUNTIME_LIBRARY`, which is the obvious answer and the wrong
one: the `cmake` crate hands CMake the flags the `cc` crate chose, and an
explicit `/MD` among them beats the variable. `cc` appends `CFLAGS` and
`CXXFLAGS` after its own flags, and MSVC honours the last runtime flag it is
given, so that is where it has to go.

The ARM VM never sees any of this, because whisper.cpp is not built there at
all -- which is exactly why it linked a binary CI could not. `cargo clippy`
does not see it either, because clippy never invokes the linker.

Known gaps:

- **Live subtitles are absent on Windows-on-ARM only** (see above). The x64
  build has them.
- **The installer is unsigned.** Without an OV or EV certificate SmartScreen
  warns on first run. WiX is not an option on ARM; the bundle target is NSIS.
- **No CI job yet.** `ci.yml` is parameterised by `matrix.os`, so adding
  `windows-latest` is a small change.
