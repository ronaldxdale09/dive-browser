// Document-start activity evidence for conservative idle discard. No form data
// leaves the renderer. Unknown coverage always protects the tab.
(function () {
  if (window.__diveActivitySnapshot) return;
  const nonce = __NONCE__;
  let known = document.readyState === "loading";
  let dirty = false;
  let pendingCapture = 0;
  let unloadListener = false;
  const audio = new Set();
  const media = new Set();
  const installed = [];
  const peers = new Set();
  const tracks = new Set();
  const remembered = new WeakMap();
  let notified = false;
  const signal = () => {
    // One receipt invalidates the host's previous evidence. Further changes
    // need no IPC until a new snapshot arms another discard decision.
    if (notified) return;
    try { window.__diveActivityChanged(JSON.stringify({ nonce })); notified = true; }
    catch (_) { known = false; }
  };
  const remember = (set, value, events) => {
    // Weak references prevent the guard from extending a media object's life.
    // Repeated play/capture calls must not accumulate references to the same
    // long-lived player or track. The membership index is also weak.
    let seen = remembered.get(set);
    if (!seen) { seen = new WeakSet(); remembered.set(set, seen); }
    if (!seen.has(value)) {
      seen.add(value);
      set.add(new WeakRef(value));
      for (const event of events) value.addEventListener(event, signal);
    }
    signal();
    return value;
  };
  const active = (set, predicate) => {
    let found = false;
    for (const ref of set) {
      const value = ref.deref();
      if (!value) set.delete(ref);
      else if (predicate(value)) found = true;
    }
    return found;
  };
  const replace = (object, name, value) => {
    try {
      object[name] = value;
      if (object[name] !== value) known = false;
      else installed.push([object, name, value]);
    } catch (_) { known = false; }
  };
  const constructor = (name, set, events) => {
    const Native = window[name];
    if (typeof Native !== "function") return;
    replace(window, name, new Proxy(Native, {
      construct(target, args, newTarget) {
        return remember(set, Reflect.construct(target, args, newTarget), events);
      },
    }));
  };
  constructor("Audio", media, ["playing", "pause", "ended"]);
  constructor("AudioContext", audio, ["statechange"]);
  constructor("webkitAudioContext", audio, ["statechange"]);
  constructor("RTCPeerConnection", peers, ["connectionstatechange", "iceconnectionstatechange"]);
  constructor("webkitRTCPeerConnection", peers, ["connectionstatechange", "iceconnectionstatechange"]);
  const trackStream = (stream) => {
    for (const track of stream.getTracks()) remember(tracks, track, ["ended", "mute", "unmute"]);
    return stream;
  };
  const devices = navigator.mediaDevices;
  for (const name of ["getUserMedia", "getDisplayMedia"]) {
    if (!devices || typeof devices[name] !== "function") continue;
    const native = devices[name];
    replace(devices, name, function (...args) {
      pendingCapture += 1;
      signal();
      let request;
      try { request = native.apply(this, args); }
      catch (error) { pendingCapture -= 1; signal(); throw error; }
      return Promise.resolve(request).then(trackStream).finally(() => {
        pendingCapture -= 1;
        signal();
      });
    });
  }
  for (const name of ["getUserMedia", "webkitGetUserMedia", "mozGetUserMedia"]) {
    if (typeof navigator[name] !== "function") continue;
    const native = navigator[name];
    replace(navigator, name, function (constraints, success, failure) {
      pendingCapture += 1;
      signal();
      let settled = false;
      const settle = () => { if (!settled) { settled = true; pendingCapture -= 1; signal(); } };
      try { return native.call(this, constraints,
        (stream) => { trackStream(stream); settle(); success(stream); },
        (error) => { settle(); if (failure) failure(error); });
      } catch (error) { settle(); throw error; }
    });
  }
  const play = window.HTMLMediaElement?.prototype.play;
  if (play) replace(window.HTMLMediaElement.prototype, "play", function (...args) {
    remember(media, this, ["playing", "pause", "ended"]);
    return play.apply(this, args);
  });
  for (const proto of [window.HTMLMediaElement?.prototype, window.HTMLCanvasElement?.prototype]) {
    for (const name of ["captureStream", "mozCaptureStream"]) {
      if (!proto || typeof proto[name] !== "function") continue;
      const native = proto[name];
      replace(proto, name, function (...args) { return trackStream(native.apply(this, args)); });
    }
  }
  const add = window.addEventListener;
  replace(window, "addEventListener", function (name, ...args) {
    // Removal/AbortSignal accounting is intentionally conservative. A page
    // registering a beforeunload handler stays protected for this document.
    if (name === "beforeunload") { unloadListener = true; signal(); }
    return add.call(this, name, ...args);
  });
  const shadow = window.Element.prototype.attachShadow;
  replace(window.Element.prototype, "attachShadow", function (options) {
    const root = shadow.call(this, options);
    if (options.mode === "closed") known = false;
    else observe(root);
    signal();
    return root;
  });
  function observe(root) {
    for (const event of ["play", "playing", "pause", "ended", "volumechange", "load", "submit", "reset"])
      root.addEventListener(event, signal, true);
    for (const event of ["input", "change"])
      root.addEventListener(event, () => { dirty = true; signal(); }, true);
    new window.MutationObserver(signal).observe(root, { childList: true, subtree: true, attributes: true });
  }
  observe(document);
  function snapshot() {
    // Snapshot inspection is synchronous. Re-arm before reading activity so
    // any subsequent event invalidates this evidence immediately, with no
    // debounce window in which the host could discard a newly active page.
    notified = false;
    const reasons = new Set();
    let covered = known && installed.every(([object, name, value]) => object[name] === value);
    if (active(media, (value) => !value.paused && !value.ended)) reasons.add("media");
    if (document.readyState !== "complete") covered = false;
    if (dirty) reasons.add("unsaved_form");
    if (unloadListener || window.onbeforeunload) reasons.add("beforeunload");
    if (active(audio, (value) => value.state === "running")) reasons.add("web_audio");
    if (active(peers, (value) => value.connectionState !== "closed")) reasons.add("webrtc");
    if (pendingCapture || active(tracks, (value) => value.readyState !== "ended")) reasons.add("capture");
    function walk(root) {
      for (const element of root.querySelectorAll("*")) {
        const tag = element.localName;
        if ((tag === "video" || tag === "audio") && !element.paused && !element.ended) reasons.add("media");
        if ((tag === "input" && (element.value !== element.defaultValue || element.checked !== element.defaultChecked)) ||
            (tag === "textarea" && element.value !== element.defaultValue) ||
            (tag === "select" && Array.from(element.options).some((option) => option.selected !== option.defaultSelected)))
          reasons.add("unsaved_form");
        if (element.shadowRoot) walk(element.shadowRoot);
        if (tag === "iframe" || tag === "frame") {
          try {
            const child = element.contentWindow;
            if (!child || typeof child.__diveActivitySnapshot !== "function") { covered = false; continue; }
            const nested = child.__diveActivitySnapshot();
            covered = covered && nested.known;
            for (const reason of nested.reasons) reasons.add(reason);
          } catch (_) { covered = false; }
        }
        // Embedded plugin documents cannot provide activity evidence.
        if (tag === "object" || tag === "embed") covered = false;
      }
    }
    try { walk(document); } catch (_) { covered = false; }
    return { known: covered, reasons: Array.from(reasons),
      scroll: [Math.round(window.scrollX), Math.round(window.scrollY)], url: window.location.href };
  }
  Object.defineProperty(window, "__diveActivitySnapshot", { value: snapshot });
  signal();
})();
