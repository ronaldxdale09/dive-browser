import { useEffect, useRef, useState } from "react";
import { Check, Copy, Plug, ShieldCheck, Terminal } from "lucide-react";
import type { AppInfo } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { copyText } from "../lib/clipboard";
import { Icon } from "./Icon";
import { ClaudeMark, CodexMark, CursorMark, WindsurfMark, ZedMark } from "./agent/AgentMarks";
import { useCoversContent } from "../lib/overlay";
import { useFadeClose } from "../lib/useFadeClose";
import { useFocusTrap } from "../lib/useFocusTrap";

/** These clients have documented skill installation; each still needs its own MCP connection. */
const AGENTS = [
  { name: "Claude Code", Mark: ClaudeMark },
  { name: "Codex", Mark: CodexMark },
  { name: "Cursor", Mark: CursorMark },
  { name: "OpenCode", Mark: Terminal },
  { name: "Zed", Mark: ZedMark },
  { name: "Windsurf", Mark: WindsurfMark },
] as const;

/** One setup request for the actual agent; only the explicit clipboard payload receives the token. */
export function instruction(url: string, tokenPath: string, token: string): string {
  return [
    "Set up the Dive skill and connect to my Dive browser:",
    "",
    "1. Install the dive skill in this project from https://github.com/ronaldxdale09/dive-skill:",
    "   npx skills add ronaldxdale09/dive-skill --skill dive",
    "   Select only the actual agent you are running, or append --agent <id>:",
    "   Claude Code: claude-code; Codex: codex; Cursor: cursor; OpenCode: opencode; Zed: zed; Windsurf: windsurf.",
    "   For an external agent inside an editor, use that agent's ID. Inspect an existing dive skill before replacing it.",
    "",
    "2. Separately register Dive in your own MCP configuration, preserving existing servers and settings. Use your client's supported Streamable HTTP configuration:",
    `   URL: ${url}`,
    `   Header: Authorization: Bearer ${token}`,
    `   Token file: ${tokenPath}`,
    "   Read the token file at runtime if your client supports it. Keep the token private. The MCP connector must run on this computer.",
    "",
    "3. Confirm the installed SKILL.md and its references, then reload skills and rediscover MCP tools (or start a new agent session if required). Call dive_capabilities and tabs_list to confirm the connection; report any setup step that still needs attention.",
  ].join("\n");
}

/** Install the browser workflow skill and connect the agent's local MCP client. */
export function McpDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const alive = useRef(true);
  useCoversContent(true);
  const root = useRef<HTMLDivElement>(null);
  const { close, className } = useFadeClose(onClose);
  useFocusTrap(root, { active: true, onEscape: close });

  useEffect(() => {
    let active = true;
    alive.current = true;
    Promise.all([ipc.appInfo(), ipc.mcpToken()])
      .then(([app, secret]) => {
        if (!active) return;
        setInfo(app);
        setToken(secret);
      })
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (copyState !== "copied") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const url = info?.mcp_url ?? "";
  const ready = !failed && Boolean(url) && Boolean(token?.trim());
  const loading = !failed && info === null;
  const missingToken = !failed && Boolean(url) && token !== null && !token.trim();
  const shown = ready ? instruction(url, info?.mcp_token_path ?? "", "••••••••••••") : "";
  const copyLabel = copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed · Retry" : copyState === "copying" ? "Copying…" : "Copy setup";

  const copySetup = async () => {
    if (!ready || !info || !token || copyState === "copying") return;
    setCopyState("copying");
    try {
      await copyText(instruction(url, info.mcp_token_path, token));
      if (alive.current) setCopyState("copied");
    } catch {
      if (alive.current) setCopyState("failed");
    }
  };

  return (
    <div className={`overlay-backdrop fixed inset-0 z-50 grid place-items-center ${className}`} onMouseDown={close}>
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-title"
        aria-describedby="mcp-description"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[calc(100dvh-32px)] w-[600px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-line-2 bg-surface shadow-2xl"
      >
        <div className="flex shrink-0 items-start gap-3 px-5 pt-5">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-highlight">
            <Icon icon={Plug} size={17} />
          </span>
          <div className="min-w-0">
            <h2 id="mcp-title" className="text-[15px] font-medium text-ink">Connect an agent</h2>
            <p id="mcp-description" className="mt-1 text-xs leading-relaxed text-ink-3">MCP gives your agent browser tools. The Dive skill teaches it how to use them.</p>
          </div>
        </div>

        <div className="min-h-0 overflow-y-auto px-5 pt-4 pb-4">
          <div className="flex flex-wrap items-center gap-2">
            {AGENTS.map(({ name, Mark }) => (
              <span key={name} title={name} className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2 py-1 text-[10.5px] text-ink-2">
                <span className="grid size-3.5 shrink-0 place-items-center text-ink">
                  <Mark size={14} />
                </span>
                {name}
              </span>
            ))}
          </div>

          <p className="mt-4 mb-2 text-xs text-ink-2">Paste this setup into your agent.</p>
          {loading && <p role="status" className="text-xs text-ink-3">Loading connection details…</p>}
          {failed && <p role="alert" className="text-xs text-danger">Dive could not read its own MCP details. Check Settings › Developer.</p>}
          {!failed && !url && info && <p role="status" className="text-xs text-ink-3">The MCP server is off in this window. It runs in normal windows, not private ones.</p>}
          {missingToken && <p role="alert" className="text-xs text-danger">The MCP token is unavailable. Check Settings › Developer.</p>}
          {ready && (
            <div className="overflow-hidden rounded-xl border border-line bg-surface-2">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
                <span id="mcp-setup-label" className="text-xs font-medium text-ink-2">Setup instructions</span>
                <button
                  type="button"
                  disabled={copyState === "copying"}
                  onClick={() => { void copySetup(); }}
                  className="inline-flex min-h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-line-2 bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlight disabled:opacity-60"
                >
                  <Icon icon={copyState === "copied" ? Check : Copy} size={13} />
                  {copyLabel}
                </button>
              </div>
              <pre aria-labelledby="mcp-setup-label" tabIndex={0} className="max-h-[280px] overflow-auto p-3 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-ink select-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-highlight"><code>{shown}</code></pre>
              {copyState === "copied" && <span role="status" className="sr-only">Setup copied to the clipboard</span>}
              {copyState === "failed" && <p role="alert" className="border-t border-line px-3 py-2 text-xs text-danger">Could not copy the setup. Try again.</p>}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-surface-2/60 px-5 py-3">
          <Icon icon={ShieldCheck} size={13} className="shrink-0 text-ink-3" />
          <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-ink-3">Local connection. Token required. Agent JavaScript is off by default.</p>
          <button type="button" onClick={close} className="shrink-0 rounded-full border border-line-2 px-4 py-1.5 text-xs text-ink hover:bg-surface-3">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
