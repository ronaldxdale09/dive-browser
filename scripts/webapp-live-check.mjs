// Node 22+. End-to-end check of installing a web app, against a PRIVATE Dive
// instance started with remote debugging:
//   DIVE_CHROMIUM_FLAGS=remote-debugging-port=9339 DIVE_DATA_DIR=<scratch profile> <Dive binary>
// Then:
//   DIVE_WEBAPP_URL=https://squoosh.app node scripts/webapp-live-check.mjs
//
// Drives the chrome through its own IPC (the same calls the buttons make), so
// what is checked is the real probe, the real install, the real app window:
//   1. open the site in a tab and wait for it to load
//   2. webapp_probe says it is installable, with a name and an icon
//   3. webapp_install returns the app and a window with ?app= appears
//   4. webapps_list carries it; the launcher bundle exists with an icon
//   5. webapp_uninstall removes the row and the bundle
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const port = process.env.DIVE_WEBAPP_CDP_PORT || "9339";
const site = process.env.DIVE_WEBAPP_URL;
assert(site, "Set DIVE_WEBAPP_URL to a site that serves a web app manifest");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const connections = [];

async function targets() {
  return (await fetch(`http://127.0.0.1:${port}/json`)).json();
}
async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  connections.push(socket);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (request) { pending.delete(message.id); clearTimeout(request.timer); request.resolve(message); }
  };
  return async (expression) => {
    const id = ++sequence;
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error("CDP request timed out")); }, 60000);
      pending.set(id, { resolve, timer });
      socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true, userGesture: true } }));
    });
    if (response.error || response.result?.exceptionDetails) throw Error(JSON.stringify(response.error || response.result.exceptionDetails));
    return response.result.result.value;
  };
}
// Windows are generous: a cold profile under a debug build on a busy machine
// can take a minute to bring a heavy SPA to the point of answering.
async function eventually(probe, message, seconds = 20) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(150);
  }
  throw Error(message);
}

const uiTarget = (await targets()).find((t) => t.url === "http://tauri.localhost/");
assert(uiTarget, "Dive chrome target missing; start Dive with DIVE_CHROMIUM_FLAGS=remote-debugging-port=" + port);
const ui = await connect(uiTarget);
// Commands return specta results: {status:"ok",data} | {status:"error",error}.
const invoke = async (command, args = {}) => {
  const result = await ui(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
  if (result && result.status === "error") throw Error(`${command}: ${JSON.stringify(result.error)}`);
  return result && result.status === "ok" ? result.data : result;
};

let installed = null;
try {
  const snapshot = await invoke("snapshot");
  const workspace = snapshot.active_workspace ?? snapshot.workspaces?.[0]?.id;
  assert(workspace, "no workspace to open the site in");
  const tab = await invoke("tab_open", { workspaceId: workspace, url: site });
  console.log(`opened ${site} in tab ${tab.id}`);

  // 1. Loaded: the page target exists and is no longer about:blank.
  await eventually(async () => (await targets()).some((t) => t.type === "page" && t.url.startsWith(new URL(site).origin)), "site never loaded", 90);
  await delay(1500);

  // 2. The probe, exactly as the address bar asks it.
  const probe = await eventually(async () => {
    const p = await invoke("webapp_probe", { id: tab.id }).catch(() => null);
    return p && p.installable ? p : null;
  }, "page never became installable (check the site has a manifest with a 192px icon)", 120);
  assert(probe.name, "probe has no name");
  assert(probe.icon_url, "probe has no icon");
  console.log(`installable as "${probe.name}" (${probe.display}, icon ${probe.icon_size}px)`);

  // 3. Install: the tab becomes an app window whose chrome names the app.
  installed = await invoke("webapp_install", { id: tab.id });
  assert.equal(installed.name, probe.name);
  assert(existsSync(installed.icon_path), `icon not written at ${installed.icon_path}`);
  const appWindow = await eventually(async () => (await targets()).find((t) => t.url.includes("index.html?popout=") && t.url.includes("&app=")), "no app window appeared", 20);
  console.log(`app window: ${appWindow.url}`);

  // 4. Listed, and the launcher exists.
  const list = await invoke("webapps_list");
  assert(list.some((a) => a.id === installed.id), "installed app missing from webapps_list");
  const bundle = join(homedir(), "Applications", "Dive Apps", `${installed.name.replace(/[/:\\]/g, "")}.app`);
  assert(existsSync(join(bundle, "Contents", "Info.plist")), `launcher bundle missing at ${bundle}`);
  assert(existsSync(join(bundle, "Contents", "MacOS", "launch")), "launcher executable missing");
  const icns = existsSync(join(bundle, "Contents", "Resources", "icon.icns"));
  console.log(`launcher: ${bundle} (${icns ? "icns" : "png fallback"})`);

  // 5. Uninstall cleans up and hands the window back.
  await invoke("webapp_uninstall", { appId: installed.id });
  assert(!(await invoke("webapps_list")).some((a) => a.id === installed.id), "app still listed after uninstall");
  await eventually(async () => !existsSync(join(bundle, "Contents", "Info.plist")), "launcher bundle not removed", 10);
  // The engine is the oracle for the window, not the CDP target list: a
  // reparented CEF view never acknowledges its close, so its target lingers
  // in /json after the window itself is gone (see dive_native_close logs).
  await eventually(async () => {
    const after = await invoke("snapshot");
    return !(after.detached ?? []).includes(tab.id);
  }, "app tab still detached after uninstall", 10);
  console.log("uninstall cleaned up: tab is back in the main window");
  await invoke("tab_close", { id: tab.id }).catch(() => undefined);
  console.log("WEBAPP LIVE CHECK PASSED");
} finally {
  for (const socket of connections) socket.close();
}
