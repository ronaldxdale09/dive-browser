import { Plus, Settings2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { isReady, useAgent } from "../store/agent";
import { useBrowser } from "../store/browser";
import { usePrefs } from "../store/prefs";
import { IconButton } from "./Icon";
import { Setup } from "./agent/Setup";
import { Thread } from "./agent/Thread";

/**
 * Right-docked agent panel. One surface: the conversation, with the model's
 * steps inline, and a provider/key setup that takes over only while the
 * selected provider cannot be used yet.
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
  // The person may add a provider in Settings while the panel is open.
  const [wantsSetup, setWantsSetup] = useState(false);

  useEffect(() => void init(), [init]);
  useEffect(() => {
    if (!settingsOpen) void refreshKeys();
  }, [settingsOpen, refreshKeys]);

  const provider = providers.find((p) => p.id === providerId);
  const ready = isReady(provider, keyed);
  const showSetup = loaded && (!ready || wantsSetup);

  return (
    <aside aria-label="Agent" className="flex min-h-0 flex-col bg-surface">
      <div className="flex h-10 items-center gap-2 border-b border-line px-3">
        <span className="grid size-6 place-items-center rounded-lg bg-highlight-soft text-highlight">
          <Sparkles size={13} strokeWidth={1.75} absoluteStrokeWidth aria-hidden />
        </span>
        <h2 className="text-xs font-semibold text-ink">Agent</h2>
        <span className="flex-1" />
        <IconButton icon={Plus} label="New conversation" size={14} disabled={busy || messages.length === 0} onClick={clear} />
        <IconButton icon={Settings2} label="Agent settings" size={14} onClick={() => toggle("settings", true)} />
      </div>
      {!loaded && <div className="flex-1" />}
      {loaded && showSetup && <Setup canGoBack={ready} onDone={() => setWantsSetup(false)} />}
      {loaded && !showSetup && <Thread onAddProvider={() => setWantsSetup(true)} />}
    </aside>
  );
}
