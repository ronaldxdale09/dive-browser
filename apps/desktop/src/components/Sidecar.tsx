import { Plus, Settings2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isReady, useAgent } from "../store/agent";
import { useBrowser } from "../store/browser";
import { usePrefs } from "../store/prefs";
import { IconButton } from "./Icon";
import { AgentIcon } from "./agent/AgentIcon";
import { Setup } from "./agent/Setup";
import { Thread } from "./agent/Thread";

/**
 * The agent's panel, docked to the right of the page: a header naming the
 * provider in use, then either the conversation or, until a provider is
 * ready, the setup screen.
 */
export function Sidecar() {
  const init = useAgent((s) => s.init);
  const refreshKeys = useAgent((s) => s.refreshKeys);
  const loaded = useAgent((s) => s.loaded);
  const initError = useAgent((s) => s.initError);
  const providers = useAgent((s) => s.providers);
  const keyed = useAgent((s) => s.keyed);
  const messages = useAgent((s) => s.messages);
  const busy = useAgent((s) => s.busy);
  const clear = useAgent((s) => s.clear);
  const providerId = usePrefs((s) => s.prefs.agent_provider);
  const settingsOpen = useBrowser((s) => s.open.settings);
  const toggle = useBrowser((s) => s.toggle);
  const openSettings = useBrowser((s) => s.openSettings);
  // The user may want to change or configure a provider even while ready
  const [wantsSetup, setWantsSetup] = useState(false);
  const previousSettings = useRef(settingsOpen);

  useEffect(() => void init(), [init]);
  useEffect(() => {
    if (previousSettings.current && !settingsOpen) void refreshKeys();
    previousSettings.current = settingsOpen;
  }, [settingsOpen, refreshKeys]);

  const provider = providers.find((p) => p.id === providerId);
  const ready = isReady(provider, keyed);
  const showSetup = loaded && (!ready || wantsSetup);

  return (
    <aside aria-label="Agent" className="flex min-h-0 flex-col bg-surface select-none">
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
          <AgentIcon size={14} className="text-highlight shrink-0" />
          <h2 className="text-xs font-semibold text-ink">Agent</h2>

          {ready && provider && !showSetup && (
            <span className="flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-ink-3">
              <span className="size-1.5 rounded-full bg-highlight" />
              <span className="max-w-[100px] truncate">{provider.name}</span>
            </span>
          )}

          <span className="flex-1" />

          {!showSetup && (
            <>
              <IconButton
                icon={Plus}
                label="New conversation"
                size={14}
                disabled={busy || messages.length === 0}
                onClick={clear}
              />
              <IconButton
                icon={Settings2}
                label="Agent settings"
                size={14}
                onClick={() => openSettings("agent")}
              />
            </>
          )}
          <IconButton icon={X} label="Close agent" size={14} onClick={() => toggle("sidecar", false)} tooltipAlign="end" />
      </div>

      {!loaded && (
        <div role="status" aria-label="Loading agent" className="skeleton-enter flex flex-1 flex-col gap-3 p-3">
          <div className="h-20 rounded-xl bg-surface-2" />
          <div className="h-12 rounded-xl bg-surface-2/70" />
          <div className="mt-auto h-20 rounded-xl border border-line bg-surface-2/50" />
        </div>
      )}
      {loaded && initError && <div className="p-4 text-sm text-ink-2"><p role="alert">{initError}</p><button type="button" onClick={() => void init()} className="mt-3 min-h-9 rounded-lg border border-line-2 px-3 text-ink hover:bg-surface-3">Retry loading agent</button></div>}
      {loaded && !initError && showSetup && <Setup canGoBack={ready} onDone={() => setWantsSetup(false)} />}
      {loaded && !initError && !showSetup && <Thread onAddProvider={() => setWantsSetup(true)} />}
    </aside>
  );
}
