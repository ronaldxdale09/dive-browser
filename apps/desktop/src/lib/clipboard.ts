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

/**
 * Put a secret on the clipboard: hidden from clipboard managers' history and
 * cleared again after 30 seconds unless something else was copied since.
 * There is deliberately no fallback to the page clipboard API, which can do
 * neither; a secret that cannot be copied safely is not copied.
 */
export async function copySecret(text: string): Promise<void> {
  await ipc.clipboardWriteSecret(text);
}
