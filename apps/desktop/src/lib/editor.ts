import { ipc } from "./ipc";

export function editorLabel(editor: string): string {
  switch (editor) {
    case "cursor":
      return "Cursor";
    case "zed":
      return "Zed";
    default:
      return "VS Code";
  }
}

/**
 * The local path an editor can open, or null when the location is a served
 * URL (http, data, blob…) that no source map brought back to disk. An editor
 * given such a URL as a path opens nothing, or an empty file, without a word.
 */
export function localPath(file: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(file) && !file.startsWith("file://")) return null;
  const clean = file.replace(/^file:\/\//, "").replace(/[?#].*$/, "");
  // A path relative to some project root the map did not name is not one
  // an editor can open; guessing "/" in front of it opened nothing before.
  return clean.startsWith("/") ? clean : null;
}

export function buildEditorUri(editor: string, file: string, line = 1, column = 1): string {
  const scheme = editor === "cursor" ? "cursor" : editor === "zed" ? "zed" : "vscode";
  const clean = localPath(file) ?? file;
  return `${scheme}://file${clean}:${line}:${column}`;
}

export type JumpResult = { opened: true; uri: string } | { opened: false; reason: string };

/**
 * Resolves original file location using source maps when available and opens in the editor.
 */
export async function jumpToSource(
  tabId: string | null | undefined,
  url: string | null | undefined,
  line: number | null | undefined,
  column: number | null | undefined,
  preferredEditor: string
): Promise<JumpResult> {
  if (!url) return { opened: false, reason: "That entry has no source location." };

  let filePath = url;
  let targetLine = line ?? 1;
  let targetCol = column ?? 1;

  if (tabId && line) {
    try {
      const resolved = await ipc.resolveFrame(tabId, url, line, column ?? 1);
      if (resolved) {
        filePath = resolved.source;
        targetLine = resolved.line;
        targetCol = resolved.column;
      }
    } catch {
      // Fall back to url
    }
  }

  if (localPath(filePath) === null) {
    const host = (() => {
      try {
        return new URL(filePath).host || filePath;
      } catch {
        return filePath;
      }
    })();
    return { opened: false, reason: `No local file for ${host}: nothing maps it back to disk. Serve the page with source maps, or open its folder in ${editorLabel(preferredEditor)}.` };
  }
  const uri = buildEditorUri(preferredEditor, filePath, targetLine, targetCol);
  const link = document.createElement("a");
  link.href = uri;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  return { opened: true, uri };
}
