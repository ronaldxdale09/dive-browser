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

export function buildEditorUri(editor: string, file: string, line = 1, column = 1): string {
  const scheme = editor === "cursor" ? "cursor" : editor === "zed" ? "zed" : "vscode";
  let clean = file.replace(/^file:\/\//, "");
  clean = clean.replace(/[?#].*$/, "");
  if (!clean.startsWith("/")) clean = "/" + clean;
  return `${scheme}://file${clean}:${line}:${column}`;
}

/**
 * Resolves original file location using source maps when available and opens in the editor.
 */
export async function jumpToSource(
  tabId: string | null | undefined,
  url: string | null | undefined,
  line: number | null | undefined,
  column: number | null | undefined,
  preferredEditor: string
) {
  if (!url) return;

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

  const uri = buildEditorUri(preferredEditor, filePath, targetLine, targetCol);
  const link = document.createElement("a");
  link.href = uri;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
