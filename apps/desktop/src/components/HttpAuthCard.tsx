import { KeyRound, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCoversContent } from "../lib/overlay";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useHttpAuth } from "../store/httpAuth";
import { Icon } from "./Icon";

/**
 * A server or proxy asking who you are, as a card over the page.
 *
 * Two things are said out loud rather than left to be inferred. A proxy
 * asking is not the site asking, and a password typed here goes to the
 * proxy — people hand over site passwords to proxy prompts. And Basic auth
 * over http is the password itself on the wire, readable by anything in
 * between, which is worth knowing before typing rather than after.
 */
export function HttpAuthCard({ tabId, takesFocus = true }: { tabId: string | null; /** Off while another card above it holds the keyboard. */ takesFocus?: boolean }) {
  const asked = useHttpAuth((s) => (tabId ? s.byTab[tabId]?.[0] : undefined));
  const recover = useHttpAuth((s) => s.recover);
  const answer = useHttpAuth((s) => s.answer);
  const panel = useRef<HTMLDivElement>(null);
  const userField = useRef<HTMLInputElement>(null);
  // The typed answer belongs to one challenge; the next starts empty without
  // an effect having to clear anything.
  const [draft, setDraft] = useState<{ id: string; user: string; password: string }>();
  const open = asked !== undefined;
  useEffect(() => {
    if (tabId) void recover(tabId);
  }, [recover, tabId]);
  useCoversContent(open);
  useFocusTrap(panel, {
    active: open && takesFocus,
    initialFocus: userField,
    onEscape: () => asked && void answer(asked, null, ""),
  });
  if (!asked) return null;

  const mine: { id: string; user: string; password: string } =
    draft?.id === asked.request_id ? draft : { id: asked.request_id, user: "", password: "" };
  const signIn = () => void answer(asked, mine.user, mine.password);
  const cancel = () => void answer(asked, null, "");
  const plain = !asked.secure && asked.scheme === "basic";

  return (
    <div
      ref={panel}
      role="alertdialog"
      aria-label={`Sign in to ${asked.host}`}
      className="surface-enter w-[380px] max-w-full rounded-2xl border border-line-2 bg-surface p-3 text-xs shadow-2xl"
      onKeyDown={(e) => {
        // A focused button answers Enter itself, so Enter on Cancel cancels.
        // From a field it signs in, but only once there is a name to send:
        // an empty username is a half-filled form, not an answer.
        if (e.target instanceof HTMLButtonElement) return;
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (mine.user) signIn();
        }
      }}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-px grid size-6 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2">
          <Icon icon={asked.is_proxy ? ShieldAlert : KeyRound} size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-ink">
            {asked.is_proxy ? "The proxy wants you to sign in" : `Sign in to ${asked.host}`}
          </h2>
          <p className="mt-0.5 text-ink-2">
            {asked.is_proxy
              ? `${asked.host} is between you and the page. This is not the site asking — do not give it a site password.`
              : asked.realm
                ? `This server calls the protected area “${asked.realm}”.`
                : "This server is protected."}
          </p>
        </div>
      </div>

      {plain && (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-warn/10 px-2 py-1.5 text-[11px] text-ink-2">
          <Icon icon={ShieldAlert} size={12} className="mt-px shrink-0 text-warn" />
          This connection is not encrypted, so the password is readable by anything on the way to {asked.host}.
        </p>
      )}

      <div className="mt-2.5 flex flex-col gap-1.5">
        <input
          ref={userField}
          id="http-auth-user"
          aria-label="Username"
          autoComplete="username"
          placeholder="Username"
          value={mine.user}
          onChange={(e) => setDraft({ ...mine, user: e.target.value })}
          className="h-8 rounded-lg border border-line bg-surface-2 px-2.5 text-xs text-ink outline-none focus:border-highlight/60"
        />
        <input
          id="http-auth-password"
          aria-label="Password"
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          value={mine.password}
          onChange={(e) => setDraft({ ...mine, password: e.target.value })}
          className="h-8 rounded-lg border border-line bg-surface-2 px-2.5 text-xs text-ink outline-none focus:border-highlight/60"
        />
      </div>

      <div className="mt-2.5 flex justify-end gap-1.5">
        <button
          type="button"
          onClick={cancel}
          className="h-7 rounded-lg border border-line px-3 text-[11px] text-ink-2 hover:bg-surface-2 hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={signIn}
          disabled={!mine.user}
          className="h-7 rounded-lg bg-accent px-3 text-[11px] font-medium text-accent-ink disabled:opacity-45"
        >
          Sign in
        </button>
      </div>
    </div>
  );
}
