import { Plus, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { isReady, useAgent } from "../store/agent";
import { useBrowser } from "../store/browser";
import { usePrefs } from "../store/prefs";
import { IconButton } from "./Icon";
import { AgentIcon } from "./agent/AgentIcon";
import { Setup } from "./agent/Setup";
import { Thread } from "./agent/Thread";

/**
 * Right-docked agent panel.
 * Designed with OpenAI & Anthropic polish:
 * - Bespoke Agent icon with radiant soft mint container
 * - Live model & readiness indicator
 * - Seamless conversation and step timeline
 * - Integrated animated onboarding and key management
 */
export function Sidecar() {
  const init = useAgent((s) => s.init);
  const refreshKeys = useAgent((s) => s.refreshKeys);
  const loaded = useAgent((s) => s.loaded);
  const providers = useAgent((s) => s.providers);
  const keyed = useAgent((s) => s.keyed);
  const messages = useAgent((s) => s.messages);
  const busy = useAgent((s) => s.busy);
  const clear = useAgent((s) => s.clear);
  const providerId = usePrefs((s) => s.prefs.agent_provider);
  const settingsOpen = useBrowser((s) => s.open.settings);
  const toggle = useBrowser((s) => s.toggle);
  // The user may want to change or configure a provider even while ready
  const [wantsSetup, setWantsSetup] = useState(false);

  useEffect(() => void init(), [init]);
  useEffect(() => {
    if (!settingsOpen) void refreshKeys();
  }, [settingsOpen, refreshKeys]);

  const provider = providers.find((p) => p.id === providerId);
  const ready = isReady(provider, keyed);
  const showSetup = loaded && (!ready || wantsSetup);

  return (
    <aside aria-label="Agent" className="flex min-h-0 flex-col bg-surface select-none">
      {/* Header */}
      {(!showSetup || !ready) && (
        <div className="flex h-10 items-center gap-2 border-b border-line px-3 shrink-0">
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
                onClick={() => toggle("settings", true)}
              />
            </>
          )}
        </div>
      )}

      {!loaded && <div className="flex-1" />}
      {loaded && showSetup && <Setup canGoBack={ready} onDone={() => setWantsSetup(false)} />}
      {loaded && !showSetup && <Thread onAddProvider={() => setWantsSetup(true)} />}
    </aside>
  );
}
