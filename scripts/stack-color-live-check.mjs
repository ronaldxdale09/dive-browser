// Node 22+. Proves the stack detector and the colour picker against a real
// page, through the same IPC the panels use.
//
//   DIVE_CHROMIUM_FLAGS=remote-debugging-port=9343 DIVE_DATA_DIR=<scratch> <Dive binary>
//   DIVE_CHECK_URL=https://nextjs.org node scripts/stack-color-live-check.mjs
//
// The eyedropper is deliberately not driven here: it opens a native picker
// that needs a real pointer, so it is checked by hand. Everything else —
// detection from headers, paths and the page's own version properties, and
// the palette read from computed styles — runs unattended.
import assert from "node:assert/strict";

const port = process.env.DIVE_CHECK_CDP_PORT || "9343";
const site = process.env.DIVE_CHECK_URL || "https://nextjs.org";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const sockets = [];

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ui = targets.find((t) => t.url === "http://tauri.localhost/");
  assert(ui, `Dive chrome target missing on ${port}`);
  const ws = new WebSocket(ui.webSocketDebuggerUrl);
  sockets.push(ws);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p(m); }
  };
  return (expression, ms = 60000) => new Promise((res, rej) => {
    const i = ++id;
    const timer = setTimeout(() => { pending.delete(i); rej(Error("CDP timed out")); }, ms);
    pending.set(i, (m) => { clearTimeout(timer); res(m); });
    ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}

const ev = await connect();
const invoke = async (command, args = {}) => {
  const m = await ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)}).then(d=>({ok:d})).catch(e=>({err:String(e&&e.message||e)}))`);
  const v = m.result?.result?.value;
  if (!v || v.err) throw Error(`${command}: ${v?.err ?? "no reply"}`);
  return v.ok;
};

try {
  const snapshot = await invoke("snapshot");
  const workspace = snapshot.active_workspace ?? snapshot.workspaces?.[0]?.id;
  const tab = await invoke("tab_open", { workspaceId: workspace, url: site });
  console.log(`opened ${site} in ${tab.id}`);

  // --- stack ---------------------------------------------------------------
  // A heavy page on a debug build takes its time, and detection improves as
  // requests arrive, so wait for a result rather than sampling once.
  const eventually = async (what, probe, seconds = 90) => {
    const deadline = Date.now() + seconds * 1000;
    let last;
    while (Date.now() < deadline) {
      last = await probe().catch(() => null);
      if (last) return last;
      await delay(2000);
    }
    throw Error(`${what} never arrived within ${seconds}s`);
  };
  const stack = await eventually("a detection", async () => {
    const r = await invoke("tab_stack", { id: tab.id });
    return r.technologies.length > 0 ? r : null;
  });
  const named = stack.technologies.map((t) => `${t.name}${t.version ? " " + t.version : ""}`);
  console.log(`stack (${stack.technologies.length}): ${named.join(", ")}`);
  for (const t of stack.technologies) {
    assert(t.name && t.category, `malformed detection: ${JSON.stringify(t)}`);
    assert(Array.isArray(t.evidence) && t.evidence.length > 0, `${t.name} has no evidence`);
  }
  const versioned = stack.technologies.filter((t) => t.version);
  console.log(versioned.length ? `versions from the page: ${versioned.map((t) => `${t.name}@${t.version}`).join(", ")}` : "no versions on this page");
  if (stack.packages.length) console.log(`source-map packages (${stack.packages.length}): ${stack.packages.slice(0, 8).join(", ")}…`);

  // --- palette -------------------------------------------------------------
  const palette = await eventually("a palette", async () => {
    const r = await invoke("tab_palette", { id: tab.id });
    return r.colors.length > 0 ? r : null;
  });
  assert(palette.scanned > 0, "nothing scanned");
  for (const c of palette.colors) {
    assert(/^#[0-9a-f]{6}$/.test(c.hex), `bad hex: ${c.hex}`);
    assert(["text", "background", "border"].includes(c.role), `bad role: ${c.role}`);
    assert(c.count > 0, `zero count for ${c.hex}`);
  }
  // Most-used first is the contract the panel relies on.
  const counts = palette.colors.map((c) => c.count);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a), "palette is not ranked by use");
  console.log(`palette (${palette.colors.length} of ${palette.scanned} elements): ${palette.colors.slice(0, 5).map((c) => `${c.hex}×${c.count}`).join(" ")}`);

  await invoke("tab_close", { id: tab.id }).catch(() => undefined);
  console.log("STACK + COLOUR LIVE CHECK PASSED");
} finally {
  for (const ws of sockets) ws.close();
}
