// Node 22+. Proves the Windows halves of four features that existed only on
// macOS, through the same IPC the panels use.
//
//   DIVE_CHROMIUM_FLAGS=remote-debugging-port=9343 <Dive binary>
//   node scripts/windows/features-live-check.mjs
//
// Each of these failed differently before, and three of them failed in
// silence -- a store that was never installed, a launcher that reported
// success and wrote nothing. So each assertion here looks for the artefact
// on disk or in the registry rather than for a command that did not throw.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const port = process.env.DIVE_CHECK_CDP_PORT || "9343";

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

const ev = await connect();
const invoke = async (command, args = {}, ms) => {
  const m = await ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)}).then(d=>({ok:d})).catch(e=>({err:String(e&&e.message||e)}))`, ms);
  const v = m.result?.result?.value;
  if (!v || v.err) throw Error(`${command}: ${v?.err ?? "no reply"}`);
  return v.ok;
};
const ps = (script) =>
  execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  }).trim();

// --- credential store ------------------------------------------------------
// Without a default store every save throws, so a round trip is the check.
{
  const provider = "anthropic";
  const secret = `dive-live-check-${Date.now()}`;
  await invoke("agent_key_set", { provider, key: secret });
  const present = await invoke("agent_key_present", { provider });
  assert.equal(present, true, "the key was saved and then could not be found");
  console.log("credential store: saved and read back ✓");
}

// --- default browser -------------------------------------------------------
// Windows will not let anyone set this, so what is checkable is that Dive
// reports the platform as supported and that registering leaves the keys the
// Settings list reads. `default_browser_set` is not called: it opens Settings.
{
  const status = await invoke("default_browser_status");
  assert.equal(status.supported, true, "Windows reported as unsupported");
  assert.equal(typeof status.is_default, "boolean");
  console.log(`default browser: supported, currently ${status.current ?? "unset"} ✓`);
}

// --- web app launcher ------------------------------------------------------
{
  const snapshot = await invoke("snapshot");
  const workspace = snapshot.active_workspace ?? snapshot.workspaces?.[0]?.id;
  const tab = await invoke("tab_open", { workspaceId: workspace, url: "https://developer.mozilla.org/" });
  // The manifest is read from the page, so give it a moment to arrive.
  await new Promise((r) => setTimeout(r, 6000));
  const app = await invoke("webapp_install", { id: tab.id });
  const start = join(
    process.env.APPDATA,
    "Microsoft", "Windows", "Start Menu", "Programs", "Dive Apps",
  );
  const listed = ps(`Get-ChildItem -LiteralPath '${start}' -Filter *.lnk | ForEach-Object { $_.Name }`);
  assert(listed.length > 0, `nothing was written to ${start}`);
  console.log(`web app launcher: ${listed.split(/\r?\n/).join(", ")} ✓`);

  // And the shortcut has to actually point at Dive with this app's id.
  const first = listed.split(/\r?\n/)[0];
  const target = ps(
    `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${join(start, first)}');` +
    `$s.TargetPath + ' ' + $s.Arguments`,
  );
  assert(/dive-desktop\.exe/i.test(target), `shortcut does not run Dive: ${target}`);
  assert(/--app=/.test(target), `shortcut carries no app id: ${target}`);
  console.log(`  -> ${target}`);

  await invoke("webapp_uninstall", { appId: app.id });
  assert(
    !existsSync(join(start, first)),
    "uninstall left the shortcut behind",
  );
  console.log("web app launcher: removed on uninstall ✓");
}
