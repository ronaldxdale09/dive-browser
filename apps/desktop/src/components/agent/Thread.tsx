import { ArrowUp, Brain, ChevronDown, ChevronRight, ChevronUp, EyeOff, FlaskConical, Globe, ShieldAlert, ShieldOff, Square } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { compactNumber, formatCost } from "../../lib/agentSteps";
import { replayableSteps, toPlaywrightSpec } from "../../lib/playwright";
import { Markdown } from "../../lib/markdown";
import type { Message } from "../../store/agent";
import { useAgent } from "../../store/agent";
import { tabInThisWindow, useBrowser } from "../../store/browser";
import { usePrefs } from "../../store/prefs";
import { Favicon } from "../Favicon";
import { Icon } from "../Icon";
import { SpecModal } from "../SpecModal";
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
    label: "Summarize this page",
    hint: "What it is and what it does",
    prompt:
      "Summarize this page for me: what it is, what it does, and anything a developer or designer should notice.",
  },
  {
    label: "Find what is broken",
    hint: "Console errors and failed requests",
    prompt:
      "Look at the console errors and failed requests on this page. For each real problem, tell me the likely cause and a concrete fix.",
  },
  {
    label: "Check it on a phone",
    hint: "Layout at phone and tablet widths",
    prompt:
      "Check this page at phone, tablet and desktop sizes. Report anything that breaks, overflows or hides content, with the viewport it happens at.",
  },
  {
    label: "Check accessibility",
    hint: "Contrast, names and keyboard traps",
    prompt:
      "Review this page's accessibility: missing labels, contrast problems, keyboard traps, heading structure. Give specific fixes.",
  },
];

/** Within this many pixels of the end, the person counts as reading the newest text. */
const BOTTOM_SLACK = 40;

/** The conversation and its composer. */
export function Thread({ onAddProvider }: { onAddProvider: () => void }) {
  const messages = useAgent((s) => s.messages);
  const busy = useAgent((s) => s.busy);
  const send = useAgent((s) => s.send);
  const stop = useAgent((s) => s.stop);
  const clear = useAgent((s) => s.clear);
  const sessionAutoApprove = useAgent((s) => s.sessionAutoApprove);
  const setSessionAutoApprove = useAgent((s) => s.setSessionAutoApprove);
  const cleanSession = useAgent((s) => s.cleanSession);
  const setCleanSession = useAgent((s) => s.setCleanSession);
  const includePage = usePrefs((s) => s.prefs.agent_include_page);
  // The setting approves everything until it is turned off; say so here too.
  const alwaysAutoApprove = usePrefs((s) => s.prefs.agent_approvals === "never");
  const update = usePrefs((s) => s.update);
  const activeTab = useBrowser((s) => tabInThisWindow(s.activeTab, s.detached));
  const current = useBrowser((s) => {
    const id = tabInThisWindow(s.activeTab, s.detached);
    return id ? s.tabs.find((t) => t.id === id) : undefined;
  });
  const openTab = useBrowser((s) => s.openTab);
  const [draft, setDraft] = useState("");
  // The transcript out of the way without losing it. The composer stays: the
  // point of minimising is to see the page, not to leave the conversation.
  const [minimized, setMinimized] = useState(false);
  // The model panel opens upward, into the space the ways in occupy.
  const [pickerOpen, setPickerOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  // Whether the person was reading the newest text the last time they scrolled.
  const atBottom = useRef(true);
  const seen = useRef(messages.length);

  // A streaming reply changes `messages` many times a second. The scroll
  // waits for the next frame so a burst costs one, and follows the text only
  // while the person is at the end -- scrolling up to reread something must
  // not be undone by the next token. A new turn always shows itself.
  useEffect(() => {
    const newTurn = messages.length !== seen.current;
    seen.current = messages.length;
    if (!newTurn && !atBottom.current) return;
    const frame = requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: "end" }));
    return () => cancelAnimationFrame(frame);
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
      {messages.length > 0 && minimized && (
        <button
          type="button"
          data-native-overlay
          onClick={() => setMinimized(false)}
          className="animate-agent-slide-up mb-2 flex items-center gap-2 self-center rounded-full border border-line-2 bg-surface/95 px-3 py-1.5 text-[11px] text-ink-2 shadow-2xl backdrop-blur-xl hover:text-ink"
        >
          <Icon icon={ChevronUp} size={12} />
          {messages.length} message{messages.length === 1 ? "" : "s"}
          {busy && <span className="text-highlight">· working</span>}
        </button>
      )}

      {messages.length > 0 && !minimized && (
        <div
          data-native-overlay
          className="mb-2 flex min-h-0 flex-col gap-4 overflow-auto rounded-[20px] border border-line-2 bg-surface/95 px-4 py-4 shadow-2xl backdrop-blur-xl select-text"
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
          }}
        >
          {messages.map((m, i) =>
            m.role === "user" ? (
              <UserBubble key={m.id} message={m} />
            ) : (
              <AssistantMessage
                key={m.id}
                message={m}
                onLink={onLink}
                // What was asked names the exported test, and where the tab
                // is now is where a replay of it would start.
                askedFor={messages[i - 1]?.role === "user" ? messages[i - 1]?.content : undefined}
                startUrl={current?.url}
              />
            ),
          )}
          <div ref={endRef} />
        </div>
      )}

      {/* Nothing has been asked yet: four ways in, as quiet chips above the
          composer rather than a panel of their own. */}
      {messages.length === 0 && !pickerOpen && (
        <div className="mb-2 flex flex-wrap justify-center gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              data-native-overlay
              type="button"
              disabled={!activeTab}
              title={s.hint}
              onClick={() => submit(s.prompt)}
              className="animate-agent-slide-up rounded-full border border-line-2 bg-surface/90 px-3 py-1.5 text-[11px] text-ink-2 shadow-lg backdrop-blur-xl transition-colors hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-highlight focus-visible:outline-none disabled:opacity-40"
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {/* The composer: one card, a paragraph wide, over the page. */}
      <div data-native-overlay className="rounded-[20px] border border-line-2 bg-surface/95 px-4 pt-3.5 pb-2.5 shadow-2xl backdrop-blur-xl transition-[border-color] focus-within:border-highlight/60">
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
          rows={Math.min(8, Math.max(2, draft.split("\n").length))}
          placeholder={activeTab ? "Ask about this page, or say what to do…" : "Open a tab, then ask…"}
          className="max-h-[38vh] w-full resize-none bg-transparent text-[13px] leading-6 text-ink outline-none placeholder:text-ink-3"
        />

        {/* What it can see and how it may act, then the one action. */}
        <div className="mt-1.5 flex items-center gap-1.5">
          <ModelPicker onAddProvider={onAddProvider} onOpenChange={setPickerOpen} />
          {/* Signed out of everything, in a context that goes when the run
              does. The page chip disappears with it: there is no page of the
              person's in a clean run. */}
          <button
            type="button"
            onClick={() => setCleanSession(!cleanSession)}
            aria-pressed={cleanSession}
            aria-label="Clean session"
            title={
              cleanSession
                ? "Working signed out, in tabs of its own, thrown away when the run ends. Click to work in your session again."
                : "Work in your session, signed in as you. Click to run signed out instead."
            }
            className={`flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11px] transition-colors ${
              cleanSession ? "bg-highlight-soft text-highlight" : "text-ink-3 hover:bg-surface-2 hover:text-ink-2"
            }`}
          >
            <Icon icon={EyeOff} size={11} />
            {cleanSession ? "Clean session" : ""}
          </button>

          {!cleanSession && current && (
            <button
              type="button"
              onClick={() => void update({ agent_include_page: !includePage })}
              aria-pressed={includePage}
              title={includePage ? "The page goes with each message. Click to send only what you type." : "The page is not sent. Click to include its text, address and console."}
              className={`flex h-7 min-w-0 max-w-[40%] items-center gap-1.5 rounded-full px-2.5 text-[11px] transition-[color,background-color,opacity] ${
                includePage ? "bg-surface-2 text-ink-2 hover:text-ink" : "text-ink-3 line-through decoration-ink-3/50 hover:text-ink-2"
              }`}
            >
              <Favicon src={current.favicon} size={11} fallback={Globe} />
              <span className="truncate">{current.title || current.url}</span>
              {!includePage && <span className="shrink-0 text-ink-3">off</span>}
            </button>
          )}

          {(sessionAutoApprove || alwaysAutoApprove) && (
            <button
              type="button"
              onClick={() => (alwaysAutoApprove ? useBrowser.getState().openSettings("agent") : setSessionAutoApprove(false))}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-highlight-soft px-2.5 text-[11px] text-highlight"
              title={alwaysAutoApprove ? "Act without asking is on in Settings. Click to change it." : "Every action is being approved for this session. Click to require confirmation."}
            >
              <Icon icon={ShieldOff} size={11} /> {alwaysAutoApprove ? "Acts without asking" : "Auto-approve on"}
            </button>
          )}

          <span className="flex-1" />

          {messages.length > 0 && (
            <button
              type="button"
              onClick={() => setMinimized((v) => !v)}
              aria-expanded={!minimized}
              title={minimized ? "Show the conversation" : "Hide the conversation and keep the composer"}
              className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink"
            >
              <Icon icon={minimized ? ChevronUp : ChevronDown} size={13} />
              <span className="sr-only">{minimized ? "Show the conversation" : "Minimise the conversation"}</span>
            </button>
          )}

          {messages.length > 0 && !busy && (
            <button
              type="button"
              onClick={clear}
              title="Start a new conversation"
              className="h-7 shrink-0 rounded-full px-2.5 text-[11px] text-ink-3 hover:bg-surface-2 hover:text-ink"
            >
              New
            </button>
          )}

          {busy ? (
            <button
              type="button"
              aria-label="Stop"
              onClick={() => void stop()}
              title="Stop"
              className="grid size-8 shrink-0 place-items-center rounded-full bg-danger text-danger-ink transition-transform active:scale-95"
            >
              <Icon icon={Square} size={12} />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send"
              disabled={!draft.trim()}
              onClick={() => submit()}
              className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-accent-ink transition-[opacity,transform] hover:opacity-90 disabled:opacity-45 active:scale-95"
            >
              <Icon icon={ArrowUp} size={15} />
            </button>
          )}
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
  askedFor,
  startUrl,
}: {
  message: Message;
  onLink: (href: string) => void;
  askedFor?: string | undefined;
  startUrl?: string | undefined;
}) {
  const waiting = m.pending && !m.content && !m.reasoning && !(m.steps && m.steps.length > 0);
  // A run that changed the page is a flow somebody may want to keep. The
  // agent already addressed every element by locator, so the test writes
  // itself -- no recording pass, no selectors invented after the fact.
  const replayable = replayableSteps(m.steps ?? []);
  const [exporting, setExporting] = useState(false);
  return (
    <div className="max-w-full text-xs leading-relaxed text-ink animate-agent-slide-up">
      {m.reasoning && <Reasoning text={m.reasoning} live={Boolean(m.pending && !m.content)} />}
      {m.steps && <StepList steps={m.steps} live={Boolean(m.pending)} />}
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
      {/* A page that addressed the agent is the person's to judge: they are
          the one who can decide the site is not to be trusted. The agent was
          told to carry on with their task regardless. */}
      {m.flagged?.map((note) => (
        <div key={note} className="mt-1.5 flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-[11px] text-ink-2">
          <Icon icon={ShieldAlert} size={13} className="mt-px shrink-0 text-warn" />
          <span className="min-w-0 select-text">
            <span className="font-medium text-ink">This page tried to instruct the agent.</span> {note}
          </span>
        </div>
      ))}
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
      {(m.stopped || replayable.length > 0 || (m.usage && !m.pending)) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10.5px] text-ink-3">
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
          {replayable.length > 0 && !m.pending && (
            <button
              type="button"
              onClick={() => setExporting(true)}
              title="Write these steps as a Playwright test"
              className="flex items-center gap-1 rounded-full px-1.5 py-px text-ink-3 hover:bg-surface-2 hover:text-ink"
            >
              <Icon icon={FlaskConical} size={11} />
              Export as test
            </button>
          )}
        </div>
      )}
      {exporting && (
        <SpecModal
          title="Playwright Test From This Run"
          subtitle={`${replayable.length} step${replayable.length === 1 ? "" : "s"} the agent took`}
          spec={toPlaywrightSpec(replayable, startUrl, testTitle(askedFor))}
          filename="agent-run.spec.ts"
          onClose={() => setExporting(false)}
        />
      )}
    </div>
  );
});

/** The request, trimmed to one line, as the test's name. */
function testTitle(askedFor: string | undefined): string {
  const one = (askedFor ?? "").replace(/\s+/g, " ").trim();
  if (!one) return "agent run";
  return one.length > 80 ? `${one.slice(0, 79)}…` : one;
}

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
