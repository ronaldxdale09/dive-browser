<p align="center">
  <img src="assets/logo.png" alt="Dive" width="128" />
</p>

<h1 align="center">Dive</h1>

<p align="center">
  <strong>The browser built for developers.</strong><br />
  Chromium, a workspace per project, a developer toolkit that lives next to the page, and an agent that can work in your tabs.
</p>

<p align="center">
  <a href="https://github.com/ronaldxdale09/dive-browser/releases/latest"><img src="https://img.shields.io/badge/Download%20for%20macOS-Apple%20Silicon-0f8f7e?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS" /></a>
  &nbsp;
  <a href="https://github.com/ronaldxdale09/dive-browser/releases/latest"><img src="https://img.shields.io/badge/Download%20for%20Windows-x64-0f8f7e?style=for-the-badge&logo=windows11&logoColor=white" alt="Download for Windows" /></a>
</p>

<p align="center">
  <a href="https://github.com/ronaldxdale09/dive-browser/releases/latest"><img src="https://img.shields.io/github/v/release/ronaldxdale09/dive-browser?style=flat-square&label=Release&color=0f8f7e" alt="Latest release" /></a>
  <a href="https://github.com/ronaldxdale09/dive-browser/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/ronaldxdale09/dive-browser/ci.yml?style=flat-square&label=CI" alt="CI" /></a>
  <a href="https://github.com/ronaldxdale09/dive-browser/releases"><img src="https://img.shields.io/github/downloads/ronaldxdale09/dive-browser/total?style=flat-square&label=Downloads&color=0f8f7e" alt="Downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="MIT" /></a>
  <br />
  <a href="https://bitbucket.org/chromiumembedded/cef"><img src="https://img.shields.io/badge/Chromium-151-4285F4?style=flat-square&logo=googlechrome&logoColor=white" alt="Chromium 151" /></a>
  <a href="https://tauri.app"><img src="https://img.shields.io/badge/Tauri-v2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri v2" /></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-2024-DEA584?style=flat-square&logo=rust&logoColor=black" alt="Rust 2024" /></a>
  <a href="https://react.dev"><img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React 19" /></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 5" /></a>
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-built--in-8A63D2?style=flat-square" alt="MCP built in" /></a>
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS and Windows" />
</p>

<p align="center">
  <img src="assets/screenshots/home-dark.png" alt="The Dive home page with detected dev servers listed and ready to open" width="100%" />
</p>

Dive is a native browser for macOS and Windows, built on the Chromium Embedded Framework, with a Rust core and a React chrome. It is fast, keyboard-first and private by default. The difference is what sits beside the page: network, console, storage and accessibility panels, a device simulator, a screen studio, and an AI agent that can read and operate the tab. Every tab is also reachable by Claude Code, Cursor or any MCP client.

## What you get

- **An agent in the side panel.** It reads the page, clicks, types, inspects requests and reports back. Bring your own key for Anthropic, OpenAI, Google, OpenRouter, Groq, Mistral, DeepSeek or xAI, or run fully local with Ollama or LM Studio.
- **MCP built in.** Claude Code, Cursor and other Model Context Protocol clients can open tabs, read pages, click, type, take screenshots and tail the console and network over localhost, behind a bearer token.
- **A developer dock, not a bolt-on.** Network with request bodies, SSE and WebSocket frames and HAR export. Console, storage, request mocking and rewriting, axe-core accessibility audits, Core Web Vitals, and an OpenAPI spec inferred from the traffic you just watched. Full Chrome DevTools one shortcut away.
- **Device simulator.** Real phone and tablet frames, user agents, pixel ratios, touch, and Offline, Slow 3G and Fast 3G throttling.
- **DivePrivacy.** Ads, trackers and fingerprinting scripts are blocked in the engine's request pipeline, with per-site controls. No extension needed.
- **DiveScreen.** Record any tab as video or GIF, then crop, zoom and add cursor effects to make a clip that looks like a product demo.
- **Workspaces and profiles.** Separate cookies, tabs and mock rules per project, switchable with a keystroke. Profiles keep whole identities apart. Private windows run in their own process.
- **Light on memory.** Idle tabs drop their Chromium process and keep their place; everything restores on click.
- **Sites as apps.** When a page's manifest passes Chrome's install rules, an install button appears beside the address. The tab becomes the app's own window — no tabs, no address bar, the app's icon in the title bar — and a launcher lands in `~/Applications/Dive Apps` for Spotlight and the Dock. Leave the app's scope and a thin bar offers the site back in Dive.

## Screenshots

<table>
  <tr>
    <td colspan="2"><img src="assets/screenshots/hero-dark.png" alt="Dive with the Network dock open on a GitHub repository" /><br /><sub><b>Developer dock</b> with the Network panel open beside the page.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/screenshots/agent.png" alt="Agent panel answering a question about the open repository" /><br /><sub><b>Agent</b> reading the page, here through a local Ollama model.</sub></td>
    <td width="50%"><img src="assets/screenshots/divescreen.png" alt="DiveScreen editor with a zoom region on a recording" /><br /><sub><b>DiveScreen</b> turning a tab recording into a demo.</sub></td>
  </tr>
  <tr>
    <td><img src="assets/screenshots/simulator.png" alt="Device simulator showing an iPhone frame" /><br /><sub><b>Device simulator</b> with real frames and throttling.</sub></td>
    <td><img src="assets/screenshots/privacy.png" alt="DivePrivacy popover on a news site" /><br /><sub><b>DivePrivacy</b> blocking ads and trackers per site.</sub></td>
  </tr>
</table>

## Install

| Platform | |
|---|---|
| macOS 13 or newer, Apple Silicon | [Download the DMG](https://github.com/ronaldxdale09/dive-browser/releases/latest) |
| Windows 10 or newer, x64 | [Download the installer](https://github.com/ronaldxdale09/dive-browser/releases/latest) |

Dive checks for updates and installs them in the background.

macOS builds are signed with an Apple Developer ID certificate and notarized.
Windows builds are being set up for code signing through the
[SignPath Foundation](https://signpath.org/)'s free program for open-source
projects; see [docs/CODE_SIGNING.md](docs/CODE_SIGNING.md) for the policy.
Until that certificate is issued the Windows installer is unsigned, so
SmartScreen warns the first time you run it: choose **More info**, then **Run
anyway**.

## Connect an agent

Dive serves MCP on `127.0.0.1:7391` and requires the token it writes to its data directory.

```bash
claude mcp add --transport http dive http://127.0.0.1:7391/mcp \
  --header "Authorization: Bearer $(cat ~/Library/Application\ Support/app.dive.browser/mcp-token)"
```

On Windows the token is under `%APPDATA%\dive\mcp-token`:

```powershell
claude mcp add --transport http dive http://127.0.0.1:7391/mcp `
  --header "Authorization: Bearer $(Get-Content $env:APPDATA\dive\mcp-token)"
```

Cursor and other clients take the same URL and header. Settings › Developer shows the token path and the current port.

## Build from source

Needs Node 20+, pnpm 10, Rust 1.98+, CMake and Ninja.

```bash
brew install cmake ninja pnpm
git clone https://github.com/ronaldxdale09/dive-browser.git && cd dive-browser
pnpm install
export CEF_PATH="$HOME/.local/share/cef"   # CEF is downloaded here once (~500 MB)
pnpm dev
```

Windows needs the MSVC toolchain and one extra environment variable so
whisper.cpp and CEF agree on a C++ runtime; [docs/WINDOWS.md](docs/WINDOWS.md)
has the setup and the reasoning.

`pnpm check` runs the full gate. Layout, environment knobs and conventions are in [CONTRIBUTING.md](CONTRIBUTING.md); design notes and measurements are under [docs/](docs/README.md).

## License

Dive is [MIT licensed](LICENSE) and redistributes the Chromium Embedded Framework under its BSD-3-Clause license. To report a vulnerability, see [SECURITY.md](SECURITY.md).
