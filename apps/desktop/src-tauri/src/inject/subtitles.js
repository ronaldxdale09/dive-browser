// Live subtitles, page side: tap the playing video's audio through the Web
// Audio API, downsample to 16 kHz mono, and post Int16 PCM frames to the host
// over a binding. The host transcribes and calls show() to render captions.
// Rebuilding the tap is idempotent; stop() tears it down and restores audio.
if (window.__diveSubtitles) {
  // Already installed; just make sure the overlay is present.
} else {
  const BINDING = "__AUDIO_BINDING__";
  const TARGET_RATE = 16000;
  const FRAME_MS = 100;

  let ctx = null;
  let source = null;
  let node = null;
  let stream = null;
  let tappedElement = false;
  let video = null;
  let acc = [];
  let accCount = 0;
  let overlay = null;
  let hideTimer = 0;

  function largestVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      // Prefer a video that has real audio and is playing/ready.
      if (area > bestArea && v.readyState >= 1) { best = v; bestArea = area; }
    }
    return best;
  }

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    const host = document.createElement("div");
    host.setAttribute("data-dive", "subtitles");
    host.style.cssText =
      "position:fixed;left:50%;bottom:8%;transform:translateX(-50%);z-index:2147483646;" +
      "max-width:80vw;pointer-events:none;text-align:center;";
    const line = document.createElement("div");
    line.style.cssText =
      "display:inline-block;padding:6px 14px;border-radius:8px;background:rgba(0,0,0,0.72);" +
      "color:#fff;font:600 22px/1.35 -apple-system,'Segoe UI',system-ui,sans-serif;" +
      "text-shadow:0 1px 2px rgba(0,0,0,0.6);white-space:pre-wrap;";
    host.appendChild(line);
    overlay = host;
    overlay.__line = line;
    reparentOverlay();
    return overlay;
  }

  // A fullscreened/theater player is promoted to the browser's top layer,
  // which paints above any normal fixed element regardless of z-index, so the
  // caption must live inside that element to sit in front of the video.
  function reparentOverlay() {
    if (!overlay) return;
    const host = document.fullscreenElement || document.webkitFullscreenElement || document.body || document.documentElement;
    if (host && overlay.parentNode !== host) host.appendChild(overlay);
  }

  // Downsample a Float32 buffer at inputRate to 16 kHz and append Int16 LE.
  function pushDownsampled(input, inputRate) {
    const ratio = inputRate / TARGET_RATE;
    const outLen = Math.floor(input.length / ratio);
    for (let i = 0; i < outLen; i++) {
      const s = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)]));
      acc.push(s < 0 ? s * 0x8000 : s * 0x7fff);
    }
    accCount += outLen;
    // Emit roughly every FRAME_MS worth of 16 kHz samples.
    const frame = (TARGET_RATE * FRAME_MS) / 1000;
    if (accCount >= frame) {
      const buf = new ArrayBuffer(acc.length * 2);
      const view = new DataView(buf);
      for (let i = 0; i < acc.length; i++) view.setInt16(i * 2, acc[i] | 0, true);
      let bin = "";
      const b = new Uint8Array(buf);
      for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
      try { window[BINDING](btoa(bin)); } catch (_) { /* binding gone */ }
      acc = [];
      accCount = 0;
    }
  }

  function start() {
    video = largestVideo();
    if (!video) return false;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      const capture = video.captureStream || video.mozCaptureStream;
      if (capture) {
        // Non-destructive tap: mirror the element's audio into a stream while
        // the element keeps playing to the speakers through its own path. The
        // graph only reads the samples, so audio never stops even if the
        // context is briefly suspended. This is the path YouTube takes.
        stream = capture.call(video);
        if (!stream.getAudioTracks || stream.getAudioTracks().length === 0) {
          throw new Error("no-audio-track");
        }
        source = ctx.createMediaStreamSource(stream);
        tappedElement = false;
      } else {
        // Fallback taps the element itself, which reroutes its output, so the
        // processor must pass the audio through to keep it audible.
        source = ctx.createMediaElementSource(video);
        tappedElement = true;
      }
      // ScriptProcessor is deprecated but universally available and fine for
      // a 16 kHz voice tap; an AudioWorklet would need a separate module URL
      // that the page CSP may block.
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        pushDownsampled(input, ctx.sampleRate);
        // Only the element-tap fallback must relay audio to the speakers; the
        // captureStream path leaves the element's own output untouched, so the
        // node stays silent to avoid doubling it.
        const out = e.outputBuffer.getChannelData(0);
        if (tappedElement) out.set(input);
        else out.fill(0);
      };
      source.connect(node);
      node.connect(ctx.destination);
      // Capturing needs the context RUNNING to deliver samples, and a context
      // created from the chrome menu has no page gesture, so Chrome starts it
      // suspended. Try to resume; if it stays suspended, prompt for one click
      // and resume on it. (Audio itself keeps playing regardless on the
      // captureStream path.)
      const onRunning = () => status("Listening\u2026");
      const armResume = () => {
        status("Click the video to start captions");
        const resume = () => {
          document.removeEventListener("pointerdown", resume, true);
          document.removeEventListener("keydown", resume, true);
          ctx.resume().then(onRunning).catch(() => {});
        };
        document.addEventListener("pointerdown", resume, true);
        document.addEventListener("keydown", resume, true);
      };
      if (ctx.state === "running") {
        onRunning();
      } else {
        armResume();
        ctx.resume().then(() => { if (ctx.state === "running") onRunning(); }).catch(() => {});
      }
      return true;
    } catch (e) {
      window.__diveSubtitleError = String(e && e.name || e);
      return false;
    }
  }

  function stop() {
    try { if (node) node.disconnect(); } catch (_) {}
    try { if (source) source.disconnect(); } catch (_) {}
    try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { if (ctx) ctx.close(); } catch (_) {}
    node = null; source = null; stream = null; ctx = null; tappedElement = false;
    if (overlay) { overlay.remove(); overlay = null; }
    clearTimeout(hideTimer);
  }

  // A sticky line (status/hint) that stays until replaced.
  function status(text) {
    const o = ensureOverlay();
    o.__line.textContent = text;
    o.style.display = "";
    clearTimeout(hideTimer);
  }

  // A transcribed caption: shown, then faded only after a long quiet gap so
  // it does not vanish between passes.
  function show(text) {
    const o = ensureOverlay();
    o.__line.textContent = text;
    o.style.display = "";
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (overlay) overlay.style.display = "none"; }, 10000);
  }

  // Follow the video into and out of fullscreen so the caption stays on top.
  for (const ev of ["fullscreenchange", "webkitfullscreenchange"]) {
    document.addEventListener(ev, () => setTimeout(reparentOverlay, 0), true);
  }

  const ok = start();
  if (!ok) window.__diveSubtitleError = window.__diveSubtitleError || "no-video";

  window.__diveSubtitles = Object.freeze({
    hasVideo: () => Boolean(video),
    show,
    stop,
    running: () => Boolean(ctx),
  });
}
