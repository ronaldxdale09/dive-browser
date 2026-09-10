# Windows

Dive is macOS-only today. This is what it would take to change that, in the
order the work actually has to happen, and what is already known rather than
assumed.

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

## The work

42 places name macOS. How many of those are *errors* on Windows cannot be
worked out from here, and it is worth being clear about why: a
`#[cfg(target_os = "macos")] fn` is only a problem if something ungated calls
it, and most of these are gated functions called from gated code, gated
blocks inside shared functions, or gated match arms. All of those compile
fine. The real list comes from the first Windows build.

What a static read *can* say is where the platform-specific work lives, and
two errors are identifiable without a compiler: `engine.rs`'s test module is
not gated but calls a gated `new_tab_chrome_label`, and `normal_window.rs`
calls the gated `open_handed_urls`. Expect a good deal more from missing
types, unavailable Tauri variants and `objc2` imports.

Where the work is:

| Where | macOS sites | What it is | Difficulty |
|---|---:|---|---|
| `engine.rs` | 11 | The native chrome overlay mask, view corner radius, and new-tab shortcut binding for detached windows | **Hard** — see below |
| `lib.rs` | 7 | Dock reopen, `--app=` URL handoff, app lifecycle | Easy: most have no Windows equivalent and become no-ops |
| `default_browser.rs` | 3 | LaunchServices | Medium — Windows makes this deliberately awkward |
| `webapp.rs` | 2 | `.app` bundles for installed web apps | Medium — becomes `.lnk` + Start Menu |
| `agent.rs`, `automation.rs`, `normal_window.rs`, `permission_hidden_view.rs`, `private_session.rs`, `titlebar.rs` | 1 each | Keychain, process spawning, hidden views, title-bar drag regions | Easy to medium |

Plus one that is not a compile error but is missing behaviour:
`eyedropper.rs` already returns "not available on this platform", and Windows
has no equivalent of `NSColorSampler`. A real one means a magnifier overlay
window written from scratch.

### The overlay mask

On macOS the chrome is one native view raised above the page views, with a
`CAShapeLayer` mask punched through it so the page shows where no overlay is
drawn (`update_overlay_mask` in `engine.rs`, `set_chrome_overlay_mask` in the
vendored runtime). That is what lets a menu float over live content.

Windows looked like the risk in this port. It is less of one than expected,
because the vendored runtime already has half of it and Win32 has a close
analogue of the other half:

- **Raising** is done: `raise_to_top` in
  `vendor/tauri-runtime-cef/src/platform/windows/webview.rs` puts a webview
  above its siblings and pins it there with a `WM_WINDOWPOSCHANGING`
  subclass that refuses further z-order changes.
- **Masking** is `SetWindowRgn`. Build a region from the window bounds and
  subtract each hole (`CombineRgn` with `RGN_DIFF`), and the chrome HWND
  paints and hit-tests only where an overlay is. That is the same shape of
  answer as the macOS mask, and the same limitation: both are built from
  rectangles, so neither has soft edges. `SetWindowRgn` clipping hit-testing
  as well as painting is what makes clicks outside an overlay reach the page,
  which is the behaviour the mask exists for.

So the Windows implementation of `set_chrome_overlay_mask(holes, active)` is:
region of the window minus `holes` plus `raise_to_top` when active; a null
region and drop back below the page when not. The `holes` geometry is already
computed platform-independently by `overlay_geometry::uncovered`.

Not proven yet -- it has not been compiled, let alone run -- but it is a
concrete plan against an existing API rather than a choice between three
unknowns. Spike it early anyway: if `SetWindowRgn` on a CEF host window
misbehaves, that is worth finding out before the mechanical work.

`set_corner_radius` has no Windows counterpart either and matters much less;
square corners on a child view are unremarkable there.

### Order

1. Spike the overlay mask. Nothing else matters until it is settled.
2. Make it compile: work the 29 sites, most of which are no-ops or small.
3. Boot it: one window, one tab, CDP answering.
4. The mechanical ports: default browser, web apps, screencast arguments.
5. The eyedropper, which is new code rather than a port.
6. CI on `windows-latest` and a signed installer.

## Live subtitles do not build on Windows-on-ARM

`whisper-rs-sys` builds whisper.cpp with CMake, and ggml's own CMakeLists
stops with "MSVC is not supported for ARM, use clang". It is an ARM problem
rather than a Windows one: the x64 build we would actually ship compiles with
MSVC fine, and this only shows up because the development VM is
Windows-on-ARM.

Live subtitles are an optional cargo feature, so the port builds without
them:

    cargo check -p dive-desktop --no-default-features --features cef

Fixing it properly means pointing whisper's CMake at clang-cl on ARM. That is
its own self-contained job and should not sit in front of the port.

## What already works

The parts that took the longest are portable and need nothing: CEF itself,
CDP, the MCP server and its whole tool surface, the agent, the React chrome,
the store. `ci.yml` is already parameterised by `matrix.os`, so adding
`windows-latest` is a one-line change once the code compiles.
