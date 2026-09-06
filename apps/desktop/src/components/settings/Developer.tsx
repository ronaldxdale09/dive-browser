import type { AppInfo } from "../../lib/ipc";
import { Group, Row, Select, Switch } from "../SettingsFields";
import { CopyBlock } from "./CopyBlock";
import { usePref } from "./usePref";

/** Settings › Developer: DevTools, editor and the MCP hookup. */
export function Developer({ info }: { info: AppInfo | null }) {
  const [prefs, set] = usePref();
  const command = info ? `claude mcp add --transport http dive ${info.mcp_url} --header "Authorization: Bearer $(cat '${info.mcp_token_path}')"` : "";
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
          <CopyBlock text={command} />
          <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
            Only processes on this Mac with the token file can connect. Page scripts are never run unless you start Dive with DIVE_MCP_ALLOW_EVAL=1.
          </p>
        </div>
      </Group>
    </>
  );
}
