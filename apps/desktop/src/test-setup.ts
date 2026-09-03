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
