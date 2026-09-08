import { useEffect, useState } from "react";
import { ipc } from "../../lib/ipc";
import type { AppInfo } from "../../lib/ipc";
import { Group, Row, Select, Switch } from "../SettingsFields";
import { CopyBlock } from "./CopyBlock";
import { usePref } from "./usePref";

/** The `claude mcp add` line for this build, with the token read from `tokenPath`. */
export function mcpCommand(info: Pick<AppInfo, "mcp_url">, tokenPath: string): string {
  return `claude mcp add --transport http dive ${info.mcp_url} --header "Authorization: Bearer $(cat '${tokenPath}')"`;
}

/**
 * The `mcpServers` entry Cursor (and any client configured by JSON) needs.
 * The token has to be inline there, so `token` is the real value for the
 * clipboard and a masked one for the screen.
 */
export function cursorConfig(info: Pick<AppInfo, "mcp_url">, token: string): string {
  return JSON.stringify({ mcpServers: { dive: { url: info.mcp_url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
}

/** The token path as the block shows it: just the file, so the command fits on a line or two. */
export function shortTokenPath(path: string): string {
  const name = path.split("/").filter(Boolean).pop();
  return name ? `…/${name}` : path;
}

/** Settings › Developer: DevTools, editor and the MCP hookup. */
export function Developer({ info }: { info: AppInfo | null }) {
  const [prefs, set] = usePref();
  const command = info ? mcpCommand(info, info.mcp_token_path) : "";
  const shown = info ? mcpCommand(info, shortTokenPath(info.mcp_token_path)) : "";
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    ipc
      .mcpToken()
      .then((t) => alive && setToken(t))
      .catch(() => alive && setToken(null));
    return () => {
      alive = false;
    };
  }, []);
  return (
    <>
      <Group title="Tabs">
        <Row
          label="Open DevTools with new tabs"
          hint="Every tab opens with the Chromium inspector already attached."
          control={<Switch label="Open DevTools with new tabs" checked={prefs.devtools_on_open} onChange={(devtools_on_open) => set({ devtools_on_open })} />}
        />
      </Group>

      <Group title="Editor" description="Choose the editor to open when clicking source files or stack traces.">
        <Row
          label="Preferred editor"
          htmlFor="pref-editor"
          hint="Used for Jump-to-Source in console errors and element inspections."
          control={
            <Select
              id="pref-editor"
              label="Preferred editor"
              value={prefs.preferred_editor || "vscode"}
              onChange={(preferred_editor) => set({ preferred_editor })}
              options={[
                { value: "vscode", label: "VS Code (vscode://)" },
                { value: "cursor", label: "Cursor (cursor://)" },
                { value: "zed", label: "Zed (zed://)" },
              ]}
            />
          }
        />
      </Group>

      <Group title="Coding agents (MCP)" description="Claude Code, Cursor and Codex can read your tabs, console, network and screenshots. Run this once:">
        <div className="py-3">
          <CopyBlock text={command} display={info ? shown : undefined} />
          {info && token && (
            <>
              <p className="mt-3 mb-1.5 text-[11px] text-ink-2">Cursor, and any client set up with JSON: add this to its mcp.json (Cursor keeps it at ~/.cursor/mcp.json).</p>
              <CopyBlock text={cursorConfig(info, token)} label="Copy mcp.json entry" display={cursorConfig(info, "••••••••")} />
            </>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
            Only processes on this Mac with the token file can connect. Page scripts are never run unless you start Dive with DIVE_MCP_ALLOW_EVAL=1.
          </p>
        </div>
      </Group>
    </>
  );
}
