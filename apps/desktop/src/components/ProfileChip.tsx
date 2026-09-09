import { useDismiss } from "../lib/useDismiss";
import { AvatarImage } from "./AvatarImage";
import { Check, ChevronDown, ChevronUp, Pencil, Plus, Shield } from "lucide-react";
import { useRef, useState, useCallback } from "react";
import { useCoversContent } from "../lib/overlay";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useBrowser } from "../store/browser";
import { Icon } from "./Icon";

/**
 * Who you are browsing as. A profile is a person: its own cookies and
 * logins, and its own workspaces in the rail. The menu switches profiles,
 * edits the current one, or makes a new one.
 *
 * It lives at the foot of the rail, under the workspaces it owns, so the
 * two levels read in one column: `row` when the rail is expanded, `avatar`
 * when it is marks alone; `pill` is the older title-bar form.
 */
export function ProfileChip({ variant = "pill", placement = "below" }: { variant?: "pill" | "row" | "avatar"; placement?: "below" | "above" }) {
  const profiles = useBrowser((s) => s.profiles);
  const activeProfile = useBrowser((s) => s.activeProfile);
  const workspaces = useBrowser((s) => s.workspaces);
  const counts = useBrowser((s) => s.counts);
  const activate = useBrowser((s) => s.activateProfile);
  const setEditing = useBrowser((s) => s.setEditingProfile);
  const [open, setOpen] = useState(false);
  const dismiss = useCallback(() => setOpen(false), []);
  const ref = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useCoversContent(open);
  useFocusTrap(menu, { active: open, menu: true });

  useDismiss(ref, open, dismiss);

  const current = profiles.find((p) => p.id === activeProfile) ?? profiles[0];
  if (!current) return null;
  const tabsOf = (profileId: string) => workspaces.filter((w) => w.profile_id === profileId).reduce((n, w) => n + (counts[w.id] ?? 0), 0);
  const spacesOf = (profileId: string) => workspaces.filter((w) => w.profile_id === profileId).length;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-label={`Profile: ${current.name}`}
        title={variant === "avatar" ? `${current.name} — switch profile` : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={
          variant === "row"
            ? "flex h-[var(--row-h)] w-full items-center gap-2.5 rounded-lg px-2 text-xs text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink aria-expanded:bg-surface-2"
            : variant === "avatar"
              ? "grid h-[var(--row-h)] w-9 place-items-center rounded-full transition-colors hover:bg-surface-2 aria-expanded:bg-surface-2"
              : "flex h-7 max-w-44 items-center gap-1.5 rounded-full border border-line pr-1.5 pl-1 text-xs text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
        }
      >
        <AvatarImage kind="profile" seed={current.avatar} color={current.color} alt="" width={variant === "pill" ? 20 : 28} height={variant === "pill" ? 20 : 28} className={variant === "pill" ? "size-5 shrink-0 rounded-full" : "size-7 shrink-0 rounded-full"} />
        {variant !== "avatar" && (
          <span className={variant === "row" ? "flex min-w-0 flex-1 flex-col items-start leading-tight" : "contents"}>
            <span className="truncate font-medium">{current.name}</span>
            {variant === "row" && <span className="truncate text-[10.5px] text-ink-3">Profile</span>}
          </span>
        )}
        {variant !== "avatar" && <Icon icon={placement === "above" ? ChevronUp : ChevronDown} size={12} className="shrink-0 text-ink-3" />}
      </button>
      {open && (
        <div ref={menu} role="menu" aria-label="Profiles" className={`absolute left-0 z-50 w-[300px] rounded-2xl border border-line-2 bg-surface p-1.5 shadow-2xl ${placement === "above" ? "bottom-full mb-1" : "top-9"}`}>
          <p className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">Profiles</p>
          {profiles.map((p) => {
            const isCurrent = p.id === current.id;
            return (
              <button
                key={p.id}
                type="button"
                role="menuitemradio"
                aria-checked={isCurrent}
                onClick={() => {
                  setOpen(false);
                  void activate(p.id);
                }}
                className={`flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-xs transition-colors hover:bg-surface-2 ${isCurrent ? "bg-surface-2 text-ink" : "text-ink-2"}`}
              >
                <AvatarImage kind="profile" seed={p.avatar} color={p.color} alt="" width={30} height={30} className="size-[30px] shrink-0 rounded-full" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{p.name}</span>
                  <span className="block truncate text-[10.5px] text-ink-3">{p.note || `${spacesOf(p.id)} ${spacesOf(p.id) === 1 ? "workspace" : "workspaces"} · ${tabsOf(p.id)} ${tabsOf(p.id) === 1 ? "tab" : "tabs"}`}</span>
                </span>
                <span className="grid shrink-0 place-items-center text-ink-3" title="Own cookies and logins">
                  <Icon icon={Shield} size={12} />
                </span>
                {isCurrent ? (
                  <Icon icon={Check} size={13} className="shrink-0 text-highlight" />
                ) : (
                  <span className="w-[13px]" aria-hidden />
                )}
              </button>
            );
          })}
          <div className="my-1.5 h-px bg-line" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setEditing({ id: current.id });
            }}
            className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-xs text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <span className="grid size-[30px] shrink-0 place-items-center rounded-full bg-surface-2 text-ink-3">
              <Icon icon={Pencil} size={13} />
            </span>
            Edit {current.name}…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setEditing({ id: null });
            }}
            className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-xs text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <span className="grid size-[30px] shrink-0 place-items-center rounded-full border border-dashed border-line-2 text-ink-3">
              <Icon icon={Plus} size={13} />
            </span>
            New profile…
          </button>
          <p className="px-2.5 pt-2 pb-1.5 text-[10.5px] leading-snug text-ink-3">Each profile keeps its own cookies, logins, history, bookmarks and workspaces, like a separate person using Dive.</p>
        </div>
      )}
    </div>
  );
}
