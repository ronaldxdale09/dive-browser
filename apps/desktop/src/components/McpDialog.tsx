import { useEffect, useRef, useState } from "react";
import { Plug, ShieldCheck } from "lucide-react";
import type { AppInfo } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { Icon } from "./Icon";
import { CopyBlock } from "./settings/CopyBlock";
import { ClaudeMark, CodexMark, CursorMark, WindsurfMark, ZedMark } from "./agent/AgentMarks";
import { useCoversContent } from "../lib/overlay";
import { useFadeClose } from "../lib/useFadeClose";
import { useFocusTrap } from "../lib/useFocusTrap";

/** The agents whose marks the dialog shows. Any MCP client works; these are the ones people ask about. */
const AGENTS = [
  { name: "Claude Code", Mark: ClaudeMark },
  { name: "Cursor", Mark: CursorMark },
  { name: "Codex", Mark: CodexMark },
  { name: "Windsurf", Mark: WindsurfMark },
  { name: "Zed", Mark: ZedMark },
] as const;

/**
 * The one thing to copy: an instruction addressed to the agent, not to the
 * person.
 *
 * Every harness registers MCP servers differently, and a dialog that made the
 * person pick their client first was asking them to do the agent's job. This
 * says what the endpoint is and what to do with it, and leaves the agent to
 * write its own config -- which is the one thing every one of them is good at.
 *
 * The token is inline because the agent has to send it, and the file path is
 * given as well so a harness that can read files need never hold the secret.
 */
export function instruction(url: string, tokenPath: string, token: string): string {
  return [
    "Add the Dive browser to yourself as an MCP server, then use it to drive my browser.",
    "",
    "It speaks MCP over streamable HTTP on this machine:",
    `  URL:    ${url}`,
    `  Header: Authorization: Bearer ${token}`,
    `  (the token is also in ${tokenPath}, if you would rather read it at run time)`,
    "",
    "Register it however your own configuration works — for example:",
    `  • Claude Code:  claude mcp add --transport http dive ${url} --header "Authorization: Bearer $(cat '${tokenPath}')"`,
    "  • Cursor:       an entry under mcpServers in ~/.cursor/mcp.json, with url and an Authorization header",
    "  • Codex:        an [mcp_servers.dive] table in ~/.codex/config.toml, with url and bearer_token",
    "  • anything else: whatever your harness calls a remote/HTTP MCP server",
    "",
    "Then list your MCP tools and tell me which ones Dive gave you.",
    "It exposes the open tabs, navigation, clicks and typing, the DOM, the console and the network log.",
  ].join("\n");
}

/**
 * How to give an agent this browser.
 *
 * Dive already serves MCP on the loopback interface; connecting is only ever
 * a matter of telling one client where to look and handing it the token. So
 * the dialog holds a single block, written at the agent, and the agent
 * installs itself.
 */
export function McpDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useCoversContent(true);
  const root = useRef<HTMLDivElement>(null);
  const { close, className } = useFadeClose(onClose);
  useFocusTrap(root, { active: true, onEscape: close });

  useEffect(() => {
    let alive = true;
    Promise.all([ipc.appInfo(), ipc.mcpToken()])
      .then(([app, secret]) => {
        if (!alive) return;
        setInfo(app);
        setToken(secret);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  const url = info?.mcp_url ?? "";
  const ready = Boolean(url) && token !== null;
  const text = ready ? instruction(url, info?.mcp_token_path ?? "", token ?? "") : "";
  // The block is read on screen and pasted into a chat, so the secret is
  // masked here and whole on the clipboard.
  const shown = ready ? instruction(url, info?.mcp_token_path ?? "", "••••••••••••") : "";

  return (
    <div className={`overlay-backdrop fixed inset-0 z-50 grid place-items-center ${className}`} onMouseDown={close}>
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-title"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[600px] max-w-[92vw] overflow-hidden rounded-2xl border border-line-2 bg-surface shadow-2xl"
      >
        <div className="flex items-start gap-3 px-5 pt-5">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-highlight">
            <Icon icon={Plug} size={17} />
          </span>
          <div className="min-w-0">
            <h2 id="mcp-title" className="text-[15px] font-medium text-ink">Connect an agent</h2>
            <p className="mt-0.5 text-xs text-ink-3">Paste this into any coding agent. It sets itself up and then drives this browser.</p>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 px-5">
          {AGENTS.map(({ name, Mark }) => (
            <span key={name} title={name} className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2 py-1 text-[10.5px] text-ink-2">
              <span className="grid size-3.5 shrink-0 place-items-center text-ink">
                <Mark size={14} />
              </span>
              {name}
            </span>
          ))}
        </div>

        <div className="px-5 pt-3 pb-4">
          {failed && <p role="alert" className="text-xs text-danger">Dive could not read its own MCP details. Check Settings › Developer.</p>}
          {!failed && !url && info && <p className="text-xs text-ink-3">The MCP server is off in this window. It runs in normal windows, not private ones.</p>}
          {ready && (
            <CopyBlock
              text={text}
              label="Copy instruction"
              display={<span className="block max-h-[260px] overflow-y-auto whitespace-pre-wrap">{shown}</span>}
            />
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-line bg-surface-2/60 px-5 py-3">
          <Icon icon={ShieldCheck} size={13} className="shrink-0 text-ink-3" />
          <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-ink-3">
            Loopback only, and only for processes on this Mac holding the token. Page scripts never run unless Dive is started with DIVE_MCP_ALLOW_EVAL=1.
          </p>
          <button type="button" onClick={close} className="shrink-0 rounded-full border border-line-2 px-4 py-1.5 text-xs text-ink hover:bg-surface-3">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
