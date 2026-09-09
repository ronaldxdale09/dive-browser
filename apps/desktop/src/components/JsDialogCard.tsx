import { MessageSquareWarning } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCoversContent } from "../lib/overlay";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useJsDialog } from "../store/jsDialog";
import type { JsDialogAsked } from "../lib/ipc";
import { Icon } from "./Icon";

/** The site as the card names it. */
function site(origin: string) {
  return origin.replace(/^https?:\/\//, "") || "This page";
}

function heading(d: JsDialogAsked) {
  if (d.kind === "beforeunload") return d.is_reload ? "Reload this page?" : "Leave this page?";
  return `${site(d.origin)} says`;
}

/**
 * A page's `alert`, `confirm`, `prompt` or leave-page question, shown as a
 * card over the page instead of a native modal. The page's script is paused
 * until it is answered; nothing else in Dive is. Enter accepts, Escape
 * cancels (or, for an alert, closes it).
 */
export function JsDialogCard({ tabId }: { tabId: string | null }) {
  const dialog = useJsDialog((s) => (tabId ? s.byTab[tabId]?.[0] : undefined));
  const init = useJsDialog((s) => s.init);
  const answer = useJsDialog((s) => s.answer);
  const panel = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // The typed answer belongs to one dialog; a new dialog starts from its own
  // suggested text without an effect resetting anything.
  const [draft, setDraft] = useState<{ id: string; text: string }>();
  const open = dialog !== undefined;
  const text = dialog && draft?.id === dialog.dialog_id ? draft.text : (dialog?.default_value ?? "");
  useEffect(() => void init(), [init]);
  useCoversContent(open);
  const prompt = dialog?.kind === "prompt";
  useFocusTrap(panel, { active: open, initialFocus: prompt ? field : primary, onEscape: () => dialog && void answer(dialog, false) });
  if (!dialog) return null;
  const accept = () => void answer(dialog, true, text);
  const cancel = () => void answer(dialog, false);
  const okLabel = dialog.kind === "beforeunload" ? (dialog.is_reload ? "Reload" : "Leave") : "OK";
  const cancelLabel = dialog.kind === "beforeunload" ? "Stay" : "Cancel";
  const message = dialog.kind === "beforeunload" ? "Changes you made may not be saved." : dialog.message;
  return (
    <div
      ref={panel}
      role="alertdialog"
      aria-label={heading(dialog)}
      aria-describedby="js-dialog-message"
      className="surface-enter absolute top-2 left-1/2 z-40 w-[380px] max-w-[calc(100%-16px)] -translate-x-1/2 rounded-2xl border border-line-2 bg-surface p-3 text-xs shadow-2xl"
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          accept();
        }
      }}
    >
      <div className="flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2">
          <Icon icon={MessageSquareWarning} size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-ink">{heading(dialog)}</h2>
          <p id="js-dialog-message" className="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[12px] text-ink-2">
            {message}
          </p>
        </div>
      </div>
      {prompt && (
        <input
          ref={field}
          type="text"
          aria-label="Your answer"
          value={text}
          onChange={(e) => setDraft({ id: dialog.dialog_id, text: e.target.value })}
          className="mt-2.5 h-8 w-full rounded-lg border border-line-2 bg-surface-2 px-2.5 text-[12px] text-ink outline-none focus:border-accent"
        />
      )}
      <div className="mt-3 flex items-center justify-end gap-2">
        {dialog.kind !== "alert" && (
          <button type="button" onClick={cancel} className="h-7 rounded-lg px-2.5 text-ink-2 hover:bg-surface-2 hover:text-ink">
            {cancelLabel}
          </button>
        )}
        <button ref={primary} type="button" onClick={accept} className="h-7 rounded-lg bg-accent px-3 font-medium text-accent-ink hover:opacity-90">
          {okLabel}
        </button>
      </div>
    </div>
  );
}
