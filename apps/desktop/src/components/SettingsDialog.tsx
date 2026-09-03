import { Check, Copy, KeyRound, Plug, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ipc } from "../lib/ipc";
import type { AppInfo } from "../lib/ipc";
import { useAgent } from "../store/agent";
import { useBrowser } from "../store/browser";
import { Icon, IconButton } from "./Icon";

/** Settings: how to connect a coding agent over MCP, and the API key. */
export function SettingsDialog() {
  const toggle = useBrowser((s) => s.toggle);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const keyPresent = useAgent((s) => s.keyPresent);
  const checkKey = useAgent((s) => s.checkKey);
  const saveKey = useAgent((s) => s.saveKey);
  useEffect(() => {
    void ipc.appInfo().then(setInfo);
    void checkKey();
  }, [checkKey]);
  const close = () => toggle("settings", false);
  const command = info ? `claude mcp add --transport http dive ${info.mcp_url} --header "Authorization: Bearer $(cat '${info.mcp_token_path}')"` : "";

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" onMouseDown={close}>
      <div
        role="dialog"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
        className="mx-auto mt-24 w-[560px] rounded-2xl border border-line-2 bg-surface p-5 shadow-2xl"
      >
        <div className="flex items-center">
          <h2 className="text-sm font-semibold">Settings</h2>
          <span className="flex-1" />
          <IconButton icon={X} label="Close settings" onClick={close} />
        </div>

        <section className="mt-4">
          <h3 className="flex items-center gap-2 text-xs font-medium text-ink">
            <Icon icon={Plug} size={13} /> Coding agents (MCP)
          </h3>
          <p className="mt-1 text-xs text-ink-2">Claude Code, Cursor and Codex can read your tabs, console, network and screenshots. Run this once:</p>
          <CopyBlock text={command} />
          <p className="mt-1 text-[11px] text-ink-3">Only processes on this Mac with the token file can connect. Page scripts are never run unless you start Dive with DIVE_MCP_ALLOW_EVAL=1.</p>
        </section>

        <section className="mt-4">
          <h3 className="flex items-center gap-2 text-xs font-medium text-ink">
            <Icon icon={KeyRound} size={13} /> Anthropic API key
          </h3>
          <p className="mt-1 text-xs text-ink-2">
            {keyPresent ? "A key is stored in your keychain." : "No key stored. Add one in the Agent sidecar."}
          </p>
          {keyPresent && (
            <button type="button" onClick={() => void saveKey("")} className="mt-2 h-7 rounded-full border border-line px-3 text-xs text-ink-2 hover:bg-surface-2">
              Remove key
            </button>
          )}
        </section>

        {info && (
          <p className="mt-5 font-mono text-[10px] text-ink-3">
            Dive {info.version} · data in {info.data_dir}
          </p>
        )}
      </div>
    </div>
  );
}

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex items-start gap-2 rounded-lg border border-line bg-surface-2 p-2">
      <code className="min-w-0 flex-1 font-mono text-[11px] break-all text-ink select-text">{text || "…"}</code>
      <button
        type="button"
        aria-label="Copy command"
        disabled={!text}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="grid size-6 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-surface-3 hover:text-ink"
      >
        <Icon icon={copied ? Check : Copy} size={12} />
      </button>
    </div>
  );
}
