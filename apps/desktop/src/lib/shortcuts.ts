import { useEffect } from "react";
import { flushSync } from "react-dom";
import { events } from "./ipc";
import { selectAllInChromeField } from "./chromeEditing";
import { isMac, runCommand, shortcutFor } from "./commands";
import { contentCoverDepth } from "./overlay";
import { useBrowser } from "../store/browser";

/**
 * Global key chords, routed through the shared command dispatcher.
 *
 * DOM chords, native menu commands, and the direct CEF New Tab handoff share
 * the same command policy. The direct handoff is emitted only into the trusted
 * main chrome; a page cannot dispatch an event into another WebContents.
 */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || selectAllInChromeField(e, isMac())) return;
      const id = shortcutFor(e);
      if (!id) return;
      // Escape belongs to whatever is open on top of the page. Anything that
      // floats over content registers as covering it, and handles Escape
      // itself; only when nothing does is the key free to stop a load. Without
      // this the key would both close a dialog and stop the page behind it.
      if (id === "tab.stop" && e.key === "Escape") {
        const { activeTab, loading } = useBrowser.getState();
        if (contentCoverDepth() > 0 || !activeTab || !loading[activeTab]) return;
      }
      e.preventDefault();
      runCommand(id, "keyboard");
    };
    const onNativeNewTab = () => {
      // Commit the eager launcher before the next renderer input event. Native
      // code submits this fixed event before transferring keyboard focus here.
      flushSync(() => runCommand("tab.new", "native-menu"));
    };
    const onNativeFocusAddress = () => runCommand("address.focus", "native-menu");
    window.addEventListener("dive-native-focus-address", onNativeFocusAddress);
    window.addEventListener("keydown", onKey);
    window.addEventListener("dive-native-new-tab", onNativeNewTab);
    return () => {
      window.removeEventListener("dive-native-focus-address", onNativeFocusAddress);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("dive-native-new-tab", onNativeNewTab);
    };
  }, []);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let live = true;
    void events.menuCommand.listen((e) => runCommand(e.payload, "native-menu")).then((un) => {
      if (live) stop = un;
      else un();
    });
    return () => {
      live = false;
      stop?.();
    };
  }, []);
}
