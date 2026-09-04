// Narrow, fail-open page protection for YouTube's player response and ad UI.
// The host supplies a tab-unique binding name before this source is injected.

(function () {
  "use strict";

  if (window.top !== window) return;
  if (window.__divePrivacy && window.__divePrivacy.version === 1) return;

  const bindingName = "__DIVE_PRIVACY_BINDING__";
  const nativeFetch = typeof window.fetch === "function" ? window.fetch : null;
  const xhrPrototype = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  const nativeOpen = xhrPrototype && xhrPrototype.open;
  const nativeSend = xhrPrototype && xhrPrototype.send;
  const styleSelector = "style[data-dive-privacy]";
  const removedKeys = new Set(["adPlacements", "playerAds", "adSlots"]);
  const skipSelectors = [
    ".ytp-ad-skip-button-modern",
    ".ytp-ad-skip-button",
    ".ytp-skip-ad-button",
  ];
  const xhrTargets = new WeakSet();
  const xhrListeners = new Set();
  const accelerated = new Map();
  const clicked = new WeakSet();
  const state = {
    enabled: false,
    installed: false,
    cosmeticCss: "",
    observer: null,
  };
  let wrappedFetch = null;
  let wrappedOpen = null;
  let wrappedSend = null;

  const report = () => {
    try {
      const binding = window[bindingName];
      if (typeof binding === "function") binding(JSON.stringify({ kind: "youtube", count: 1 }));
    } catch {
      // Reporting must never affect the page intervention.
    }
  };

  const walk = (value, depth, tally) => {
    if (depth > 64) throw new Error("player response nested too deeply");
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, tally));
    if (value === null || typeof value !== "object") return value;
    const clean = {};
    for (const key of Object.keys(value)) {
      if (removedKeys.has(key)) {
        tally.count += 1;
      } else {
        clean[key] = walk(value[key], depth + 1, tally);
      }
    }
    return clean;
  };

  const sanitizeWithCount = (value) => {
    const tally = { count: 0 };
    return { value: walk(value, 0, tally), count: tally.count };
  };

  const sanitize = (value) => sanitizeWithCount(value).value;

  const isPlayerUrl = (input) => {
    try {
      const raw = typeof input === "string" || input instanceof URL ? input : input && input.url;
      if (!raw) return false;
      const url = new URL(raw, window.location.href);
      return url.origin === window.location.origin && url.pathname.endsWith("/youtubei/v1/player");
    } catch {
      return false;
    }
  };

  const responseWith = (response, body) => {
    const ResponseType = window.Response || globalThis.Response;
    const replacement = new ResponseType(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    for (const property of ["url", "redirected", "type"]) {
      try {
        Object.defineProperty(replacement, property, {
          configurable: true,
          value: response[property],
        });
      } catch {
        // Some Response implementations expose non-configurable accessors.
      }
    }
    return replacement;
  };

  const sanitizeResponse = async (response) => {
    try {
      const payload = await response.clone().json();
      const clean = sanitizeWithCount(payload);
      if (clean.count === 0) return response;
      const replacement = responseWith(response, JSON.stringify(clean.value));
      report();
      return replacement;
    } catch {
      return response;
    }
  };

  const patchXhrResponse = (xhr) => {
    try {
      const responseType = xhr.responseType || "text";
      const raw = responseType === "json" ? xhr.response : xhr.responseText;
      const payload = responseType === "json" ? raw : JSON.parse(raw);
      const clean = sanitizeWithCount(payload);
      if (clean.count === 0) return;
      const text = JSON.stringify(clean.value);
      Object.defineProperty(xhr, "response", {
        configurable: true,
        get: () => (responseType === "json" ? clean.value : text),
      });
      if (responseType === "" || responseType === "text") {
        Object.defineProperty(xhr, "responseText", {
          configurable: true,
          get: () => text,
        });
      }
      report();
    } catch {
      // A response we cannot parse or safely shadow remains untouched.
    }
  };

  const visible = (element) => {
    if (!element || !element.isConnected || element.hidden) return false;
    if (element.getAttribute("aria-hidden") === "true") return false;
    try {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
    } catch {
      return true;
    }
  };

  const restore = (video, snapshot) => {
    try {
      video.volume = snapshot.volume;
      video.muted = snapshot.muted;
      video.playbackRate = snapshot.playbackRate;
    } catch {
      // Detached or page-owned media can reject assignments; cleanup is best effort.
    }
  };

  const restoreInactiveMedia = (active) => {
    for (const [video, snapshot] of accelerated) {
      if (!active.has(video)) {
        restore(video, snapshot);
        accelerated.delete(video);
      }
    }
  };

  const inspectPlayers = () => {
    const active = new Set();
    if (!state.enabled) {
      restoreInactiveMedia(active);
      return;
    }
    try {
      for (const player of document.querySelectorAll(".html5-video-player.ad-showing")) {
        const skip = skipSelectors
          .map((selector) => player.querySelector(selector))
          .find((element) => visible(element));
        if (skip) {
          if (!clicked.has(skip)) {
            clicked.add(skip);
            skip.click();
            report();
          }
          continue;
        }
        const video = player.querySelector("video");
        if (!video) continue;
        active.add(video);
        if (!accelerated.has(video)) {
          accelerated.set(video, {
            volume: video.volume,
            muted: video.muted,
            playbackRate: video.playbackRate,
          });
          try {
            video.volume = 0;
            video.muted = true;
            video.playbackRate = 16;
            report();
          } catch {
            const snapshot = accelerated.get(video);
            if (snapshot) restore(video, snapshot);
            accelerated.delete(video);
          }
        }
      }
    } catch {
      // A transient DOM state or hostile accessor disables only this pass.
    }
    restoreInactiveMedia(active);
  };

  const applyStyle = () => {
    try {
      let style = document.querySelector(styleSelector);
      if (!state.cosmeticCss) {
        if (style) style.remove();
        return;
      }
      if (!style) {
        style = document.createElement("style");
        style.setAttribute("data-dive-privacy", "");
        (document.head || document.documentElement).appendChild(style);
      }
      if (style.textContent !== state.cosmeticCss) style.textContent = state.cosmeticCss;
    } catch {
      // Cosmetic filtering is optional and must fail open.
    }
  };

  const onNavigation = () => {
    applyStyle();
    inspectPlayers();
  };

  const install = () => {
    if (state.installed) return;
    state.installed = true;

    if (nativeFetch) {
      wrappedFetch = async function (...args) {
        const response = await Reflect.apply(nativeFetch, this, args);
        if (!state.enabled || !isPlayerUrl(args[0])) return response;
        return sanitizeResponse(response);
      };
      window.fetch = wrappedFetch;
    }

    if (xhrPrototype && nativeOpen && nativeSend) {
      wrappedOpen = function (...args) {
        if (isPlayerUrl(args[1])) xhrTargets.add(this);
        else xhrTargets.delete(this);
        return Reflect.apply(nativeOpen, this, args);
      };
      wrappedSend = function (...args) {
        if (state.enabled && xhrTargets.has(this)) {
          const xhr = this;
          const listener = () => {
            if (xhr.readyState !== 4) return;
            xhr.removeEventListener("readystatechange", listener, true);
            xhrListeners.delete(entry);
            patchXhrResponse(xhr);
          };
          const entry = { xhr, listener };
          xhrListeners.add(entry);
          xhr.addEventListener("readystatechange", listener, true);
        }
        return Reflect.apply(nativeSend, this, args);
      };
      xhrPrototype.open = wrappedOpen;
      xhrPrototype.send = wrappedSend;
    }

    try {
      state.observer = new MutationObserver(inspectPlayers);
      state.observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
        childList: true,
        subtree: true,
      });
      document.addEventListener("yt-navigate-finish", onNavigation);
      window.addEventListener("popstate", onNavigation);
    } catch {
      if (state.observer) state.observer.disconnect();
      state.observer = null;
    }
    applyStyle();
    inspectPlayers();
  };

  const dispose = () => {
    if (state.observer) state.observer.disconnect();
    state.observer = null;
    document.removeEventListener("yt-navigate-finish", onNavigation);
    window.removeEventListener("popstate", onNavigation);
    for (const entry of xhrListeners) {
      entry.xhr.removeEventListener("readystatechange", entry.listener, true);
    }
    xhrListeners.clear();
    restoreInactiveMedia(new Set());
    try {
      const style = document.querySelector(styleSelector);
      if (style) style.remove();
    } catch {
      // A page replacing document roots during disposal needs no further work.
    }
    if (nativeFetch && wrappedFetch) window.fetch = nativeFetch;
    if (xhrPrototype && nativeOpen && wrappedOpen) xhrPrototype.open = nativeOpen;
    if (xhrPrototype && nativeSend && wrappedSend) xhrPrototype.send = nativeSend;
    wrappedFetch = null;
    wrappedOpen = null;
    wrappedSend = null;
    state.enabled = false;
    state.cosmeticCss = "";
    state.installed = false;
  };

  const configure = (options) => {
    const next = options && typeof options === "object" ? options : {};
    state.enabled = next.enabled === true;
    state.cosmeticCss = typeof next.cosmeticCss === "string" ? next.cosmeticCss : "";
    if (!state.enabled && !state.cosmeticCss) {
      dispose();
      return;
    }
    install();
    applyStyle();
    inspectPlayers();
  };

  window.__divePrivacy = { version: 1, install, configure, dispose, sanitize };
})();
