// Narrow, fail-open page protection for YouTube's player response and ad UI.
// The host supplies a tab-unique binding name before this source is injected.

(function () {
  "use strict";

  if (window.top !== window) return;
  if (window.__divePrivacy && window.__divePrivacy.version === 1) return;

  const bindingName = "__DIVE_PRIVACY_BINDING__";
  const styleSelector = "style[data-dive-privacy]";
  const removedKeys = new Set(["adPlacements", "playerAds", "adSlots"]);
  const youtubeHosts = new Set(["www.youtube.com", "m.youtube.com"]);
  const skipSelectors = [
    ".ytp-ad-skip-button-modern",
    ".ytp-ad-skip-button",
    ".ytp-skip-ad-button",
  ];
  const xhrTargets = new WeakSet();
  const xhrListeners = new Set();
  // Keyed weakly so a finished XHR is not kept alive by its patch record.
  // Dispose still has to find every patched object, so `patchedXhrs` keeps
  // weak references to them, pruned as they are collected.
  const xhrPatches = new WeakMap();
  const patchedXhrs = new Set();
  const trackPatched = (xhr) => {
    if (typeof WeakRef !== "function") return;
    if (patchedXhrs.size >= 64) {
      for (const ref of patchedXhrs) if (!ref.deref()) patchedXhrs.delete(ref);
    }
    patchedXhrs.add(new WeakRef(xhr));
  };
  const untrackPatched = (xhr) => {
    for (const ref of patchedXhrs) {
      const held = ref.deref();
      if (!held || held === xhr) patchedXhrs.delete(ref);
    }
  };
  const accelerated = new Map();
  const skippedPlayers = new Map();
  const state = {
    enabled: false,
    hooksInstalled: false,
    cosmeticCss: "",
    observer: null,
  };
  let wrappedFetch = null;
  let wrappedOpen = null;
  let wrappedSend = null;
  let previousFetch = null;
  let previousOpen = null;
  let previousSend = null;
  let installedXhrPrototype = null;

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

  const recognizedInitialPlayerResponse = (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    try {
      return (
        (value.videoDetails !== null && typeof value.videoDetails === "object" && typeof value.videoDetails.videoId === "string") ||
        (value.playabilityStatus !== null && typeof value.playabilityStatus === "object") ||
        (value.streamingData !== null && typeof value.streamingData === "object")
      );
    } catch {
      return false;
    }
  };

  const sanitizeInitialPlayerData = () => {
    if (!state.enabled) return;
    try {
      const property = "ytInitialPlayerResponse";
      const current = window[property];
      if (!recognizedInitialPlayerResponse(current)) return;
      const clean = sanitizeWithCount(current);
      if (clean.count === 0) return;
      const descriptor = Object.getOwnPropertyDescriptor(window, property);
      if (descriptor) {
        if (!("value" in descriptor) || descriptor.writable !== true) return;
        Object.defineProperty(window, property, { ...descriptor, value: clean.value });
      } else {
        window[property] = clean.value;
      }
      report();
    } catch {
      // Unknown accessors and frozen page globals remain untouched.
    }
  };

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
      restoreXhrResponse(xhr);
      const responseType = xhr.responseType || "text";
      const raw = responseType === "json" ? xhr.response : xhr.responseText;
      const payload = responseType === "json" ? raw : JSON.parse(raw);
      const clean = sanitizeWithCount(payload);
      if (clean.count === 0) return;
      const text = JSON.stringify(clean.value);
      const patch = {
        response: Object.getOwnPropertyDescriptor(xhr, "response"),
        responseText: Object.getOwnPropertyDescriptor(xhr, "responseText"),
        responseGetter: null,
        responseTextGetter: null,
      };
      patch.responseGetter = () => (responseType === "json" ? clean.value : text);
      if (responseType === "" || responseType === "text") {
        patch.responseTextGetter = () => text;
      }
      // Record ownership before the first mutation so a later define failure
      // can roll back every descriptor already installed by this attempt.
      xhrPatches.set(xhr, patch);
      trackPatched(xhr);
      Object.defineProperty(xhr, "response", {
        configurable: true,
        enumerable: patch.response ? patch.response.enumerable : false,
        get: patch.responseGetter,
      });
      if (patch.responseTextGetter) {
        Object.defineProperty(xhr, "responseText", {
          configurable: true,
          enumerable: patch.responseText ? patch.responseText.enumerable : false,
          get: patch.responseTextGetter,
        });
      }
      report();
    } catch {
      // A response we cannot parse or safely shadow remains untouched.
      restoreXhrResponse(xhr);
    }
  };

  function restoreXhrResponse(xhr) {
    const patch = xhrPatches.get(xhr);
    if (!patch) return;
    for (const [property, original, getter] of [
      ["response", patch.response, patch.responseGetter],
      ["responseText", patch.responseText, patch.responseTextGetter],
    ]) {
      if (!getter) continue;
      try {
        const current = Object.getOwnPropertyDescriptor(xhr, property);
        if (!current || current.get !== getter) continue;
        if (original) Object.defineProperty(xhr, property, original);
        else delete xhr[property];
      } catch {
        // A page-owned replacement descriptor wins over our cleanup.
      }
    }
    xhrPatches.delete(xhr);
    untrackPatched(xhr);
  }

  const removeXhrListeners = (xhr) => {
    for (const entry of xhrListeners) {
      if (entry.xhr !== xhr) continue;
      entry.xhr.removeEventListener("readystatechange", entry.listener, true);
      xhrListeners.delete(entry);
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
    const activePlayers = new Set();
    if (!state.enabled) {
      restoreInactiveMedia(active);
      skippedPlayers.clear();
      return;
    }
    try {
      for (const player of document.querySelectorAll(".html5-video-player.ad-showing")) {
        activePlayers.add(player);
        const skip = skipSelectors
          .map((selector) => player.querySelector(selector))
          .find((element) => visible(element));
        if (skip) {
          if (skippedPlayers.get(player) !== skip) {
            skippedPlayers.set(player, skip);
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
    for (const player of skippedPlayers.keys()) {
      if (!activePlayers.has(player)) skippedPlayers.delete(player);
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
    skippedPlayers.clear();
    applyStyle();
    sanitizeInitialPlayerData();
    inspectPlayers();
  };

  const install = () => {
    if (state.hooksInstalled) return;
    state.hooksInstalled = true;

    const delegateFetch = typeof window.fetch === "function" ? window.fetch : null;
    if (delegateFetch) {
      previousFetch = delegateFetch;
      wrappedFetch = async function (...args) {
        const response = await Reflect.apply(delegateFetch, this, args);
        if (!state.enabled || !isPlayerUrl(args[0])) return response;
        return sanitizeResponse(response);
      };
      window.fetch = wrappedFetch;
    }

    const xhrPrototype = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    const delegateOpen = xhrPrototype && xhrPrototype.open;
    const delegateSend = xhrPrototype && xhrPrototype.send;
    if (xhrPrototype && delegateOpen && delegateSend) {
      installedXhrPrototype = xhrPrototype;
      previousOpen = delegateOpen;
      previousSend = delegateSend;
      wrappedOpen = function (...args) {
        removeXhrListeners(this);
        restoreXhrResponse(this);
        if (isPlayerUrl(args[1])) xhrTargets.add(this);
        else xhrTargets.delete(this);
        return Reflect.apply(delegateOpen, this, args);
      };
      wrappedSend = function (...args) {
        if (state.enabled && xhrTargets.has(this)) {
          const xhr = this;
          const listener = () => {
            if (xhr.readyState !== 4) return;
            xhr.removeEventListener("readystatechange", listener, true);
            xhrListeners.delete(entry);
            if (state.enabled) patchXhrResponse(xhr);
          };
          const entry = { xhr, listener };
          xhrListeners.add(entry);
          xhr.addEventListener("readystatechange", listener, true);
        }
        return Reflect.apply(delegateSend, this, args);
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
      document.addEventListener("DOMContentLoaded", sanitizeInitialPlayerData);
      window.addEventListener("load", sanitizeInitialPlayerData);
      window.addEventListener("popstate", onNavigation);
    } catch {
      if (state.observer) state.observer.disconnect();
      state.observer = null;
    }
    applyStyle();
    sanitizeInitialPlayerData();
    inspectPlayers();
  };

  const uninstall = () => {
    if (state.observer) state.observer.disconnect();
    state.observer = null;
    document.removeEventListener("yt-navigate-finish", onNavigation);
    document.removeEventListener("DOMContentLoaded", sanitizeInitialPlayerData);
    window.removeEventListener("load", sanitizeInitialPlayerData);
    window.removeEventListener("popstate", onNavigation);
    for (const entry of xhrListeners) {
      entry.xhr.removeEventListener("readystatechange", entry.listener, true);
    }
    xhrListeners.clear();
    for (const ref of Array.from(patchedXhrs)) {
      const xhr = ref.deref();
      if (xhr) restoreXhrResponse(xhr);
    }
    patchedXhrs.clear();
    skippedPlayers.clear();
    restoreInactiveMedia(new Set());
    if (previousFetch && wrappedFetch && window.fetch === wrappedFetch) {
      window.fetch = previousFetch;
    }
    if (
      installedXhrPrototype &&
      previousOpen &&
      wrappedOpen &&
      installedXhrPrototype.open === wrappedOpen
    ) {
      installedXhrPrototype.open = previousOpen;
    }
    if (
      installedXhrPrototype &&
      previousSend &&
      wrappedSend &&
      installedXhrPrototype.send === wrappedSend
    ) {
      installedXhrPrototype.send = previousSend;
    }
    wrappedFetch = null;
    wrappedOpen = null;
    wrappedSend = null;
    previousFetch = null;
    previousOpen = null;
    previousSend = null;
    installedXhrPrototype = null;
    state.hooksInstalled = false;
  };

  const dispose = () => {
    state.enabled = false;
    uninstall();
    try {
      const style = document.querySelector(styleSelector);
      if (style) style.remove();
    } catch {
      // A page replacing document roots during disposal needs no further work.
    }
    state.cosmeticCss = "";
  };

  const configure = (options) => {
    const next = options && typeof options === "object" ? options : {};
    state.enabled = next.enabled === true;
    state.cosmeticCss = typeof next.cosmeticCss === "string" ? next.cosmeticCss : "";
    if (state.enabled) install();
    else uninstall();
    applyStyle();
    if (state.enabled) {
      sanitizeInitialPlayerData();
      inspectPlayers();
    }
  };

  const configureForDocument = (policy) => {
    try {
      const next = policy && typeof policy === "object" ? policy : {};
      const host = window.location.hostname.toLowerCase().replace(/\.$/, "");
      const exceptions = Array.isArray(next.exceptions)
        ? next.exceptions.filter((entry) => typeof entry === "string")
        : [];
      const siteEnabled = next.globalEnabled === true && !exceptions.includes(host);
      const cssByHost = next.cosmeticCssByHost;
      const cosmeticCss =
        siteEnabled &&
        (!youtubeHosts.has(host) || next.youtubeEnabled === true) &&
        cssByHost &&
        typeof cssByHost === "object" &&
        typeof cssByHost[host] === "string"
          ? cssByHost[host]
          : "";
      configure({
        enabled: siteEnabled && next.youtubeEnabled === true && youtubeHosts.has(host),
        cosmeticCss,
      });
    } catch {
      configure({ enabled: false });
    }
  };

  window.__divePrivacy = {
    version: 1,
    install,
    configure,
    configureForDocument,
    dispose,
    sanitize,
  };
})();
