import { KeyRound, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useCoversContent } from "../lib/overlay";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useCredentialPrompt } from "../store/credentialPrompt";
import { Icon } from "./Icon";

/** The site as the card names it. */
function site(origin: string) {
  return origin.replace(/^https?:\/\//, "");
}

/**
 * The host's question about a login on the active tab, as a card at the top
 * of the page: save it, update it, or choose which saved login to fill. It
 * covers a strip of the page (the card sits above the native view), so it is
 * small and out of the way, and Escape closes it without deciding.
 */
export function CredentialPromptCard({ tabId }: { tabId: string | null }) {
  const prompt = useCredentialPrompt((s) => (tabId ? s.byTab[tabId] : undefined));
  const init = useCredentialPrompt((s) => s.init);
  const answer = useCredentialPrompt((s) => s.answer);
  const pick = useCredentialPrompt((s) => s.pick);
  const dismiss = useCredentialPrompt((s) => s.dismiss);
  const panel = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const open = prompt !== undefined;
  useEffect(() => void init(), [init]);
  useCoversContent(open);
  useFocusTrap(panel, { active: open, initialFocus: primary, onEscape: () => prompt && dismiss(prompt.tab_id) });
  if (!prompt) return null;
  const heading = prompt.kind === "pick" ? `Sign in to ${site(prompt.origin)} as` : prompt.kind === "update" ? `Update the password for ${site(prompt.origin)}?` : `Save the password for ${site(prompt.origin)}?`;
  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={heading}
      className="surface-enter absolute top-2 right-2 z-40 w-[340px] max-w-[calc(100%-16px)] rounded-2xl border border-line-2 bg-surface p-3 text-xs shadow-2xl"
    >
      <div className="flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2">
          <Icon icon={KeyRound} size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-ink">{heading}</h2>
          {prompt.kind !== "pick" && (
            <p className="mt-0.5 truncate text-[11px] text-ink-3" title={prompt.username}>
              {prompt.username || "No username"}
              <span className="mx-1">·</span>kept in the Keychain for this profile
            </p>
          )}
        </div>
        <button type="button" aria-label="Close" onClick={() => dismiss(prompt.tab_id)} className="grid size-6 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink">
          <Icon icon={X} size={12} />
        </button>
      </div>
      {prompt.kind === "pick" ? (
        <ul className="mt-2 flex flex-col gap-1" aria-label="Saved logins">
          {prompt.usernames.map((name, i) => (
            <li key={name}>
              <button ref={i === 0 ? primary : undefined} type="button" onClick={() => void pick(prompt, name)} className="w-full rounded-lg px-2.5 py-1.5 text-left text-ink hover:bg-surface-2">
                {name}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={() => void answer(prompt, false)} className="h-7 rounded-lg px-2.5 text-ink-2 hover:bg-surface-2 hover:text-ink">
            Not now
          </button>
          <button ref={primary} type="button" onClick={() => void answer(prompt, true)} className="h-7 rounded-lg bg-accent px-3 font-medium text-accent-ink hover:opacity-90">
            {prompt.kind === "update" ? "Update" : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}
