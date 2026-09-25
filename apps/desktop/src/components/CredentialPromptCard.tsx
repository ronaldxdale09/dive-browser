import { KeyRound, X } from "lucide-react";
import { useEffect } from "react";
import type { KeyboardEvent } from "react";
import { useCoversContent } from "../lib/overlay";
import { useCredentialPrompt } from "../store/credentialPrompt";
import { useBrowser } from "../store/browser";
import { Icon } from "./Icon";
import { credentialStoreName, credentialStoreTitle } from "../lib/commands";

/** The site as the card names it. Plain http keeps its scheme, so a login
 * sent in the clear does not read the same as one sent over https. */
function site(origin: string) {
  return origin.replace(/^https:\/\//, "");
}

/** Height of the floating find bar plus its gap, which owns the same corner. */
const FIND_OFFSET = 44;
/** Height of the crash notice row at the top of the content area. */
const CRASH_OFFSET = 36;

/**
 * The host's question about a login on the active tab, as a card at the top
 * of the page: save it, update it, or forget one whose password is gone.
 * Choosing among saved logins is not asked here: that list hangs under the
 * field in the page, where the person clicked.
 *
 * It is passive: it never takes the keyboard from the page. It arrives right
 * after a sign-in, often while the next page (a one-time code, a search box)
 * is being typed into, and a focused Save or Update button would take the next
 * Enter -- overwriting a good saved password with a mistyped one. The page
 * around it keeps taking clicks; it answers to the pointer, or to the
 * keyboard once someone tabs or clicks into it.
 */
export function CredentialPromptCard({ tabId }: { tabId: string | null }) {
  const prompt = useCredentialPrompt((s) => (tabId ? s.byTab[tabId] : undefined));
  const init = useCredentialPrompt((s) => s.init);
  const answer = useCredentialPrompt((s) => s.answer);
  const never = useCredentialPrompt((s) => s.never);
  const forget = useCredentialPrompt((s) => s.forget);
  const dismiss = useCredentialPrompt((s) => s.dismiss);
  const findOpen = useBrowser((s) => s.open.find);
  const crashed = useBrowser((s) => (tabId ? s.crashedTabs[tabId] !== undefined : false));
  const open = prompt !== undefined;
  useEffect(() => void init(), [init]);
  useCoversContent(open);
  if (!prompt) return null;
  const missing = prompt.kind === "missing";
  // Closing without deciding is "Not now": the host lets the password go
  // instead of holding it until the app quits.
  const close = () => (missing ? dismiss(prompt.tab_id) : void answer(prompt, false));
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const heading = missing
    ? `${credentialStoreTitle()} no longer has the password for ${prompt.username}`
    : prompt.kind === "update"
      ? `Update the password for ${site(prompt.origin)}?`
      : `Save the password for ${site(prompt.origin)}?`;
  const top = 8 + (findOpen ? FIND_OFFSET : 0) + (crashed ? CRASH_OFFSET : 0);
  return (
    <div
      role="dialog"
      aria-label={heading}
      data-overlay-passive
      onKeyDown={onKeyDown}
      style={{ top }}
      className="surface-enter absolute right-2 z-40 w-[340px] max-w-[calc(100%-16px)] rounded-2xl border border-line-2 bg-surface p-3 text-xs shadow-2xl"
    >
      <div className="flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2">
          <Icon icon={KeyRound} size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] leading-snug font-semibold text-ink [overflow-wrap:anywhere]">{heading}</h2>
          {missing ? (
            <p className="mt-0.5 text-[11px] text-ink-3">Forget this login for {site(prompt.origin)}, then sign in again to save it.</p>
          ) : (
            <>
              <p className="mt-0.5 truncate text-[11px] text-ink-2" title={prompt.username}>
                {prompt.username || "No username"}
              </p>
              <p className="text-[11px] text-ink-3">Kept in {credentialStoreName()} for this profile.</p>
            </>
          )}
        </div>
        <button type="button" aria-label="Close" title={missing ? "Close" : "Not now"} onClick={close} className="grid size-6 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink">
          <Icon icon={X} size={12} />
        </button>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        {prompt.kind === "save" && (
          <button type="button" onClick={() => void never(prompt)} className="mr-auto h-7 rounded-lg px-2 text-ink-3 hover:bg-surface-2 hover:text-ink">
            Never for this site
          </button>
        )}
        <button type="button" onClick={close} className="h-7 rounded-lg px-2.5 text-ink-2 hover:bg-surface-2 hover:text-ink">
          Not now
        </button>
        {missing ? (
          <button type="button" onClick={() => void forget(prompt)} className="h-7 rounded-lg bg-accent px-3 font-medium text-accent-ink hover:opacity-90">
            Forget login
          </button>
        ) : (
          <button type="button" onClick={() => void answer(prompt, true)} className="h-7 rounded-lg bg-accent px-3 font-medium text-accent-ink hover:opacity-90">
            {prompt.kind === "update" ? "Update" : "Save"}
          </button>
        )}
      </div>
    </div>
  );
}
