import { DEFAULT_START_URL } from "../lib/constants";
import { recordedToSteps, toPlaywrightSpec } from "../lib/playwright";
import { tabInThisWindow, useBrowser } from "../store/browser";
import { useRecorder } from "../store/recorder";
import { SpecModal } from "./SpecModal";

export function RecorderModal() {
  const isOpen = useRecorder((s) => s.isOpen);
  const setOpen = useRecorder((s) => s.setOpen);
  const steps = useRecorder((s) => s.steps);
  const startedAt = useRecorder((s) => s.startUrl);
  const startedOn = useRecorder((s) => s.startTitle);
  const clear = useRecorder((s) => s.clear);
  const tabs = useBrowser((s) => s.tabs);
  const activeTabId = useBrowser((s) => tabInThisWindow(s.activeTab, s.detached));

  if (!isOpen) return null;

  // The test starts where the recording did, not wherever the clicks led.
  const currentTab = tabs.find((t) => t.id === activeTabId);
  const startUrl = startedAt || currentTab?.url || DEFAULT_START_URL;
  const pageName = startedOn || currentTab?.title;
  const title = pageName ? `flow on ${pageName}` : "recorded flow";
  const kept = recordedToSteps(steps);

  return (
    <SpecModal
      title="Recorded Playwright Test"
      subtitle={`${kept.length} step${kept.length === 1 ? "" : "s"} captured`}
      spec={toPlaywrightSpec(kept, startUrl, title)}
      filename="recorded.spec.ts"
      onClose={() => setOpen(false)}
      footer={
        <button type="button" onClick={clear} className="text-[11px] text-ink-3 hover:text-ink hover:underline">
          Clear Steps
        </button>
      }
    />
  );
}
