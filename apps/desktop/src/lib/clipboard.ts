import { ipc } from "./ipc";

/**
 * Put text on the clipboard. The host does it, so it works whichever view
 * has focus; the page clipboard API is the fallback outside the app.
 */
export async function copyText(text: string): Promise<void> {
  try {
    await ipc.clipboardWriteText(text);
  } catch {
    await navigator.clipboard.writeText(text);
  }
}
