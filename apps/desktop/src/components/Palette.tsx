import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { ipc } from "../lib/ipc";
import type { Command as CommandDef } from "../lib/ipc";
import { useBrowser } from "../store/browser";

/** Omnibox-style palette: type a URL or search, or pick a command. */
export function Palette() {
  const toggle = useBrowser((s) => s.toggle);
  const openTab = useBrowser((s) => s.openTab);
  const tabs = useBrowser((s) => s.tabs);
  const activateTab = useBrowser((s) => s.activateTab);
  const [query, setQuery] = useState("");
  const [cmds, setCmds] = useState<CommandDef[]>([]);
  useEffect(() => {
    void ipc.commandsList().then(setCmds);
  }, []);

  const close = () => toggle("palette", false);
  const go = async (url: string) => {
    close();
    await openTab(url);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/20" onMouseDown={close}>
      <Command
        label="Command palette"
        className="mx-auto mt-24 w-[560px] overflow-hidden rounded-lg border border-line-2 bg-surface shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        <Command.Input
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder="Search, enter a URL, or run a command"
          className="h-11 w-full border-b border-line bg-transparent px-4 text-sm outline-none placeholder:text-ink-3"
        />
        <Command.List className="max-h-80 overflow-auto p-1 text-xs">
          {query.trim() && (
            <Command.Item value={`open ${query}`} onSelect={() => void go(query)} className="rounded px-3 py-2 data-[selected=true]:bg-accent-soft">
              Open <span className="font-mono text-ink-2">{query}</span>
            </Command.Item>
          )}
          {tabs.length > 0 && (
            <Command.Group heading="Tabs" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-3">
              {tabs.map((t) => (
                <Command.Item key={t.id} value={`${t.title} ${t.url}`} onSelect={() => { close(); void activateTab(t.id); }} className="truncate rounded px-3 py-2 data-[selected=true]:bg-accent-soft">
                  {t.title || t.url}
                </Command.Item>
              ))}
            </Command.Group>
          )}
          <Command.Group heading="Commands" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-3">
            {cmds.map((c) => (
              <Command.Item key={c.id} value={`${c.title} ${c.id}`} onSelect={() => { close(); runUi(c.id); }} className="flex justify-between rounded px-3 py-2 data-[selected=true]:bg-accent-soft">
                <span>{c.title}</span>
                {c.keybinding && <kbd className="font-mono text-[10px] text-ink-3">{c.keybinding.replace("mod", "⌘")}</kbd>}
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}

/** Commands whose effect lives in the chrome are dispatched here; others go to Rust. */
function runUi(id: string) {
  const { toggle, closeTab, activeTab } = useBrowser.getState();
  switch (id) {
    case "palette.open": toggle("palette", true); break;
    case "sidecar.toggle": toggle("sidecar"); break;
    case "dock.toggle": toggle("dock"); break;
    case "tab.new": toggle("palette", true); break;
    case "tab.close": if (activeTab) void closeTab(activeTab); break;
    default: void ipc.commandRun(id);
  }
}
