// Holds media requests until Dive has applied Chromium's native permission
// policy for the requesting frame's origin. A per-tab nonce prevents a page
// from forging another request stream, but the backend still treats every
// payload as untrusted and grants only remembered allow decisions.
(function () {
  const media = navigator.mediaDevices;
  if (!media || media.__diveGuarded) return;
  const nonce = __NONCE__;
  const originalUserMedia = typeof media.getUserMedia === "function" ? media.getUserMedia.bind(media) : null;
  const originalDisplayMedia = typeof media.getDisplayMedia === "function" ? media.getDisplayMedia.bind(media) : null;
  const pending = new Map();
  let nextId = 1;
  Object.defineProperty(media, "__diveGuarded", { value: true });
  Object.defineProperty(window, "__divePermissionResolve", {
    configurable: false,
    value(id, allowed) {
      const resolve = pending.get(id);
      if (!resolve) return;
      pending.delete(id);
      resolve(Boolean(allowed));
    },
  });
  const ask = (kind) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    window.__BINDING__(JSON.stringify({ nonce, id, kind }));
  });
  if (originalUserMedia) {
    media.getUserMedia = async function (constraints) {
      const kinds = [];
      if (constraints && constraints.video) kinds.push("camera");
      if (constraints && constraints.audio) kinds.push("microphone");
      const allowed = await Promise.all(kinds.map(ask));
      if (allowed.some((value) => !value)) {
        throw new DOMException("Permission denied by Dive", "NotAllowedError");
      }
      return originalUserMedia(constraints);
    };
  }
  if (originalDisplayMedia) {
    media.getDisplayMedia = async function (constraints) {
      if (!(await ask("display_capture"))) {
        throw new DOMException("Permission denied by Dive", "NotAllowedError");
      }
      return originalDisplayMedia(constraints);
    };
  }
})();
