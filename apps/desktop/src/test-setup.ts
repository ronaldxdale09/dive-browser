/**
 * jsdom has no matchMedia, and the chrome asks it for the OS color scheme on
 * every appearance change. Answer "no" to every query, which resolves the
 * system theme to dark — the same default the stylesheet starts on.
 */
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

/** jsdom has no layout observer; components still perform their initial synchronous measurement. */
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
}

/** Canvas rendering is exercised by native/browser integration tests. In
 * jsdom its placeholder only prints a noisy "not implemented" error. */
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => null,
});

/**
 * jsdom reports no platform. Dive's chords render as ⌘ glyphs on a Mac and as
 * "Ctrl+" elsewhere, so tests read a definite answer; the ones that care about
 * the other platform set `navigator.platform` themselves.
 */
if (!navigator.platform) {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
}
