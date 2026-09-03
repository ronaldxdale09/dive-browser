import { ipc } from "./ipc";
import { useBrowser } from "../store/browser";
import { usePicker } from "../store/simulator";

/** Rail positions a workspace chord can reach. */
const WORKSPACE_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

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
  "report.compose": () => useBrowser.getState().bugReport(),
  "screencast.toggle": () => useBrowser.getState().screencastToggle(),
  "zoom.in": () => useBrowser.getState().zoomStep(1),
  "zoom.out": () => useBrowser.getState().zoomStep(-1),
  "zoom.reset": () => useBrowser.getState().zoomStep(0),
  "sidecar.toggle": () => useBrowser.getState().toggle("sidecar"),
  "dock.toggle": () => useBrowser.getState().toggle("dock"),
  "simulator.toggle": () => usePicker.getState().toggle(),
  "capture.fullpage": () => useBrowser.getState().capture(true),
  "find.open": () => useBrowser.getState().toggle("find", true),
  "address.focus": () => void window.dispatchEvent(new CustomEvent(FOCUS_ADDRESS)),
  "tab.back": () => useBrowser.getState().back(),
  "tab.forward": () => useBrowser.getState().forward(),
  "tab.prev": () => stepTab(-1),
  "tab.next": () => stepTab(1),
  "workspace.new": () => useBrowser.getState().setEditing({ id: null }),
  "workspace.edit": () => {
    const { activeWorkspace, setEditing } = useBrowser.getState();
    if (activeWorkspace) setEditing({ id: activeWorkspace });
  },
  // ⌘1…⌘9 land on the workspace in that rail position, the way every other
  // browser's ⌘1…⌘9 lands on a tab.
  ...Object.fromEntries(WORKSPACE_SLOTS.map((n) => [`workspace.jump.${n}`, () => jumpToWorkspace(n - 1)])),
};

/** Activate the workspace sitting at `index` in the rail, if there is one. */
function jumpToWorkspace(index: number) {
  const { workspaces, activeWorkspace, activateWorkspace } = useBrowser.getState();
  const target = workspaces[index];
  return target && target.id !== activeWorkspace ? activateWorkspace(target.id) : undefined;
}

/** Asks the toolbar to select its address field; the Toolbar listens for it. */
export const FOCUS_ADDRESS = "dive:focus-address";

/** Activate the tab `delta` places away, wrapping at both ends. */
function stepTab(delta: number) {
  const { tabs, activeTab, activateTab } = useBrowser.getState();
  if (tabs.length === 0) return;
  const from = tabs.findIndex((t) => t.id === activeTab);
  const next = tabs[(((from < 0 ? 0 : from + delta) % tabs.length) + tabs.length) % tabs.length];
  return next ? activateTab(next.id) : undefined;
}

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
  "mod+shift+b": "report.compose",
  "mod+shift+r": "screencast.toggle",
  "mod+=": "zoom.in",
  "mod+-": "zoom.out",
  "mod+0": "zoom.reset",
  "mod+j": "sidecar.toggle",
  "mod+shift+d": "dock.toggle",
  "mod+shift+m": "simulator.toggle",
  "mod+shift+s": "capture.fullpage",
  "mod+f": "find.open",
  "mod+l": "address.focus",
  "mod+[": "tab.back",
  "mod+]": "tab.forward",
  "mod+shift+n": "workspace.new",
  "mod+shift+e": "workspace.edit",
  ...Object.fromEntries(WORKSPACE_SLOTS.map((n) => [`mod+${n}`, `workspace.jump.${n}`])),
};

export function chordOf(e: KeyboardEvent): string | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  const key = e.key.toLowerCase();
  if (key.length !== 1) return null;
  return `mod+${e.shiftKey ? "shift+" : ""}${key}`;
}
