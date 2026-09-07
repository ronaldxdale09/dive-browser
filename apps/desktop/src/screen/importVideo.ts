import { create } from "zustand";
import { screenUrl } from "../components/internal/InternalPage";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";

/**
 * "Open video…": ask for a file, let the engine copy it into the captures
 * directory and make its playable companion, then open it in a DiveScreen
 * tab. One import runs at a time; every entry point shares the busy state.
 */

export const IMPORT_BUSY = "Importing video… this can take a moment for long files";

interface ImportState {
  busy: boolean;
  /** Show the picker and open the imported file. Resolves to the new path, or null when dismissed or failed. */
  open: (onOpened?: () => void) => Promise<string | null>;
}

export const useImportVideo = create<ImportState>((set, get) => ({
  busy: false,
  open: async (onOpened) => {
    if (get().busy) return null;
    set({ busy: true });
    try {
      const path = await ipc.screenImportVideo();
      if (!path) return null;
      onOpened?.();
      await useBrowser.getState().openTab(screenUrl(path));
      return path;
    } catch (cause) {
      useBrowser.setState({ error: `Could not open the video: ${cause instanceof Error ? cause.message : String(cause)}` });
      return null;
    } finally {
      set({ busy: false });
    }
  },
}));
