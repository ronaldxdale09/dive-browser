import { ArrowUp, Brain, ChevronRight, Globe, ShieldOff, Square } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { compactNumber, formatCost } from "../../lib/agentSteps";
import { Markdown } from "../../lib/markdown";
import type { Message } from "../../store/agent";
import { useAgent } from "../../store/agent";
import { useBrowser } from "../../store/browser";
import { usePrefs } from "../../store/prefs";
import { Favicon } from "../Favicon";
import { Icon } from "../Icon";
import { AgentIcon } from "./AgentIcon";
import { ModelPicker } from "./ModelPicker";
import { StepList } from "./StepList";

interface Suggestion {
  label: string;
  hint: string;
  prompt: string;
}

/** Things worth asking a browser agent about the page in front of you. */
const SUGGESTIONS: Suggestion[] = [
  {
    label: "Summarize page",
    hint: "Overview, architecture & key elements",
    prompt:
      "Summarize this page for me: what it is, what it does, and anything a developer or designer should notice.",
  },
  {
    label: "Debug errors",
    hint: "Console issues & failed requests",
    prompt:
      "Look at the console errors and failed requests on this page. For each real problem, tell me the likely cause and a concrete fix.",
  },
  {
    label: "Responsive audit",
    hint: "Phone, tablet & desktop viewports",
    prompt:
      "Check this page at phone, tablet and desktop sizes. Report anything that breaks, overflows or hides content, with the viewport it happens at.",
  },
  {
    label: "Accessibility audit",
    hint: "Contrast, ARIA labels & keyboard traps",
    prompt:
      "Review this page's accessibility: missing labels, contrast problems, keyboard traps, heading structure. Give specific fixes.",
  },
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
  // The setting approves everything until it is turned off; say so here too.
  const alwaysAutoApprove = usePrefs((s) => s.prefs.agent_auto_approve);
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

  // Opened with ⌘J or the toolbar: the person came here to type.
  useEffect(() => {
    textRef.current?.focus();
  }, []);

  const submit = (text = draft) => {
    if (!text.trim() || busy) return;
    setDraft("");
    void send(text, activeTab);
    textRef.current?.focus();
  };
  const onLink = useCallback((href: string) => void openTab(href), [openTab]);

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-3 py-3 select-text">
        {messages.length === 0 && (
          <div className="flex flex-1 flex-col justify-center gap-4 py-4 animate-agent-slide-up">
            {/* Centered Welcome */}
            <div className="flex flex-col items-center text-center px-4">
              <AgentIcon size={22} className="text-highlight mb-2" />
              <h3 className="text-xs font-semibold text-ink">Dive Browser Agent</h3>
              <p className="mt-1 max-w-[280px] text-[11px] leading-relaxed text-ink-3">
                Inspect DOM elements, analyze network calls, test responsive viewports, and automate workflows.
              </p>
            </div>

            {/* Clean Text-First Quick Starters */}
            <div className="space-y-1.5 pt-1">
              <span className="block text-[10px] font-medium uppercase tracking-wider text-ink-3 px-1">
                Quick Actions
              </span>
              <div className="space-y-1">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    disabled={!activeTab}
                    onClick={() => submit(s.prompt)}
                    className="group flex w-full items-center justify-between rounded-lg border border-line bg-surface-2/40 px-2.5 py-1.5 text-left transition-colors hover:border-line-2 hover:bg-surface-2 disabled:opacity-40"
                  >
                    <span className="text-xs font-medium text-ink-2 group-hover:text-ink transition-colors">
                      {s.label}
                    </span>
                    <span className="text-[10px] text-ink-3 truncate ml-2">
                      {s.hint}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {messages.map((m) =>
          m.role === "user" ? (
            <UserBubble key={m.id} message={m} />
          ) : (
            <AssistantMessage key={m.id} message={m} onLink={onLink} />
          ),
        )}
        <div ref={endRef} />
      </div>

      {/* Floating Composer Area */}
      <div className="border-t border-line/70 p-2.5 bg-surface/80 backdrop-blur-md">
        {/* Context Badges Bar */}
        <div className="mb-1.5 flex items-center gap-1.5 px-1">
          {current && (
            <button
              type="button"
              onClick={() => void update({ agent_include_page: !includePage })}
              aria-pressed={includePage}
              title={
                includePage
                  ? "Page context is included with each message. Click to send only prompt."
                  : "Page context is off. Click to include tab DOM, title, URL and console."
              }
              className={`flex h-6 min-w-0 max-w-[65%] items-center gap-1.5 rounded-full border px-2 text-[10.5px] transition-[color,background-color,border-color,box-shadow,opacity] ${
                includePage
                  ? "border-line-2 bg-surface-3 text-ink shadow-2xs"
                  : "border-dashed border-line text-ink-3 line-through opacity-70"
              }`}
            >
              <Favicon src={current.favicon} size={11} fallback={Globe} />
              <span className="truncate">{current.title || current.url}</span>
            </button>
          )}

          {(sessionAutoApprove || alwaysAutoApprove) && (
            <button
              type="button"
              onClick={() => (alwaysAutoApprove ? useBrowser.getState().openSettings("agent") : setSessionAutoApprove(false))}
              className="flex h-6 items-center gap-1 rounded-full bg-highlight-soft px-2 text-[10.5px] text-highlight ring-1 ring-highlight/20"
              title={alwaysAutoApprove ? "Act without asking is on in Settings. Click to change it." : "Every action is being approved for this session. Click to require confirmation."}
            >
              <Icon icon={ShieldOff} size={10} /> {alwaysAutoApprove ? "Acts without asking" : "Auto-approve on"}
            </button>
          )}
        </div>

        {/* Composer Card */}
        <div className="rounded-2xl border border-line-2 bg-surface-2/90 p-2.5 shadow-sm transition-[border-color,box-shadow] focus-within:border-highlight/60 focus-within:ring-1 focus-within:ring-highlight/30">
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
            placeholder={
              activeTab ? "Ask, or direct the agent on this page…" : "Open a tab, then ask…"
            }
            className="max-h-40 w-full resize-none bg-transparent text-xs leading-relaxed text-ink outline-none placeholder:text-ink-3"
          />

          <div className="mt-2 flex items-center gap-1 pt-1 border-t border-line/40">
            <ModelPicker onAddProvider={onAddProvider} />
            <span className="flex-1" />

            {/* Send / Stop CTA */}
            {busy ? (
              <button
                type="button"
                aria-label="Stop"
                onClick={() => void stop()}
                className="grid size-7 place-items-center rounded-full bg-surface-3 text-ink hover:bg-danger hover:text-white transition-colors shadow-xs"
                title="Stop generation"
              >
                <Icon icon={Square} size={11} />
              </button>
            ) : (
              <button
                type="button"
                aria-label="Send"
                disabled={!draft.trim()}
                onClick={() => submit()}
                className="grid size-7 place-items-center rounded-full bg-accent text-accent-ink shadow-xs transition-[opacity,transform] hover:opacity-90 disabled:opacity-35 active:scale-95"
              >
                <Icon icon={ArrowUp} size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// Settled messages do not change; memo keeps a streaming reply from
// re-rendering the whole transcript on every delta.
const UserBubble = memo(function UserBubble({ message }: { message: Message }) {
  return (
    <div className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-surface-3 border border-line px-3 py-2 text-xs whitespace-pre-wrap text-ink shadow-2xs">
      {message.content}
    </div>
  );
});

const AssistantMessage = memo(function AssistantMessage({
  message: m,
  onLink,
}: {
  message: Message;
  onLink: (href: string) => void;
}) {
  const waiting = m.pending && !m.content && !m.reasoning && !(m.steps && m.steps.length > 0);
  return (
    <div className="max-w-full text-xs leading-relaxed text-ink animate-agent-slide-up">
      {m.reasoning && <Reasoning text={m.reasoning} live={Boolean(m.pending && !m.content)} />}
      {m.steps && <StepList steps={m.steps} />}
      {m.content && <Markdown text={m.content} onLink={onLink} />}
      {!m.pending && !m.content && !m.error && !m.stopped && !m.reasoning && !(m.steps && m.steps.length > 0) && (
        <p className="py-1 text-ink-3 italic">The model sent nothing back. Ask again, or pick a larger model.</p>
      )}
      {waiting && (
        <span className="flex items-center gap-2 text-ink-3 py-1">
          <span className="relative flex size-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-highlight opacity-75 motion-reduce:hidden" />
            <span className="relative inline-flex rounded-full size-2 bg-highlight" />
          </span>
          Thinking…
        </span>
      )}
      {m.error && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-danger">
          <span className="min-w-0 flex-1">{m.error}</span>
          <button
            type="button"
            onClick={() => useBrowser.getState().openSettings("agent")}
            className="shrink-0 rounded-full border border-danger/40 px-2 py-0.5 text-[10.5px] font-medium text-ink hover:bg-danger/15"
          >
            Change model or key
          </button>
        </div>
      )}
      {(m.stopped || (m.usage && !m.pending)) && (
        <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-ink-3">
          {m.stopped && (
            <span className="rounded-full bg-surface-3 px-1.5 py-px tracking-wider uppercase text-[9px]">
              stopped
            </span>
          )}
          {m.usage && (
            <span
              title={`${m.usage.input_tokens} in (${m.usage.cache_read_tokens} cached), ${m.usage.output_tokens} out`}
            >
              {compactNumber(m.usage.input_tokens)} in · {compactNumber(m.usage.output_tokens)} out
              {m.usage.cost_usd != null ? ` · ${formatCost(m.usage.cost_usd)}` : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
});

/** The model's reasoning summary: open while it is the only thing there, folded once the answer starts. */
function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? live;
  const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[11px] text-ink-3 hover:bg-surface-2 hover:text-ink-2 transition-colors"
      >
        <Icon icon={Brain} size={12} className={live ? "animate-pulse text-highlight motion-reduce:animate-none" : ""} />
        <span className="min-w-0 flex-1 truncate">{expanded ? "Thinking trace" : firstLine}</span>
        <Icon
          icon={ChevronRight}
          size={11}
          className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
        />
      </button>
      {expanded && (
        <div className="mt-1 max-h-48 overflow-y-auto border-l-2 border-line-2 pl-2.5 text-[11px] leading-relaxed whitespace-pre-wrap text-ink-3 font-mono">
          {text}
        </div>
      )}
    </div>
  );
}
