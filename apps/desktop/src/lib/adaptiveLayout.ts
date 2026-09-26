import { useEffect, useState } from "react";

export interface ChromeLayout {
  collapseRail: boolean;
  compactToolbar: boolean;
  singleAuxPanel: boolean;
}

/** Responsive policy for the browser chrome. Values leave room for page content. */
export function chromeLayoutForWidth(width: number): ChromeLayout {
  return {
    collapseRail: width < 960,
    compactToolbar: width < 820,
    singleAuxPanel: width < 960,
  };
}

/** Live viewport policy without persisting responsive overrides as preferences. */
export function useChromeLayout(): ChromeLayout {
  const [layout, setLayout] = useState(() => chromeLayoutForWidth(window.innerWidth));
  useEffect(() => {
    const update = () => {
      const next = chromeLayoutForWidth(window.innerWidth);
      setLayout((current) =>
        current.collapseRail === next.collapseRail && current.compactToolbar === next.compactToolbar && current.singleAuxPanel === next.singleAuxPanel
          ? current
          : next,
      );
    };
    window.addEventListener("resize", update, { passive: true });
    return () => window.removeEventListener("resize", update);
  }, []);
  return layout;
}

/**
 * The window's inner size, re-read on every resize (coalesced to a frame).
 * With `active` false it stops following, so the caller does not re-render
 * through a resize it has no use for; it catches up on the next frame once
 * active again.
 */
export function useViewportSize(active = true): { width: number; height: number } {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setSize((current) => (current.width === window.innerWidth && current.height === window.innerHeight ? current : { width: window.innerWidth, height: window.innerHeight }));
      });
    };
    // Whatever changed while this was not listening.
    update();
    window.addEventListener("resize", update, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
    };
  }, [active]);
  return size;
}
