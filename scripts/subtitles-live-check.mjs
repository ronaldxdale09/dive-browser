// Node 22+. Run against a PRIVATE Dive instance with a downloaded Base model:
// DIVE_CHROMIUM_FLAGS=remote-debugging-port=9338 DIVE_DATA_DIR=<private profile> <Dive binary>
// Serve a page containing a <video> with a known, >=10-second spoken recording.
// DIVE_SUBTITLE_FIXTURE_URL=http://127.0.0.1:8878/index.html node scripts/subtitles-live-check.mjs
// Optional DIVE_SUBTITLE_SOAK_SECS=900 exercises sustained playback and samples RSS.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const port = process.env.DIVE_SUBTITLE_CDP_PORT || "9338";
const fixture = process.env.DIVE_SUBTITLE_FIXTURE_URL;
assert(fixture, "Set DIVE_SUBTITLE_FIXTURE_URL to a local speech fixture page");
assert(["127.0.0.1", "localhost"].includes(new URL(fixture).hostname), "Use a local fixture");
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

async function eventually(probe, message, seconds = 15) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(100);
  }
  throw Error(message);
}

const uiTarget = (await targets()).find((t) => t.url === "http://tauri.localhost/");
assert(uiTarget, "Private Dive chrome target missing");
const ui = await connect(uiTarget);
const invoke = (command, args = {}) => ui(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
let tab;
try {
  const snapshot = await invoke("snapshot");
  const url = new URL(fixture);
  url.searchParams.set("subtitle-check", String(Date.now()));
  tab = await invoke("tab_open", { workspaceId: snapshot.active_workspace, url: url.href });
  const target = await eventually(async () => (await targets()).find((t) => t.url === url.href), "Fixture target missing");
  const page = await connect(target);
  await eventually(() => page('document.querySelector("video")?.readyState >= 3'), "Video did not load");
  await page('window.fixtureVideo=document.querySelector("video");fixtureVideo.volume=0;fixtureVideo.loop=true;fixtureVideo.play()');
  const options = { id: tab.id, model: "base", language: "auto", translate: false };
  await invoke("subtitle_start", options);
  await assert.rejects(invoke("subtitle_start", options), /already/);
  const caption = () => page('(() => {const e=document.querySelector("[data-dive=subtitles]");const text=e?.textContent;return text && !/^(Listening|Waiting|Click|Paused|\\[)/.test(text) && e.style.display!=="none" ? text : null})()');
  console.log("first_caption", await eventually(caption, "No recognized speech appeared"));

  await page("fixtureVideo.pause()");
  await eventually(() => page('document.querySelector("[data-dive=subtitles]")?.textContent.startsWith("Paused")'), "Pause did not clear captions");
  const began = Date.now();
  await page("fixtureVideo.currentTime=0;fixtureVideo.play()");
  const resumedCaption = await eventually(caption, "Seek/resume did not recover");
  console.log("caption_after_seek", { ms: Date.now() - began, text: resumedCaption });
  await page("document.body.requestFullscreen()");
  await eventually(() => page('document.querySelector("[data-dive=subtitles]")?.parentElement===document.fullscreenElement'), "Overlay not in fullscreen container");
  await page("document.exitFullscreen()");

  const soak = Number(process.env.DIVE_SUBTITLE_SOAK_SECS || 0);
  assert(Number.isFinite(soak) && soak >= 0 && soak <= 3600, "Invalid soak duration");
  await page(`window.subtitleObservation={updates:0,last:performance.now()};
    window.subtitleObserver=new MutationObserver(()=>{
      const text=document.querySelector('[data-dive=subtitles]')?.textContent;
      if(text && !/^(Listening|Waiting|Click|Paused)/.test(text)){
        window.subtitleObservation.updates++;window.subtitleObservation.last=performance.now();
      }
    });window.subtitleObserver.observe(document.body,{subtree:true,childList:true,characterData:true});`);
  const deadline = Date.now() + soak * 1000;
  while (Date.now() < deadline) {
    assert(await invoke("subtitle_running", { id: tab.id }));
    assert(await page("window.__diveSubtitles.running()"));
    const health = await page("({updates:subtitleObservation.updates,age:performance.now()-subtitleObservation.last,paused:fixtureVideo.paused})");
    assert.equal(health.paused, false, "Playback stopped during soak");
    assert(health.age < 20000, "Caption updates stalled during soak");
    console.log("soak", { remaining: Math.ceil((deadline - Date.now()) / 1000), caption: await caption(),
      ...health,
      rss: process.env.DIVE_SUBTITLE_PID ? execFileSync("ps", ["-p", process.env.DIVE_SUBTITLE_PID, "-o", "rss=,%cpu="], { encoding: "utf8" }).trim() : undefined });
    await delay(Math.min(30000, Math.max(1, deadline - Date.now())));
  }

  await invoke("subtitle_stop", { id: tab.id });
  await eventually(() => page('!window.__diveSubtitles.running() && !document.querySelector("[data-dive=subtitles]")'), "Stop did not remove capture");
  assert.equal(await page("fixtureVideo.paused"), false, "Stopping subtitles interrupted playback");
  await invoke("subtitle_start", options);
  console.log("restart_caption", await eventually(caption, "Restart did not recover captions"));
  await invoke("tab_navigate", { id: tab.id, url: "about:blank" });
  await eventually(async () => !(await invoke("subtitle_running", { id: tab.id })), "Navigation leaked the worker");
  await assert.rejects(invoke("subtitle_start", options), /No video/);
  assert.equal(await invoke("subtitle_running", { id: tab.id }), false, "Failed start leaked a session");
  console.log("PASS: real audio, duplicate suppression, pause, seek, fullscreen, stop, restart, navigation, failed-start cleanup");
} finally {
  if (tab) await invoke("tab_close", { id: tab.id });
  connections.forEach((socket) => socket.close());
}
