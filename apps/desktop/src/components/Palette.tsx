import { Command } from "cmdk";
import { ArrowUpRight, Globe, Search, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { ipc } from "../lib/ipc";
import { runCommand } from "../lib/commands";
import type { Command as CommandDef } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { Icon } from "./Icon";

/** Omnibox-style palette: type a URL or search, or pick a tab or command. */
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
  const looksLikeUrl = /^[\w-]+(\.[\w-]+)+|^localhost|^https?:\/\//i.test(query.trim());

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" onMouseDown={close}>
      <Command
        label="Command palette"
        shouldFilter={!!query}
        className="mx-auto mt-24 w-[600px] overflow-hidden rounded-2xl border border-line-2 bg-surface shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Icon icon={Search} size={15} className="text-ink-3" />
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Search, enter a URL, or run a command"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
        </div>
        <Command.List className="max-h-80 overflow-auto p-1.5 text-xs">
          {query.trim() && (
            <Command.Item value={`open ${query}`} onSelect={() => void go(query)} className="flex items-center gap-2 rounded-lg px-3 py-2">
              <Icon icon={looksLikeUrl ? ArrowUpRight : Search} size={14} className="text-ink-3" />
              <span className="text-ink-2">{looksLikeUrl ? "Open" : "Search"}</span>
              <span className="truncate font-mono text-ink">{query}</span>
            </Command.Item>
          )}
          {tabs.length > 0 && (
            <Command.Group heading="Tabs">
              {tabs.map((t) => (
                <Command.Item
                  key={t.id}
                  value={`${t.title} ${t.url}`}
                  onSelect={() => {
                    close();
                    void activateTab(t.id);
                  }}
                  className="flex items-center gap-2 rounded-lg px-3 py-2"
                >
                  <Icon icon={Globe} size={14} className="shrink-0 text-ink-3" />
                  <span className="truncate">{t.title || t.url}</span>
                  <span className="ml-auto truncate pl-3 font-mono text-[11px] text-ink-3">{host(t.url)}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
          <Command.Group heading="Commands">
            {cmds.map((c) => (
              <Command.Item
                key={c.id}
                value={`${c.title} ${c.id}`}
                onSelect={() => {
                  close();
                  runCommand(c.id);
                }}
                className="flex items-center gap-2 rounded-lg px-3 py-2"
              >
                <Icon icon={Terminal} size={14} className="shrink-0 text-ink-3" />
                <span>{c.title}</span>
                {c.keybinding && <kbd className="ml-auto rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-ink-2">{chord(c.keybinding)}</kbd>}
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}

function host(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function chord(k: string) {
  return k.replace("mod", "⌘").replace("shift", "⇧").replaceAll("+", "").toUpperCase();
}
