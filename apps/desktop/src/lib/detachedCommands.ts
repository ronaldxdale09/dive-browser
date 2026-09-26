import { FIND_STEP, FOCUS_FIND } from "./commands";
import { ipc } from "./ipc";
import { errorMessage } from "./errors";
import { useBrowser } from "../store/browser";

function run(action: Promise<unknown>) {
  void action.catch((error: unknown) => useBrowser.setState({ error: errorMessage(error) }));
}

/**
 * Carry out a browser command in a detached window -- a torn-off tab, a ⌘N
 * window or an installed app's window -- for the one page it shows. Returns
 * false for a command the window has nothing to do with, so the caller can
 * leave the key alone.
 *
 * The native menu sends a focused detached window only the commands in
 * `POPOUT_COMMANDS` (menu.rs), and moves the keyboard to its chrome only for
 * those; the two lists have to agree, or a shortcut either goes nowhere or
 * takes the keyboard from the page for nothing. `focusAddress` is absent in
 * an app window, which has no address bar.
 */
export function runDetachedCommand(command: string, tabId: string, focusAddress?: () => void): boolean {
  const browser = useBrowser.getState();
  switch (command) {
    case "tab.close": run(ipc.tabClose(tabId)); return true;
    case "tab.reload": run(ipc.tabReload(tabId)); return true;
    case "tab.reloadHard": run(ipc.tabReloadHard(tabId)); return true;
    case "tab.back": run(ipc.tabBack(tabId)); return true;
    case "tab.forward": run(ipc.tabForward(tabId)); return true;
    case "tab.devtools": run(ipc.tabDevtools(tabId)); return true;
    case "zoom.in": void browser.zoomStep(1, tabId); return true;
    case "zoom.out": void browser.zoomStep(-1, tabId); return true;
    case "zoom.reset": void browser.zoomStep(0, tabId); return true;
    case "page.save": run(ipc.pageSave(tabId)); return true;
    case "find.open":
      browser.toggle("find", true);
      // An open bar does not remount; ⌘F again asks it for the keyboard.
      window.dispatchEvent(new CustomEvent(FOCUS_FIND));
      return true;
    case "find.next":
    case "find.prev":
      // Closed, the bar opens on the last search; open, it steps.
      if (!browser.open.find) browser.toggle("find", true);
      else window.dispatchEvent(new CustomEvent(FIND_STEP, { detail: { forward: command === "find.next" } }));
      return true;
    case "address.focus":
      if (!focusAddress) return false;
      focusAddress();
      return true;
    default: return false;
  }
}
