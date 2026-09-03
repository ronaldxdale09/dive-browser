import { useState } from "react";
import { useBrowser } from "../store/browser";

export function Toolbar() {
  const tabs = useBrowser((s) => s.tabs);
  const activeTab = useBrowser((s) => s.activeTab);
  const navigate = useBrowser((s) => s.navigate);
  const toggle = useBrowser((s) => s.toggle);
  const open = useBrowser((s) => s.open);
  const current = tabs.find((t) => t.id === activeTab);
  // Reset the draft whenever the active tab's URL changes (adjust-state-during-render).
  const url = current?.url ?? "";
  const [draft, setDraft] = useState({ url, value: url });
  if (draft.url !== url) setDraft({ url, value: url });
  const value = draft.value;
  const setValue = (v: string) => setDraft({ url, value: v });

  return (
    <div className="flex h-full items-center gap-2 px-2">
      <form
        className="flex min-w-0 flex-1 items-center"
        onSubmit={(e) => {
          e.preventDefault();
          void navigate(value);
        }}
      >
        <input
          aria-label="Address"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          placeholder="Search or enter address"
          spellCheck={false}
          className="h-7 w-full rounded-md border border-line bg-ground px-3 font-mono text-xs text-ink outline-none placeholder:text-ink-3 focus:border-accent"
        />
      </form>
      <ToolButton label="Tools" active={open.dock} onClick={() => toggle("dock")} />
      <ToolButton label="Agent" active={open.sidecar} onClick={() => toggle("sidecar")} />
    </div>
  );
}

function ToolButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="h-7 rounded-md border border-line px-2.5 text-xs text-ink-2 hover:bg-surface-2 aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-white"
    >
      {label}
    </button>
  );
}
