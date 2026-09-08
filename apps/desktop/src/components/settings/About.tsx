import { ArrowDownToLine, Check as CheckIcon, RotateCcw } from "lucide-react";
import { useState } from "react";
import type { AppInfo } from "../../lib/ipc";
import { useBrowser } from "../../store/browser";
import { useOnboarding } from "../../store/onboarding";
import { useUpdates } from "../../store/updates";
import { Icon } from "../Icon";
import { Button, Group, Row } from "../SettingsFields";
import { CopyBlock } from "./CopyBlock";

/** "Chromium 151 · CEF" from the chrome's own user agent; the engine is what runs this very page. */
export function engineLabel(userAgent: string = navigator.userAgent): string {
  const major = /Chrome\/(\d+)/.exec(userAgent)?.[1];
  return major ? `Chromium ${major} · CEF` : "CEF";
}

/** Settings › About: build facts and the updater. */
export function About({ info }: { info: AppInfo | null }) {
  return (
    <>
      <Group title="This build">
        <Row label="Version" control={<span className="font-mono text-[11px] text-ink-2 select-text">{info?.version ?? "…"}</span>} />
        <Row label="Engine" hint="Chromium through CEF, one process tree per container." control={<span className="font-mono text-[11px] text-ink-2 select-text">{engineLabel()}</span>} />
        <Row
          stacked
          label="Data folder"
          hint="Profiles, history, bookmarks, captures and preferences."
          control={<code className="block font-mono text-[11px] break-all text-ink-2 select-text">{info?.data_dir ?? "…"}</code>}
        />
        <Row
          stacked
          label="MCP endpoint"
          hint={info?.mcp_url ? "Coding agents on this Mac connect here; the Developer section has the full command." : "Disabled in this build."}
          control={info?.mcp_url ? <CopyBlock text={info.mcp_url} label="Copy MCP URL" /> : <code className="block font-mono text-[11px] text-ink-2">disabled</code>}
        />
      </Group>
      <Updates channel={info?.build.channel ?? null} />
      <StartOver />
    </>
  );
}

/**
 * Back to the first launch: the intro plays and the setup steps run again.
 * Nothing is deleted; the steps edit the profile and workspace already here.
 */
function StartOver() {
  const replay = useOnboarding((s) => s.replay);
  const toggle = useBrowser((s) => s.toggle);
  const [confirming, setConfirming] = useState(false);
  return (
    <Group title="Start over">
      <Row
        label="Reset Dive"
        hint="Play the intro and walk through setup again. Your tabs, history, profiles and workspaces stay."
        control={
          confirming ? (
            <span className="flex items-center gap-2">
              <Button variant="quiet" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  toggle("settings", false);
                  void replay();
                }}
              >
                <span className="inline-flex items-center gap-1.5">
                  <Icon icon={RotateCcw} size={12} /> Reset and replay
                </span>
              </Button>
            </span>
          ) : (
            <Button variant="quiet" onClick={() => setConfirming(true)}>
              Reset Dive…
            </Button>
          )
        }
      />
    </Group>
  );
}

/**
 * Check for a newer build and install it. A dev build has no updater to
 * speak to, so it says where updates go instead of pretending to look.
 */
function Updates({ channel }: { channel: string | null }) {
  const dev = channel === "dev";
  const status = useUpdates((s) => s.status);
  const update = useUpdates((s) => s.update);
  const error = useUpdates((s) => s.error);
  const installing = useUpdates((s) => s.installing);
  const check = useUpdates((s) => s.check);
  const install = useUpdates((s) => s.install);
  return (
    <Group title="Updates">
      <Row
        label={status === "available" && update ? `Dive ${update.version} is available` : "Check for updates"}
        hint={
          status === "available" ? (
            update?.notes ? <span className="block whitespace-pre-wrap">{update.notes}</span> : "Installing restarts Dive."
          ) : dev ? (
            "Updates are delivered to release builds."
          ) : status === "none" ? (
            "You're up to date."
          ) : status === "error" ? (
            <span className="text-danger">{error}</span>
          ) : (
            "Dive checks once shortly after launch."
          )
        }
        control={
          status === "available" ? (
            <Button variant="primary" disabled={installing} onClick={() => void install()}>
              {installing ? "Installing…" : "Install and restart"}
            </Button>
          ) : dev ? null : (
            <Button variant="quiet" disabled={status === "checking"} onClick={() => void check()}>
              {status === "checking" ? "Checking…" : status === "none" ? "Check again" : "Check for updates"}
            </Button>
          )
        }
      />
      {status === "none" && !dev && (
        <p role="status" className="flex items-center gap-1.5 py-2.5 text-[11px] text-ink-2">
          <Icon icon={CheckIcon} size={12} className="text-highlight" /> You're up to date
        </p>
      )}
      {status === "available" && (
        <p role="status" className="flex items-center gap-1.5 py-2.5 text-[11px] text-ink-2">
          <Icon icon={ArrowDownToLine} size={12} className="text-highlight" /> Update available: {update?.version}
        </p>
      )}
    </Group>
  );
}
