// Mirror video audio without rerouting speaker output. Each injection owns a session.
window.__diveSubtitles?.stop();
delete window.__diveSubtitleError;
const BINDING = "__AUDIO_BINDING__";
let stopped = false;
let ctx, source, node, stream, video, overlay, line, monitor, hideTimer;
let epoch = 0, currentSource = "", captureStarted = 0, lastFrame = 0;
let phase = 0, sum = 0, count = 0, state = "";
const pcm = new Int16Array(1600);
const removers = [], videoRemovers = [];

function listen(target, name, fn, list = removers) {
  target.addEventListener(name, fn, true);
  list.push(() => target.removeEventListener(name, fn, true));
}
function send(message) {
  if (!stopped) window[BINDING](JSON.stringify({ ...message, epoch }));
}
function largestVideo() {
  return [...document.querySelectorAll("video")]
    .filter((v) => v.readyState >= 1 && v.getBoundingClientRect().width > 0)
    .sort((a, b) => Number(a.paused || a.ended) - Number(b.paused || b.ended) ||
      b.getBoundingClientRect().width * b.getBoundingClientRect().height -
      a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
}
function reparent() {
  if (!overlay) return;
  const parent = document.fullscreenElement || document.webkitFullscreenElement || document.body || document.documentElement;
  if (parent && overlay.parentNode !== parent) parent.appendChild(overlay);
}
function show(text, forEpoch = epoch) {
  if (stopped || forEpoch !== epoch) return;
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.setAttribute("data-dive", "subtitles");
    overlay.style.cssText = "position:fixed;left:50%;bottom:8%;transform:translateX(-50%);z-index:2147483646;max-width:80vw;pointer-events:none;text-align:center;";
    line = document.createElement("div");
    line.style.cssText = "display:inline-block;padding:6px 14px;border-radius:8px;background:rgba(0,0,0,.78);color:white;font:600 22px/1.35 -apple-system,system-ui,sans-serif;text-shadow:0 1px 2px black;white-space:pre-wrap;";
    overlay.appendChild(line);
    reparent();
  }
  line.textContent = text;
  overlay.style.display = text ? "" : "none";
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { if (overlay) overlay.style.display = "none"; }, 4000);
}
function status(value) {
  if (state === value) return;
  state = value;
  send({ kind: "state", state: value });
  show(value);
  clearTimeout(hideTimer);
}
function reset() {
  epoch++;
  phase = sum = count = 0;
  send({ kind: "reset" });
  show("");
  state = "";
  captureStarted = performance.now();
  lastFrame = 0;
}
function detach() {
  videoRemovers.splice(0).forEach((remove) => remove());
  if (node) { node.onaudioprocess = null; node.disconnect(); }
  source?.disconnect();
  stream?.getTracks().forEach((track) => track.stop());
  void ctx?.close().catch(() => {});
  node = source = stream = ctx = undefined;
}
function stop() {
  if (stopped) return;
  stopped = true;
  clearInterval(monitor);
  clearTimeout(hideTimer);
  removers.splice(0).forEach((remove) => remove());
  detach();
  overlay?.remove();
  overlay = undefined;
}
function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  window.__diveSubtitleError = message;
  try { send({ kind: "error", error: message }); } finally { stop(); }
}
function resume() {
  const context = ctx;
  if (!context || stopped) return;
  void context.resume().then(() => {
    if (!stopped && ctx === context) updateState();
  }).catch((e) => { if (!stopped && ctx === context) fail(e); });
}
function updateState() {
  if (video.paused || video.ended) status("Paused — play the video to resume captions");
  else if (ctx.state !== "running") status("Click the video to enable audio capture");
  else status(lastFrame ? "Listening…" : "Waiting for video audio…");
}
function attach(next) {
  detach();
  video = next;
  currentSource = video.currentSrc;
  const capture = video.captureStream || video.mozCaptureStream;
  if (!capture) throw new Error("This player does not support video audio capture.");
  stream = capture.call(video);
  if (!stream.getAudioTracks().length) throw new Error("This video has no capturable audio track. Start playback and try again.");
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  source = ctx.createMediaStreamSource(stream);
  node = ctx.createScriptProcessor(4096, 1, 1);
  const ratio = ctx.sampleRate / 16000;
  // Area averaging carries the fractional phase across callbacks (including 44.1 kHz).
  node.onaudioprocess = (event) => {
    event.outputBuffer.getChannelData(0).fill(0);
    if (stopped || video.paused || video.ended || video.seeking) return;
    lastFrame = performance.now();
    try {
      for (const sample of event.inputBuffer.getChannelData(0)) {
        let remaining = 1;
        while (remaining > 1e-9) {
          const weight = Math.min(remaining, ratio - phase);
          sum += sample * weight;
          phase += weight;
          remaining -= weight;
          if (phase >= ratio - 1e-9) {
            const value = Math.max(-1, Math.min(1, sum / ratio));
            pcm[count++] = Math.round(value * (value < 0 ? 32768 : 32767));
            phase = sum = 0;
            if (count === pcm.length) {
              const bytes = new Uint8Array(pcm.length * 2);
              const view = new DataView(bytes.buffer);
              for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i], true);
              send({ kind: "audio", pcm: btoa(String.fromCharCode(...bytes)) });
              count = 0;
            }
          }
        }
      }
    } catch (e) { fail(e); }
  };
  source.connect(node);
  node.connect(ctx.destination);
  for (const name of ["seeking", "pause", "ended", "ratechange", "emptied"]) {
    listen(video, name, () => { reset(); updateState(); }, videoRemovers);
  }
  listen(video, "play", () => { reset(); resume(); updateState(); }, videoRemovers);
  listen(video, "seeked", () => { reset(); updateState(); }, videoRemovers);
  captureStarted = performance.now();
  updateState();
  resume();
}

window.__diveSubtitles = Object.freeze({ binding: BINDING, show, stop, running: () => !stopped && Boolean(node) });
try {
  const next = largestVideo();
  if (!next) throw new Error("No video found. Start a video on this page first.");
  attach(next);
  for (const name of ["pointerdown", "keydown"]) listen(document, name, resume);
  for (const name of ["fullscreenchange", "webkitfullscreenchange"]) listen(document, name, reparent);
  listen(window, "pagehide", () => { send({ kind: "ended" }); stop(); });
  monitor = setInterval(() => {
    try {
      const next = largestVideo();
      if (next && (next !== video || next.currentSrc !== currentSource)) {
        reset();
        attach(next);
      }
      if (!video.isConnected) throw new Error("The video was removed. Start subtitles again on the new video.");
      if (stream.getAudioTracks().every((track) => track.readyState === "ended") && !video.ended) {
        reset();
        attach(video);
      }
      updateState();
      if (!video.paused && !video.ended && ctx.state === "running" &&
          performance.now() - (lastFrame || captureStarted) > 15000) {
        throw new Error("No audio received from this player. Try playing the video again or choose another video.");
      }
    } catch (e) { fail(e); }
  }, 500);
} catch (e) { fail(e); }
return { ok: !stopped, error: window.__diveSubtitleError || null };
