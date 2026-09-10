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

### The overlay mask is the risk

On macOS the chrome is one native view raised above the page views, with a
`CAShapeLayer` mask punched through it so the page shows where no overlay is
drawn (`update_overlay_mask` in `engine.rs`, `set_chrome_overlay_mask` in the
vendored runtime). That is what lets a menu float over live content, and it
is why modals freeze the page instead: the mask is a rectangle, so a
translucent overlay composites against the chrome's own background rather
than the page.

Windows has no equivalent of that. Page views are child HWNDs and the chrome
is another; there is no layer mask to punch. The plausible approaches are
layered windows (`WS_EX_LAYERED` + `UpdateLayeredWindow`), HWND regions
(`SetWindowRgn`, rectangles only, aliased edges), or DirectComposition. None
is a translation of what macOS does, and the choice affects how menus,
popovers and dialogs look.

**Do this one first, on a spike, before anything else.** If it does not work
the rest of the port is not worth doing, and every other item on the list is
mechanical by comparison.

### Order

1. Spike the overlay mask. Nothing else matters until it is settled.
2. Make it compile: work the 29 sites, most of which are no-ops or small.
3. Boot it: one window, one tab, CDP answering.
4. The mechanical ports: default browser, web apps, screencast arguments.
5. The eyedropper, which is new code rather than a port.
6. CI on `windows-latest` and a signed installer.

## What already works

The parts that took the longest are portable and need nothing: CEF itself,
CDP, the MCP server and its whole tool surface, the agent, the React chrome,
the store. `ci.yml` is already parameterised by `matrix.os`, so adding
`windows-latest` is a one-line change once the code compiles.
