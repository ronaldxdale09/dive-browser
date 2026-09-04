import { convertFileSrc, isTauri } from "@tauri-apps/api/core";

/**
 * Give Chromium a streamable URL for a finished capture. Unlike a blob URL,
 * the asset protocol supports media range reads without copying the complete
 * recording through IPC and base64 into renderer memory first.
 */
export function captureMediaUrl(path: string): string {
  return isTauri() ? convertFileSrc(path) : path;
}
