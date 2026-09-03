import { ipc } from "./ipc";
import { useBrowser } from "../store/browser";

/**
 * The one place chrome-side commands are dispatched. The palette and the
 * keyboard shortcuts both call this, so an id can never be handled by one
 * and forgotten by the other. Unknown ids go to the Rust registry, which
 * rejects chrome-owned ids loudly.
 */
export const UI_COMMANDS: Record<string, () => void | Promise<void>> = {
  "palette.open": () => useBrowser.getState().toggle("palette", true),
  "tab.new": () => useBrowser.getState().toggle("palette", true),
  "tab.close": () => {
    const { activeTab, closeTab } = useBrowser.getState();
    return activeTab ? closeTab(activeTab) : undefined;
  },
  "tab.reload": () => useBrowser.getState().reload(),
  "tab.devtools": () => useBrowser.getState().devtools(),
  "zoom.in": () => useBrowser.getState().zoomStep(1),
  "zoom.out": () => useBrowser.getState().zoomStep(-1),
  "zoom.reset": () => useBrowser.getState().zoomStep(0),
  "sidecar.toggle": () => useBrowser.getState().toggle("sidecar"),
  "dock.toggle": () => useBrowser.getState().toggle("dock"),
  "capture.fullpage": () => useBrowser.getState().capture(true),
  "find.open": () => useBrowser.getState().toggle("find", true),
};

export function runCommand(id: string): void {
  const handler = UI_COMMANDS[id];
  if (handler) {
    void handler();
    return;
  }
  void ipc.commandRun(id).catch((e: unknown) => {
    useBrowser.setState({ error: e instanceof Error ? e.message : String(e) });
  });
}

/** Default chords, parsed from the same notation Rust reports ("mod+shift+s"). */
export const SHORTCUTS: Record<string, string> = {
  "mod+k": "palette.open",
  "mod+t": "tab.new",
  "mod+w": "tab.close",
  "mod+r": "tab.reload",
  "mod+alt+i": "tab.devtools",
  "mod+=": "zoom.in",
  "mod+-": "zoom.out",
  "mod+0": "zoom.reset",
  "mod+j": "sidecar.toggle",
  "mod+shift+d": "dock.toggle",
  "mod+shift+s": "capture.fullpage",
  "mod+f": "find.open",
};

export function chordOf(e: KeyboardEvent): string | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  const key = e.key.toLowerCase();
  if (key.length !== 1) return null;
  return `mod+${e.shiftKey ? "shift+" : ""}${key}`;
}
