import { useEffect } from "react";
import { useBrowser } from "../store/browser";

/** Global key chords. Kept in one place so the palette and keys agree. */
export function useShortcuts() {
  const toggle = useBrowser((s) => s.toggle);
  const closeTab = useBrowser((s) => s.closeTab);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "k" || key === "t") {
        e.preventDefault();
        toggle("palette", true);
      } else if (key === "j") {
        e.preventDefault();
        toggle("sidecar");
      } else if (key === "d" && e.shiftKey) {
        e.preventDefault();
        toggle("dock");
      } else if (key === "w") {
        e.preventDefault();
        const active = useBrowser.getState().activeTab;
        if (active) void closeTab(active);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, closeTab]);
}
