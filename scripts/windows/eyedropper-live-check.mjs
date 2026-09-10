// Node 22+. Proves the Windows eyedropper end to end, against a pixel whose
// colour is known because this script painted it.
//
// The macOS sampler needs a real pointer and is checked by hand. The Windows
// one is a poll of the cursor and the desktop device context, which a script
// *can* drive: paint the screen a known colour, click it, and see whether the
// hex that comes back is the one that was painted. Anything less -- asserting
// it returns some hex, or comparing it to GetPixel -- would pass just as well
// with the sampler reading the wrong pixel entirely.
//
//   DIVE_CHROMIUM_FLAGS=remote-debugging-port=9343 <Dive binary>
//   node scripts/windows/eyedropper-live-check.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = process.env.DIVE_CHECK_CDP_PORT || "9343";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
// The swatch the unit test uses, so a failure reads the same in both places.
const SWATCH = { hex: "#123456", r: 18, g: 52, b: 86 };

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ui = targets.find((t) => t.url === "http://tauri.localhost/");
  assert(ui, `Dive chrome target missing on ${port}`);
  const ws = new WebSocket(ui.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p(m); }
  };
  return (expression, ms = 60_000) => new Promise((res, rej) => {
    const i = ++id;
    const timer = setTimeout(() => { pending.delete(i); rej(Error("CDP timed out")); }, ms);
    pending.set(i, (m) => { clearTimeout(timer); res(m); });
    ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}

/// Cover the screen in the swatch, click the middle of it, and go away.
///
/// Borderless and topmost so nothing of Dive's own interface is left under
/// the cursor: the point is to know what colour is at the pixel that gets
/// clicked.
///
/// Synchronous, and deliberately so. The eyedropper is already waiting on
/// another thread, and blocking this one costs nothing but makes a failure
/// here visible -- a detached child that never ran looked exactly like a
/// sampler that never saw the click.
function paintAndClick() {
  const script = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;using System.Runtime.InteropServices;
public class C {
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,IntPtr e);
}
"@
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = "None"
$f.WindowState = "Maximized"
$f.TopMost = $true
$f.BackColor = [System.Drawing.Color]::FromArgb(${SWATCH.r}, ${SWATCH.g}, ${SWATCH.b})
$f.Show(); $f.Refresh()
Start-Sleep -Milliseconds 900
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
[C]::SetCursorPos([int]($b.Width / 2), [int]($b.Height / 2))
Start-Sleep -Milliseconds 300
[C]::mouse_event(0x0002,0,0,0,[IntPtr]::Zero)
Start-Sleep -Milliseconds 80
[C]::mouse_event(0x0004,0,0,0,[IntPtr]::Zero)
Start-Sleep -Milliseconds 600
$f.Close()
`;
  // Through a file rather than -Command: the here-string that declares the
  // P/Invokes has to start at column 0, which a command line does not promise.
  const file = join(tmpdir(), "dive-eyedropper-swatch.ps1");
  writeFileSync(file, script);
  execFileSync(
    "powershell",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", file],
    { stdio: "inherit" },
  );
}

const ev = await connect();
const invoke = async (command, args = {}, ms) => {
  const m = await ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)}).then(d=>({ok:d})).catch(e=>({err:String(e&&e.message||e)}))`, ms);
  const v = m.result?.result?.value;
  if (!v || v.err) throw Error(`${command}: ${v?.err ?? "no reply"}`);
  return v.ok;
};

const snapshot = await invoke("snapshot");
const workspace = snapshot.active_workspace ?? snapshot.workspaces?.[0]?.id;
const tab = await invoke("tab_open", { workspaceId: workspace, url: "about:blank" });

// Start the sampler, then paint under it. The command blocks until a click,
// so the painting has to happen while this promise is outstanding.
const sampling = invoke("tab_eyedropper", { id: tab.id }, 130_000);
// Let the sampler get past the release-wait it does first, then paint.
await delay(700);
const started = Date.now();
paintAndClick();

const picked = await sampling;
console.log(`sampler answered ${((Date.now() - started) / 1000).toFixed(1)}s after the click`);
assert(picked, "the eyedropper reported a cancel rather than a colour");
assert.equal(
  picked.hex,
  SWATCH.hex,
  `sampled ${picked.hex} where ${SWATCH.hex} was painted -- the sampler read the wrong pixel`,
);
console.log(`eyedropper: ${picked.hex} ✓`);

// The socket keeps the event loop alive, so say so rather than leaving a
// finished check looking like a hung one.
process.exit(0);
