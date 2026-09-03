import { ArrowUp, Brain, ChevronRight, Globe, ShieldOff, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { compactNumber, formatCost } from "../../lib/agentSteps";
import { Markdown } from "../../lib/markdown";
import type { Message } from "../../store/agent";
import { useAgent } from "../../store/agent";
import { useBrowser } from "../../store/browser";
import { usePrefs } from "../../store/prefs";
import { Favicon } from "../Favicon";
import { Icon } from "../Icon";
import { ModelPicker } from "./ModelPicker";
import { StepList } from "./StepList";

/** Things worth asking a browser agent about the page in front of you. */
const SUGGESTIONS = [
  { label: "Summarize this page", prompt: "Summarize this page for me: what it is, what it does, and anything a developer should notice." },
  { label: "Find and fix errors", prompt: "Look at the console errors and failed requests on this page. For each real problem, tell me the likely cause and a concrete fix." },
  { label: "Test responsive layout", prompt: "Check this page at phone, tablet and desktop sizes. Report anything that breaks, overflows or hides content, with the viewport it happens at." },
  { label: "Review accessibility", prompt: "Review this page's accessibility: missing labels, contrast problems, keyboard traps, heading structure. Give specific fixes." },
  { label: "Fill this form", prompt: "Fill in the form on this page with realistic test data. Don't submit it; tell me what you filled in." },
  { label: "Map the API calls", prompt: "From the network activity, describe the API endpoints this page uses: method, path, what each is for, and the response shape." },
];

/** The conversation and its composer. */
export function Thread({ onAddProvider }: { onAddProvider: () => void }) {
  const messages = useAgent((s) => s.messages);
  const busy = useAgent((s) => s.busy);
  const send = useAgent((s) => s.send);
  const stop = useAgent((s) => s.stop);
  const sessionAutoApprove = useAgent((s) => s.sessionAutoApprove);
  const setSessionAutoApprove = useAgent((s) => s.setSessionAutoApprove);
  const includePage = usePrefs((s) => s.prefs.agent_include_page);
  const update = usePrefs((s) => s.update);
  const activeTab = useBrowser((s) => s.activeTab);
  const current = useBrowser((s) => s.tabs.find((t) => t.id === s.activeTab));
  const openTab = useBrowser((s) => s.openTab);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const submit = (text = draft) => {
    if (!text.trim() || busy) return;
    setDraft("");
    void send(text, activeTab);
    textRef.current?.focus();
  };
  const onLink = (href: string) => void openTab(href);

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-3 py-3 select-text">
        {messages.length === 0 && (
          <div className="flex flex-1 flex-col justify-end gap-3">
            <div>
              <p className="text-sm font-medium text-ink">What should I do on this page?</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-3">I can read it, explain it, debug it, and drive it: click, type, navigate, fill forms, run checks. Actions that change the page ask you first.</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s.label} type="button" disabled={!activeTab} onClick={() => submit(s.prompt)} className="h-7 rounded-full border border-line px-2.5 text-[11px] text-ink-2 hover:border-line-2 hover:bg-surface-2 hover:text-ink disabled:opacity-40">
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (m.role === "user" ? <UserBubble key={m.id} message={m} /> : <AssistantMessage key={m.id} message={m} onLink={onLink} />))}
        <div ref={endRef} />
      </div>

      <div className="border-t border-line p-2">
        <div className="mb-1.5 flex items-center gap-1.5 px-1">
          {current && (
            <button
              type="button"
              onClick={() => void update({ agent_include_page: !includePage })}
              aria-pressed={includePage}
              title={includePage ? "Page context is sent with each message. Click to send only your words." : "Page context is off. Click to include this tab's title, URL, console and text."}
              className={`flex h-6 min-w-0 max-w-[60%] items-center gap-1.5 rounded-full border px-2 text-[11px] transition-colors ${includePage ? "border-line-2 bg-surface-3 text-ink" : "border-dashed border-line text-ink-3 line-through"}`}
            >
              <Favicon src={current.favicon} size={11} fallback={Globe} />
              <span className="truncate">{current.title || current.url}</span>
            </button>
          )}
          {sessionAutoApprove && (
            <button type="button" onClick={() => setSessionAutoApprove(false)} className="flex h-6 items-center gap-1 rounded-full bg-highlight-soft px-2 text-[11px] text-highlight" title="Every action is being approved for this session. Click to ask again.">
              <Icon icon={ShieldOff} size={11} /> Auto-approve on
            </button>
          )}
        </div>
        <div className="rounded-xl border border-line bg-surface-2 p-2 focus-within:border-line-2">
          <textarea
            ref={textRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={Math.min(6, Math.max(1, draft.split("\n").length))}
            placeholder={activeTab ? "Ask, or tell me what to do on this page…" : "Open a tab, then ask…"}
            className="max-h-40 w-full resize-none bg-transparent text-xs leading-relaxed outline-none placeholder:text-ink-3"
          />
          <div className="mt-1 flex items-center gap-1">
            <ModelPicker onAddProvider={onAddProvider} />
            <span className="flex-1" />
            {busy ? (
              <button type="button" aria-label="Stop" onClick={() => void stop()} className="grid size-7 place-items-center rounded-full bg-surface-3 text-ink hover:bg-danger hover:text-white" title="Stop">
                <Icon icon={Square} size={11} />
              </button>
            ) : (
              <button type="button" aria-label="Send" disabled={!draft.trim()} onClick={() => submit()} className="grid size-7 place-items-center rounded-full bg-accent text-accent-ink disabled:opacity-40">
                <Icon icon={ArrowUp} size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function UserBubble({ message }: { message: Message }) {
  return <div className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-surface-3 px-3 py-2 text-xs whitespace-pre-wrap text-ink">{message.content}</div>;
}

function AssistantMessage({ message: m, onLink }: { message: Message; onLink: (href: string) => void }) {
  const waiting = m.pending && !m.content && !m.reasoning && !(m.steps && m.steps.length > 0);
  return (
    <div className="max-w-full text-xs leading-relaxed text-ink">
      {m.reasoning && <Reasoning text={m.reasoning} live={Boolean(m.pending && !m.content)} />}
      {m.steps && <StepList steps={m.steps} />}
      {m.content && <Markdown text={m.content} onLink={onLink} />}
      {waiting && (
        <span className="flex items-center gap-1.5 text-ink-3">
          <span className="size-1.5 animate-pulse rounded-full bg-ink-3" />
          Thinking…
        </span>
      )}
      {m.error && <div className="mt-1.5 rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">{m.error}</div>}
      {(m.stopped || (m.usage && !m.pending)) && (
        <div className="mt-1.5 flex items-center gap-2 text-[10px] text-ink-3">
          {m.stopped && <span className="rounded-full bg-surface-3 px-1.5 py-px tracking-wider uppercase">stopped</span>}
          {m.usage && (
            <span title={`${m.usage.input_tokens} in (${m.usage.cache_read_tokens} cached), ${m.usage.output_tokens} out`}>
              {compactNumber(m.usage.input_tokens)} in · {compactNumber(m.usage.output_tokens)} out
              {m.usage.cost_usd != null ? ` · ${formatCost(m.usage.cost_usd)}` : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** The model's reasoning summary: open while it is the only thing there, folded once the answer starts. */
function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? live;
  const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
  return (
    <div className="mb-2">
      <button type="button" onClick={() => setOpen(!expanded)} aria-expanded={expanded} className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[11px] text-ink-3 hover:bg-surface-2 hover:text-ink-2">
        <Icon icon={Brain} size={11} className={live ? "animate-pulse text-highlight" : ""} />
        <span className="min-w-0 flex-1 truncate">{expanded ? "Thinking" : firstLine}</span>
        <Icon icon={ChevronRight} size={11} className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>
      {expanded && <div className="mt-1 max-h-48 overflow-y-auto border-l-2 border-line-2 pl-2.5 text-[11px] leading-relaxed whitespace-pre-wrap text-ink-3">{text}</div>}
    </div>
  );
}

