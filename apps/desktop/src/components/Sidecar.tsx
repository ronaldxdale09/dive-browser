import { ArrowUp, KeyRound, ListTree, MessageSquare, Radar, Trash2, Wand2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAgent } from "../store/agent";
import { selectErrors, useConsole } from "../store/console";
import { useBrowser } from "../store/browser";
import { Icon, IconButton } from "./Icon";

const TABS = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "trace", label: "Trace", icon: ListTree },
  { id: "watchers", label: "Watchers", icon: Radar },
  { id: "skills", label: "Skills", icon: Wand2 },
] as const;

/** Right-docked agent panel. Chat is live; the other panes land in Phase 3. */
export function Sidecar() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("chat");
  return (
    <aside aria-label="Agent" className="flex min-h-0 flex-col bg-surface">
      <div className="flex gap-1 px-2 pt-2 pb-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={tab === t.id}
            onClick={() => setTab(t.id)}
            className="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs text-ink-3 hover:bg-surface-2 hover:text-ink aria-pressed:bg-surface-3 aria-pressed:text-ink"
          >
            <Icon icon={t.icon} size={13} />
            {t.label}
          </button>
        ))}
      </div>
      {tab === "chat" && <Chat />}
      {tab === "watchers" && <Watchers onAsk={() => setTab("chat")} />}
      {tab !== "chat" && tab !== "watchers" && <div className="flex-1 px-4 py-3 text-xs text-ink-3">Coming in Phase 3.</div>}
    </aside>
  );
}

function Chat() {
  const keyPresent = useAgent((s) => s.keyPresent);
  const checkKey = useAgent((s) => s.checkKey);
  useEffect(() => void checkKey(), [checkKey]);
  if (keyPresent === null) return <div className="flex-1" />;
  return keyPresent ? <Thread /> : <KeySetup />;
}

function KeySetup() {
  const saveKey = useAgent((s) => s.saveKey);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
      onSubmit={(e) => {
        e.preventDefault();
        saveKey(key).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
      }}
    >
      <span className="grid size-10 place-items-center rounded-full bg-surface-3 text-ink-2">
        <Icon icon={KeyRound} size={18} />
      </span>
      <p className="text-xs text-ink-2">Add an Anthropic API key to chat about the page. It is stored in your OS keychain.</p>
      <input
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="sk-ant-…"
        autoComplete="off"
        className="h-9 w-full rounded-lg border border-line bg-surface-2 px-3 font-mono text-xs text-ink outline-none placeholder:text-ink-3 focus:border-line-2"
      />
      {error && <p className="text-xs text-danger">{error}</p>}
      <button type="submit" disabled={!key.trim()} className="h-8 rounded-full bg-accent px-4 text-xs font-medium text-accent-ink disabled:opacity-40">
        Save key
      </button>
    </form>
  );
}

function Thread() {
  const messages = useAgent((s) => s.messages);
  const busy = useAgent((s) => s.busy);
  const send = useAgent((s) => s.send);
  const clear = useAgent((s) => s.clear);
  const activeTab = useBrowser((s) => s.activeTab);
  const tabs = useBrowser((s) => s.tabs);
  const current = tabs.find((t) => t.id === activeTab);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const submit = () => {
    const text = draft;
    setDraft("");
    void send(text, activeTab);
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-3 py-2 select-text">
        {messages.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-xs text-ink-3">
            <span className="grid size-10 place-items-center rounded-full bg-surface-3 text-ink-2">
              <Icon icon={MessageSquare} size={18} />
            </span>
            <p>Ask about this tab. The agent sees its title, URL, recent console output, failed requests and visible text.</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "self-end max-w-[85%] rounded-2xl rounded-br-md bg-surface-3 px-3 py-2 text-xs text-ink" : "max-w-full text-xs leading-relaxed text-ink whitespace-pre-wrap"}>
            {m.content}
            {m.pending && !m.content && <span className="text-ink-3">Thinking…</span>}
            {m.error && <div className="mt-1 text-danger">{m.error}</div>}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="p-2">
        {current && (
          <div className="mb-1.5 flex items-center gap-2 px-1 text-[11px] text-ink-3">
            <span className="rounded-full bg-surface-3 px-2 py-0.5 text-ink-2">{current.title || current.url}</span>
            <span className="flex-1" />
            {messages.length > 0 && <IconButton icon={Trash2} label="Clear conversation" size={12} onClick={clear} />}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-xl border border-line bg-surface-2 p-2 focus-within:border-line-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            placeholder="Ask about this tab…"
            className="min-h-9 flex-1 resize-none bg-transparent text-xs outline-none placeholder:text-ink-3"
          />
          <button
            type="button"
            aria-label="Send"
            disabled={busy || !draft.trim()}
            onClick={submit}
            className="grid size-7 place-items-center rounded-full bg-accent text-accent-ink disabled:opacity-40"
          >
            <Icon icon={ArrowUp} size={14} />
          </button>
        </div>
      </div>
    </>
  );
}

/** Runtime watcher v1: errors from the active tab, one click to hand them to the agent. */
function Watchers({ onAsk }: { onAsk: () => void }) {
  const activeTab = useBrowser((s) => s.activeTab);
  const errors = useConsole(selectErrors(activeTab));
  const send = useAgent((s) => s.send);
  const keyPresent = useAgent((s) => s.keyPresent);
  const ask = (text: string, where: string) => {
    onAsk();
    void send(`This error appeared in the console${where ? ` at ${where}` : ""}:\n\n${text}\n\nExplain the likely cause and propose a concrete fix.`, activeTab);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto px-3 py-2 text-xs">
      <p className="mb-2 text-ink-3">Errors and uncaught exceptions on this tab. The watcher runs while the tab is open.</p>
      {errors.length === 0 && <p className="text-ink-3">Nothing wrong so far.</p>}
      {errors.slice(-30).reverse().map((e, i) => {
        const where = e.url ? `${e.url.split("/").pop() ?? e.url}${e.line ? `:${e.line}` : ""}` : "";
        return (
          <div key={`${e.timestamp}-${i}`} className="mb-2 rounded-lg border border-line bg-surface-2 p-2">
            <div className="mb-1 flex items-center gap-2 font-mono text-[10px] text-ink-3">
              <span>{e.source}</span>
              {where && <span className="truncate">{where}</span>}
            </div>
            <div className="line-clamp-4 font-mono text-[11px] whitespace-pre-wrap text-danger select-text">{e.text}</div>
            <button
              type="button"
              disabled={!keyPresent}
              onClick={() => ask(e.text, where)}
              className="mt-1.5 h-6 rounded-full bg-accent px-2.5 text-[11px] font-medium text-accent-ink disabled:opacity-40"
              title={keyPresent ? "Ask the agent about this error" : "Add an API key in Chat first"}
            >
              Explain and fix
            </button>
          </div>
        );
      })}
    </div>
  );
}
