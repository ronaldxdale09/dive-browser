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
