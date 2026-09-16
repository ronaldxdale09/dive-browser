import { Check, ChevronRight, Loader2, ShieldAlert, X } from "lucide-react";
import { useState } from "react";
import { describeStep, pendingLabel } from "../../lib/agentSteps";
import type { Step } from "../../store/agent";
import { useAgent } from "../../store/agent";
import { Icon } from "../Icon";

/** A step still waiting on the person, or one that failed, is never folded away. */
function demandsAttention(step: Step): boolean {
  return Boolean(step.awaiting) || Boolean(step.error);
}

/** Past this many, a finished run's steps are worth folding. */
const FOLD_OVER = 2;

/**
 * What the agent did, as a timeline inside its reply. Each row is a verb
 * phrase; opening one shows the raw call and its result. Actions waiting on
 * the person get their Allow / Deny right there in the row, so approving
 * never means finding another pane.
 *
 * While the run is going the steps are the interesting part, so they are all
 * there. Once it has finished they are history, and ten of them in every
 * reply push the conversation off the top of a dock that is only ever a
 * paragraph tall -- so a finished run folds to one line and opens again on a
 * click. Anything failed or waiting stays out: those are not history.
 */
export function StepList({ steps, live = false }: { steps: Step[]; live?: boolean }) {
  const [opened, setOpened] = useState(false);
  if (steps.length === 0) return null;
  const notable = steps.filter(demandsAttention);
  const foldable = !live && !opened && steps.length > FOLD_OVER && notable.length < steps.length;
  if (!foldable) {
    return (
      <ol className="mb-2 space-y-px">
        {steps.map((s) => (
          <StepRow key={s.id} step={s} />
        ))}
      </ol>
    );
  }
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpened(true)}
        aria-expanded={false}
        className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-[11px] text-ink-3 hover:bg-surface-2 hover:text-ink-2"
      >
        <span className="grid size-5 shrink-0 place-items-center rounded-md text-ink-3">
          <Icon icon={Check} size={12} />
        </span>
        <span className="min-w-0 flex-1 truncate">
          {steps.length} steps
          {notable.length > 0 && <span className="text-danger"> · {notable.length} to look at</span>}
        </span>
        <Icon icon={ChevronRight} size={11} className="shrink-0 text-ink-3" />
      </button>
      {/* Folded is not hidden: whatever failed or is waiting is still here. */}
      {notable.length > 0 && (
        <ol className="space-y-px">
          {notable.map((s) => (
            <StepRow key={s.id} step={s} />
          ))}
        </ol>
      )}
    </div>
  );
}

function StepRow({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  const approve = useAgent((s) => s.approve);
  const setSessionAutoApprove = useAgent((s) => s.setSessionAutoApprove);
  const { label: done, icon } = describeStep(step);
  const running = step.summary === undefined && !step.error && !step.awaiting;
  const status = step.awaiting ? "awaiting" : step.error ? "failed" : running ? "running" : "ok";
  // Only a step that ran is in the past; a denied or failed one never happened.
  const label = status === "ok" ? done : pendingLabel(done);
  const tone = status === "failed" ? "text-danger" : status === "awaiting" ? "text-highlight" : step.action ? "text-ink" : "text-ink-2";
  return (
    <li className={`rounded-lg ${status === "awaiting" ? "bg-highlight-soft/40 ring-1 ring-highlight/40" : ""}`}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-surface-2">
        <span className={`grid size-5 shrink-0 place-items-center rounded-md ${step.action ? "bg-surface-3" : ""} ${tone}`}>
          <Icon icon={icon} size={12} />
        </span>
        <span className={`min-w-0 flex-1 truncate text-[11px] ${tone}`}>{label}</span>
        <span className="shrink-0 text-ink-3">
          {status === "running" && <Icon icon={Loader2} size={11} className="animate-spin motion-reduce:animate-none" />}
          {status === "ok" && <Icon icon={Check} size={11} className="text-ink-3" />}
          {status === "failed" && <Icon icon={X} size={11} className="text-danger" />}
          {status === "awaiting" && <Icon icon={ShieldAlert} size={11} className="text-highlight" />}
        </span>
        <Icon icon={ChevronRight} size={11} className={`shrink-0 text-ink-3 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {step.awaiting && (
        <div className="px-1.5 pt-0.5 pb-1.5">
          <p className="mb-1.5 text-[11px] text-ink-2">
            {step.caution ? `${step.caution[0]?.toUpperCase()}${step.caution.slice(1)}. Allow it?` : "This changes the page. Allow it?"}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => void approve(step.id, true)} className="h-6 rounded-full bg-accent px-3 text-[11px] font-medium text-accent-ink">
              Allow
            </button>
            <button type="button" onClick={() => void approve(step.id, false)} className="h-6 rounded-full border border-line px-3 text-[11px] text-ink-2 hover:bg-surface-2 hover:text-ink">
              Deny
            </button>
            <button
              type="button"
              onClick={() => {
                setSessionAutoApprove(true);
                void approve(step.id, true);
              }}
              className="h-6 rounded-full px-2 text-[11px] text-ink-3 hover:text-ink"
              title="Approve every action until the panel is closed or you turn it off"
            >
              Allow all this session
            </button>
          </div>
        </div>
      )}
      {open && (
        <div className="mx-1.5 mb-1.5 space-y-1 rounded-md bg-ground p-2 font-mono text-[10px] select-text">
          <div className="flex gap-2">
            <span className="shrink-0 text-ink-3">call</span>
            <span className="min-w-0 break-all text-ink-2">
              {step.name}({step.input === "{}" ? "" : step.input})
            </span>
          </div>
          {step.locator && (
            <div className="flex gap-2">
              <span className="shrink-0 text-ink-3">target</span>
              <span className="min-w-0 break-all text-ink-2">{step.locator}</span>
            </div>
          )}
          {step.summary !== undefined && (
            <div className="flex gap-2">
              <span className="shrink-0 text-ink-3">{step.error ? "error" : "result"}</span>
              <span className={`min-w-0 break-all ${step.error ? "text-danger" : "text-ink-2"}`}>{step.summary || "(empty)"}</span>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
