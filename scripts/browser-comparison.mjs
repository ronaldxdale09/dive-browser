// macOS / Node 22+. Graphical browsers, isolated profiles, matched local fixture.
// Set BENCH_DIVE_BIN, BENCH_CHROME_BIN and BENCH_BRAVE_BIN to exact native binaries.
// BENCH_DIVE_FLAGS is for separately labelled experiments, never hidden baseline tuning.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.resolve(
  process.env.BENCH_OUTPUT ||
    path.join(root, "target", "browser-comparison-" + Date.now()),
);
fs.mkdirSync(dir, { recursive: true });
const fixture = fs
  .readFileSync(path.join(root, "scripts/memory-fixture.py"), "utf8")
  .split('PAGE = b"""')[1]
  .split('"""')[0];
const events = new Map();
const readyEvents = new Map();
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  fs.appendFileSync(path.join(dir, "requests.log"), req.url + "\n");
  if (u.pathname === "/ready") {
    const run = u.searchParams.get("run");
    const receipt = {
      at: performance.now(),
      values: JSON.parse(u.searchParams.get("data")),
    };
    if (!events.has(run)) events.set(run, receipt);
    readyEvents.set(`${run}:${receipt.values.origin}`, receipt);
    res.writeHead(204);
    res.end();
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.setHeader("Cache-Control", "no-store");
  const hook = `<script>addEventListener('load',()=>setTimeout(()=>{
    const n=performance.getEntriesByType('navigation')[0];
    const initialViewport=[innerWidth,innerHeight];
    let sent=false,pending=false;
    const usable=()=>innerWidth>=400&&innerHeight>=300&&document.visibilityState==='visible';
    const report=()=>{
      if(sent||pending||!usable())return;
      pending=true;
      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        pending=false;if(sent||!usable())return;sent=true;
        removeEventListener('resize',report);removeEventListener('visibilitychange',report);
        fetch('/ready?run='+encodeURIComponent(new URL(location.href).searchParams.get('run'))+'&data='+encodeURIComponent(JSON.stringify({origin:performance.timeOrigin,visibleReadyMs:performance.now(),loadMs:n.loadEventEnd,domMs:n.domContentLoadedEventEnd,initialViewport,viewport:[innerWidth,innerHeight],visibility:document.visibilityState,rows:document.querySelectorAll('#root>div').length,bytes:window.__diveMemoryFixture.byteLength})));
      }));
    };
    addEventListener('resize',report);addEventListener('visibilitychange',report);report();
  },0))</script>`;
  res.end(fixture + hook);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const configs = {
  DIVE: {
    binary:
      process.env.BENCH_DIVE_BIN ||
      "/Applications/Dive.app/Contents/MacOS/dive-desktop",
  },
  Chrome: {
    binary:
      process.env.BENCH_CHROME_BIN ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  },
  Brave: {
    binary:
      process.env.BENCH_BRAVE_BIN ||
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  },
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn, ms = 20000) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await delay(50);
  }
  throw Error("Readiness timeout");
}
async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function rpc(profile, port, tool, args = {}) {
  const { stdout } = await promisify(execFile)(
    "python3",
    [
      path.join(root, "scripts/mcp-call.py"),
      "--data-dir",
      profile,
      "--port",
      String(port),
      "call",
      tool,
      JSON.stringify(args),
    ],
    { timeout: 25000 },
  );
  return JSON.parse(stdout);
}
// Keep the emulation session attached across reloads. Closing a CDP socket
// can clear device metrics, silently reverting some browsers to native bounds.
const connections = new Map();
async function cdp(ws, method, params = {}) {
  if (!connections.has(ws)) {
    connections.set(ws, new Promise((resolve, reject) => {
      const socket = new WebSocket(ws), pending = new Map();
      let id = 0;
      const opening = setTimeout(() => { socket.close(); reject(Error("CDP connection timeout")); }, 15000);
      socket.onopen = () => {
        clearTimeout(opening);
        resolve((method, params) => new Promise((done, fail) => {
          const next = ++id;
          const timeout = setTimeout(() => { pending.delete(next); fail(Error("CDP timeout " + method)); }, 15000);
          pending.set(next, { done, fail, timeout, method });
          socket.send(JSON.stringify({ id: next, method, params }));
        }));
      };
      socket.onmessage = event => {
        const value = JSON.parse(event.data), request = pending.get(value.id);
        if (!request) return;
        pending.delete(value.id); clearTimeout(request.timeout);
        value.error ? request.fail(Error(JSON.stringify(value.error))) : request.done(value.result);
      };
      socket.onerror = () => { clearTimeout(opening); reject(Error("CDP socket failed")); };
      socket.onclose = () => {
        clearTimeout(opening); reject(Error("CDP connection closed"));
        for (const request of pending.values()) {
          clearTimeout(request.timeout); request.fail(Error("CDP closed during " + request.method));
        }
        connections.delete(ws);
      };
    }));
  }
  return (await connections.get(ws))(method, params);
}
async function evaluate(ws, expression) {
  const r = await cdp(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function target(debug, url) {
  return wait(async () => {
    const a = await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json();
    return a.find((x) => x.type === "page" && x.url === url);
  });
}
const metrics =
  '({loadMs:performance.getEntriesByType("navigation")[0].loadEventEnd,domMs:performance.getEntriesByType("navigation")[0].domContentLoadedEventEnd,rows:document.querySelectorAll("#root>div").length,bytes:window.__diveMemoryFixture.byteLength,origin:performance.timeOrigin,viewport:[innerWidth,innerHeight],dpr:devicePixelRatio})';
async function samples(pid) {
  const values = [];
  for (let i = 0; i < 5; i++) {
    values.push({
      ...JSON.parse(
        execFileSync(
          "python3",
          [path.join(root, "scripts/browser_footprint.py"), String(pid)],
          { encoding: "utf8" },
        ),
      ),
      time: performance.now(),
    });
    await delay(500);
  }
  return values;
}
const results = [];
const count = Number(process.env.BENCH_RUNS || 5);
const names = (process.env.BENCH_BROWSERS || "DIVE,Chrome,Brave").split(",");
if (
  !Number.isInteger(count) ||
  count < 1 ||
  count > 20 ||
  new Set(names).size !== names.length ||
  names.some((n) => !configs[n])
)
  throw Error("Use 1–20 runs and unique names from DIVE,Chrome,Brave");
const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const identities = Object.fromEntries(
  names.map((name) => [
    name,
    { binary: configs[name].binary, sha256: hash(configs[name].binary) },
  ]),
);
const configuration = {
  methodVersion: "2-visible-reload-persistent-cdp",
  reloadDefinition: "loadEventEnd plus visible double-rAF milestone; wait for readiness before the next reload",
  harnessSha256: hash(fileURLToPath(import.meta.url)),
  footprintHelperSha256: hash(path.join(root, "scripts/browser_footprint.py")),
  host: {
    model: execFileSync("sysctl", ["-n", "hw.model"], {
      encoding: "utf8",
    }).trim(),
    ramBytes: Number(
      execFileSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8" }),
    ),
    macOS: execFileSync("sw_vers", ["-productVersion"], {
      encoding: "utf8",
    }).trim(),
    build: execFileSync("sw_vers", ["-buildVersion"], {
      encoding: "utf8",
    }).trim(),
  },
  identities,
  diveFlags: process.env.BENCH_DIVE_FLAGS || "",
  fixtureSha256: createHash("sha256").update(fixture).digest("hex"),
  viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  startupDefinition:
    "load completed, visible viewport >=400x300, then two animation frames; host receipt time",
  requestedWindow: { width: 1280, height: 820 },
  tabs: 10,
  reloads: 10,
  samples: 5,
  settleSeconds: { one: 8, ten: 10 },
  metric: "sum of macOS physical footprint, bytes",
  cache:
    "fresh profiles; OS cache uncontrolled; graphical default browser features",
};
const metadataFile = path.join(dir, "metadata.json");
if (
  fs.existsSync(metadataFile) &&
  JSON.stringify(
    JSON.parse(fs.readFileSync(metadataFile, "utf8")).configuration,
  ) !== JSON.stringify(configuration)
)
  throw Error(
    "Output directory belongs to a different build or configuration; choose a new BENCH_OUTPUT",
  );
fs.writeFileSync(
  metadataFile,
  JSON.stringify(
    {
      configuration,
    },
    null,
    2,
  ),
);
fs.writeFileSync(path.join(dir, "fixture.html"), fixture);

try {
  for (let r = 0; r < count; r++) {
    const order = [
      ...names.slice(r % names.length),
      ...names.slice(0, r % names.length),
    ];
    for (const name of order) {
      const run = `${name}-${r + 1}`;
      const saved = path.join(dir, `${run}.json`);
      if (fs.existsSync(saved)) {
        results.push(JSON.parse(fs.readFileSync(saved, "utf8")));
        console.log("Retained verified run", run);
        continue;
      }
      const profile = fs.mkdtempSync(
        path.join(os.tmpdir(), "dive-browser-comparison-"),
      );
      const debug = await freePort(),
        mcp = await freePort();
      const url = `${base}/tab-0?run=${run}`;
      const env = { ...process.env };
      for (const key of Object.keys(env))
        if (key.startsWith("DIVE_")) delete env[key];
      const flags = [
        `--remote-debugging-port=${debug}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--use-mock-keychain",
      ];
      let args;
      if (name === "DIVE") {
        Object.assign(env, {
          DIVE_DATA_DIR: profile,
          DIVE_MCP_PORT: String(mcp),
          DIVE_USE_MOCK_KEYCHAIN: "1",
          DIVE_OPEN_URL: url,
          DIVE_MCP_ALLOW_EVAL: "1",
          DIVE_CHROMIUM_FLAGS:
            flags.join(" ") + " " + (process.env.BENCH_DIVE_FLAGS || ""),
          RUST_LOG: "info",
        });
        args = ["-ApplePersistenceIgnoreState", "YES"];
      } else
        args = [
          `--user-data-dir=${profile}`,
          ...flags,
          "--window-size=1280,820",
          url,
        ];
      const logfile = fs.openSync(path.join(dir, `${run}.log`), "w");
      const started = performance.now();
      const child = spawn(configs[name].binary, args, {
        env,
        stdio: ["ignore", logfile, logfile],
        detached: true,
      });
      try {
        await wait(() => {
          if (child.exitCode !== null)
            throw Error("Browser exited " + child.exitCode);
          return events.get(run);
        }, 30000);
        const startup = events.get(run).at - started;
        const version = await (
          await fetch(`http://127.0.0.1:${debug}/json/version`)
        ).json();
        let page = await target(debug, url);
        let ws = page.webSocketDebuggerUrl;
        await cdp(ws, "Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 720,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const browserVersion = version.Browser;
        await delay(8000);
        const oneFixture = await evaluate(ws, metrics);
        if (oneFixture.viewport[0] !== 1280 || oneFixture.viewport[1] !== 720 || oneFixture.dpr !== 1)
          throw Error("One-tab viewport mismatch: " + JSON.stringify(oneFixture));
        const oneSamples = await samples(child.pid);
        const oneTargets = (
          await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json()
        ).map(({ type, url }) => ({ type, url }));
        if (
          oneTargets.filter((p) => p.type === "page" && p.url.startsWith(base))
            .length !== 1
        )
          throw Error(
            "Expected exactly one fixture page during one-tab measurement",
          );
        const loads = [];
        for (let j = 0; j < 10; j++) {
          const before = await evaluate(ws, "performance.timeOrigin");
          await cdp(ws, "Page.reload", { ignoreCache: true });
          const value = await wait(async () => {
            const v = await evaluate(ws, metrics);
            return v.origin !== before && v.loadMs > 0 ? v : null;
          });
          if (value.rows !== 5000 || value.bytes !== 33554432)
            throw Error("Incomplete reload fixture");
          // A load event can precede the first layout/paint. Finish the same
          // visible double-rAF milestone before starting the next reload, and
          // keep both timings. Never compare this batch to load-only pacing
          // without disclosing the methodology change.
          let ready;
          try { ready = await wait(() => readyEvents.get(`${run}:${value.origin}`)); }
          catch (error) {
            // Preserve the failure instead of treating a missing frame as a
            // slow-but-successful sample or silently retrying navigation.
            let observed;
            try { observed = await evaluate(ws, "({url:location.href,origin:performance.timeOrigin,readyState:document.readyState,visibility:document.visibilityState,focus:document.hasFocus(),viewport:[innerWidth,innerHeight],paint:performance.getEntriesByType('paint').map(x=>x.toJSON()),now:performance.now()})"); }
            catch (probeError) { observed = { error: String(probeError) }; }
            fs.writeFileSync(path.join(dir, `${run}-readiness-failure.json`),
              JSON.stringify({run,reload:j,value,observed,receipts:[...readyEvents.entries()].filter(([key])=>key.startsWith(run+':'))},null,2));
            throw error;
          }
          const receipt = ready.values;
          if (receipt.rows !== 5000 || receipt.bytes !== 33554432 ||
              receipt.visibility !== "visible" || receipt.viewport[0] !== 1280 ||
              receipt.viewport[1] !== 720 || !Number.isFinite(receipt.visibleReadyMs) ||
              receipt.visibleReadyMs < value.loadMs)
            throw Error("Incomplete visible reload milestone: " + JSON.stringify({ value, receipt }));
          loads.push({ ...value, visibleReadyMs: receipt.visibleReadyMs,
            readyViewport: receipt.viewport });
        }
        for (let j = 1; j < 10; j++) {
          const u = `${base}/tab-${j}?run=${run}-tab-${j}`;
          if (name === "DIVE") await rpc(profile, mcp, "tab_open", { url: u });
          else
            await cdp(version.webSocketDebuggerUrl, "Target.createTarget", {
              url: u,
              background: false,
            });
          page = await target(debug, u);
          ws = page.webSocketDebuggerUrl;
          await cdp(ws, "Emulation.setDeviceMetricsOverride", {
            width: 1280,
            height: 720,
            deviceScaleFactor: 1,
            mobile: false,
          });
          if (name !== "DIVE") await cdp(ws, "Page.bringToFront");
          await wait(async () => {
            const v = await evaluate(ws, metrics);
            return v.rows === 5000 && v.bytes === 33554432;
          });
        }
        const pages = (
          await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json()
        ).filter((p) => p.type === "page" && p.url.startsWith(base));
        if (pages.length !== 10)
          throw Error(`Expected 10 pages, found ${pages.length}`);
        const tabs = [];
        for (const p of pages)
          tabs.push(await evaluate(p.webSocketDebuggerUrl, metrics));
        if (tabs.some((t) => t.rows !== 5000 || t.bytes !== 33554432 || t.viewport[0] !== 1280 || t.viewport[1] !== 720 || t.dpr !== 1))
          throw Error("Incomplete fixture");
        await delay(10000);
        const tenSamples = await samples(child.pid);
        if (hash(configs[name].binary) !== identities[name].sha256)
          throw Error("Browser binary changed during measurement");
        const result = {
          run,
          name,
          browserVersion,
          diveFlags:
            name === "DIVE" ? process.env.BENCH_DIVE_FLAGS || "" : undefined,
          methodVersion: "2-visible-reload-persistent-cdp",
          oneFixture,
          startupPageReadyMs: startup,
          startupFixture: events.get(run).values,
          loads,
          oneTab: oneSamples,
          oneTargets,
          tenTabs: tenSamples,
          tabCount: pages.length,
          tabs,
        };
        results.push(result);
        fs.writeFileSync(
          path.join(dir, `${run}.json`),
          JSON.stringify(result, null, 2),
        );
        const med = (a) => {
          const v = [...a].sort((a, b) => a - b);
          return (
            (v[Math.floor((v.length - 1) / 2)] + v[Math.floor(v.length / 2)]) /
            2
          );
        };
        console.log(
          JSON.stringify({
            run,
            startupMs: Math.round(startup),
            loadMs: med(loads.map((x) => x.loadMs)),
            oneTabMiB: Math.round(
              med(oneSamples.map((x) => x.physicalFootprintBytes)) / 1048576,
            ),
            tenTabsMiB: Math.round(
              med(tenSamples.map((x) => x.physicalFootprintBytes)) / 1048576,
            ),
          }),
        );
      } finally {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
        await delay(500);
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
        fs.closeSync(logfile);
        if (results.some((x) => x.run === run))
          fs.rmSync(profile, { recursive: true, force: true });
        else
          console.log(
            "Failed profile retained:",
            profile,
            "exit:",
            child.exitCode,
          );
      }
    }
  }
} finally {
  server.close();
  fs.writeFileSync(
    path.join(dir, "runs.json"),
    JSON.stringify(results, null, 2),
  );
}
