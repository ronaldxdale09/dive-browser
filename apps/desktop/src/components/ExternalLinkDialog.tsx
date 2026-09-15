import { ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCoversContent } from "../lib/overlay";
import { useFocusTrap } from "../lib/useFocusTrap";
import type { ExternalLinkAsked } from "../lib/ipc";
import { useExternalLink } from "../store/externalLink";
import { Icon } from "./Icon";

/**
 * "Open Claude?" -- the question a page has to get through before it can
 * start another program.
 *
 * It is modal on purpose: this is the one thing in the browser that leaves
 * the browser, so it does not sit quietly in a corner where a click meant for
 * the page could answer it. The site is named, because what matters is which
 * page asked, and the tick remembers that site and that scheme only.
 */
export function ExternalLinkDialog() {
  const asked = useExternalLink((s) => s.asked);
  const init = useExternalLink((s) => s.init);
  useEffect(() => void init(), [init]);
  // Keyed by token, so each question is its own dialog with its own tick:
  // answering for one site never carries over to the next.
  return asked ? <Prompt key={asked.token} asked={asked} /> : null;
}

function Prompt({ asked }: { asked: ExternalLinkAsked }) {
  const open = useExternalLink((s) => s.open);
  const cancel = useExternalLink((s) => s.cancel);
  const [always, setAlways] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  useCoversContent(true);
  useFocusTrap(root, { active: true, initialFocus: primary, onEscape: () => cancel(asked) });
  const name = asked.app ?? `the ${asked.scheme} app`;
  const title = asked.app ? `Open ${asked.app}?` : `Open this link in another app?`;
  const site = asked.origin || "This page";
  return (
    <div ref={root} className="overlay-backdrop fixed inset-0 z-50" onMouseDown={() => cancel(asked)}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="mx-auto mt-28 w-[420px] rounded-2xl border border-line-2 bg-surface p-4 shadow-2xl"
      >
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-[11px] bg-surface-2 text-ink-2">
            <Icon icon={ExternalLink} size={16} />
          </span>
          <h2 className="min-w-0 text-sm font-semibold">{title}</h2>
        </div>
        <p className="mt-3 text-xs text-ink-2">
          {site} wants to open {asked.app ? "this application" : `a ${asked.scheme}: link`}.
        </p>
        {asked.origin && (
          <label className="mt-3 flex items-start gap-2 text-[11px] text-ink-2">
            <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} className="mt-0.5 size-3.5 accent-accent" />
            <span>
              Always allow {asked.origin} to open {asked.scheme}: links in {name}
            </span>
          </label>
        )}
        <div className="mt-5 flex items-center justify-end gap-2">
          <button type="button" onClick={() => cancel(asked)} className="h-8 rounded-full px-3 text-xs text-ink-2 hover:bg-surface-2">
            Cancel
          </button>
          <button ref={primary} type="button" onClick={() => void open(asked, always)} className="h-8 rounded-full bg-accent px-4 text-xs font-medium text-accent-ink">
            {asked.app ? `Open ${asked.app}` : "Open"}
          </button>
        </div>
      </div>
    </div>
  );
}
