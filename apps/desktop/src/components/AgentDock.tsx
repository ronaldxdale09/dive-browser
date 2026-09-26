import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCoversContent } from "../lib/overlay";
import { isReady, useAgent } from "../store/agent";
import { tabInThisWindow, useBrowser } from "../store/browser";
import { usePrefs } from "../store/prefs";
import { IconButton } from "./Icon";
import { Setup } from "./agent/Setup";
import { Thread } from "./agent/Thread";

/**
 * The agent, docked over the page rather than beside it.
 *
 * A column took width from the page for the whole session, which is the wrong
 * trade for something used in bursts: you ask, you watch it work in the page,
 * you ask again. So it floats at the bottom of the window, the width of a
 * paragraph, and the page keeps its full size underneath. Nothing about it is
 * modal -- clicks outside it land on the page, as they should.
 *
 * The conversation grows upwards from the composer, capped so the page is
 * never more than half covered. `inset` is the width of the rail, so the dock
 * sits over the middle of the page rather than the middle of the window.
 */
export function AgentDock({ inset = 0 }: { inset?: number }) {
  const init = useAgent((s) => s.init);
  const refreshKeys = useAgent((s) => s.refreshKeys);
  const loaded = useAgent((s) => s.loaded);
  const initError = useAgent((s) => s.initError);
  const providers = useAgent((s) => s.providers);
  const keyed = useAgent((s) => s.keyed);
  const providerId = usePrefs((s) => s.prefs.agent_provider);
  const toggle = useBrowser((s) => s.toggle);
  const activeTab = useBrowser((s) => tabInThisWindow(s.activeTab, s.detached));
  const loadFor = useAgent((s) => s.loadFor);
  const settingsOpen = useBrowser((s) => s.open.settings);
  const [wantsSetup, setWantsSetup] = useState(false);
  const previousSettings = useRef(settingsOpen);
  useCoversContent(true);

  useEffect(() => void init(), [init]);
  // "Allow all this session" promises to last until the panel is closed, and
  // closing it is this unmounting -- by the toolbar, ⌘J or Escape alike.
  useEffect(() => () => useAgent.getState().setSessionAutoApprove(false), []);
  // Each tab keeps its own conversation, so moving between tabs brings the
  // one that belongs to the page in front of you -- and the one you left is
  // written back rather than lost.
  useEffect(() => void loadFor(activeTab), [activeTab, loadFor]);
  // A key added in Settings is the reason the agent was unusable a moment
  // ago, so the keys are read again when Settings closes -- not on open.
  useEffect(() => {
    if (previousSettings.current && !settingsOpen) void refreshKeys();
    previousSettings.current = settingsOpen;
  }, [settingsOpen, refreshKeys]);

  const provider = providers.find((p) => p.id === providerId);
  const ready = isReady(provider, keyed);
  const showSetup = loaded && (!ready || wantsSetup);

  return (
    // Centred on the page, not on the window: the rail is chrome, and the
    // agent belongs over the thing it is being asked about.
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[45] flex justify-center px-4 pb-4" style={{ paddingLeft: inset + 16 }}>
      <section
        aria-label="Agent"
        // Escape closes it, the way it closes every other floating surface.
        // It does not trap focus: the page underneath stays usable while the
        // agent is open, which is the whole point of docking it here.
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            toggle("sidecar", false);
          }
        }}
        className="animate-agent-slide-up pointer-events-auto flex max-h-[70vh] w-[min(760px,100%)] min-w-0 flex-col select-none"
      >
        {!loaded && (
          <div data-native-overlay role="status" aria-label="Loading agent" className="skeleton-enter rounded-[20px] border border-line-2 bg-surface/95 p-4 shadow-2xl backdrop-blur-xl">
            <div className="h-11 rounded-xl bg-surface-2" />
            <div className="mt-3 h-6 w-2/3 rounded-lg bg-surface-2/70" />
          </div>
        )}

        {loaded && initError && (
          <div data-native-overlay className="rounded-[20px] border border-line-2 bg-surface/95 p-4 text-xs shadow-2xl backdrop-blur-xl">
            <div className="flex items-start gap-3">
              <p role="alert" className="min-w-0 flex-1 text-ink-2">
                {initError}
              </p>
              <IconButton icon={X} label="Close agent" size={14} onClick={() => toggle("sidecar", false)} tooltipAlign="end" />
            </div>
            <button type="button" onClick={() => void init()} className="mt-3 h-8 rounded-full border border-line-2 px-3 text-ink hover:bg-surface-3">
              Retry loading agent
            </button>
          </div>
        )}

        {loaded && !initError && showSetup && (
          <div data-native-overlay className="flex max-h-[70vh] min-h-0 flex-col overflow-hidden rounded-[20px] border border-line-2 bg-surface/95 shadow-2xl backdrop-blur-xl">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
              <h2 className="text-xs font-semibold text-ink">Set up the agent</h2>
              <span className="flex-1" />
              <IconButton icon={X} label="Close agent" size={14} onClick={() => toggle("sidecar", false)} tooltipAlign="end" />
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <Setup canGoBack={ready} onDone={() => setWantsSetup(false)} />
            </div>
          </div>
        )}

        {loaded && !initError && !showSetup && <Thread onAddProvider={() => setWantsSetup(true)} />}
      </section>
    </div>
  );
}
