import { AvatarImage } from "./AvatarImage";
import { Shield, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { useBrowser } from "../store/browser";
import { AVATAR_SEEDS, seedFromName } from "../lib/workspaceAvatar";
import { colorName } from "../lib/profileAvatar";
import { Icon } from "./Icon";
import { useCoversContent } from "../lib/overlay";
import { useFadeClose } from "../lib/useFadeClose";
import { useFocusTrap } from "../lib/useFocusTrap";

const SWATCHES = ["#7FD8C8", "#F0B35E", "#E58C8C", "#8FB8F0", "#B79CF0", "#9ED67B", "#E9E9E9"];

/** Create or edit a workspace. Opened from the rail. */
export function WorkspaceDialog() {
  const editing = useBrowser((s) => s.editing);
  const workspaces = useBrowser((s) => s.workspaces);
  const setEditing = useBrowser((s) => s.setEditing);
  const create = useBrowser((s) => s.createWorkspace);
  const update = useBrowser((s) => s.updateWorkspace);
  const remove = useBrowser((s) => s.deleteWorkspace);
  const existing = editing?.id ? workspaces.find((w) => w.id === editing.id) : undefined;
  const [name, setName] = useState(existing?.name ?? "");
  const [color, setColor] = useState(existing?.color ?? SWATCHES[0]!);
  // An empty seed follows the name, so a new workspace already has a mark
  // while it is being typed; picking one below pins it.
  const [seed, setSeed] = useState(existing?.icon ?? "");
  const [separate, setSeparate] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const count = useBrowser((s) => (existing ? (s.counts[existing.id] ?? 0) : 0));
  useCoversContent(Boolean(editing));
  const root = useRef<HTMLDivElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  useFocusTrap(root, { active: Boolean(editing), initialFocus: nameField });
  const { close, className } = useFadeClose(() => setEditing(null));
  if (!editing) return null;
  const icon = seed || seedFromName(name);
  // The current choices lead their rows even when they are not in the
  // palette: the first workspace is created with its own colour and mark,
  // and without this the dialog showed nothing selected.
  const swatches = existing && !SWATCHES.includes(existing.color) ? [existing.color, ...SWATCHES] : SWATCHES;
  const named = seedFromName(name);
  const lead = [...new Set([...(existing?.icon ? [existing.icon] : []), named])];
  const seeds = [...lead, ...AVATAR_SEEDS.filter((s) => !lead.includes(s))].slice(0, 14);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (existing) void update(existing.id, { name, color, icon });
    else void create({ name, color, icon }, separate);
  };

  return (
    <div ref={root} className={`overlay-backdrop fixed inset-0 z-50 ${className}`} onMouseDown={close}>
      <form
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={existing ? "Edit workspace" : "New workspace"}
        onKeyDown={(e) => e.key === "Escape" && close()}
        className="mx-auto mt-28 w-[380px] rounded-2xl border border-line-2 bg-surface p-4 shadow-2xl"
      >
        <div className="flex items-center gap-2.5">
          <AvatarImage kind="workspace" seed={icon} color={color} alt="" width={32} height={32} className="size-8 shrink-0 rounded-[11px]" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{existing ? "Edit workspace" : "New workspace"}</h2>
            {/* Someone meeting workspaces for the first time meets them here,
                so the dialog says what one is rather than assuming. */}
            <p className="text-[11px] text-ink-3">
              {existing ? `${count} ${count === 1 ? "tab" : "tabs"} live here` : "A separate set of tabs, with its own logins if you want them."}
            </p>
          </div>
        </div>
        <label className="mt-3 block text-xs text-ink-2">
          Name
          <input
            ref={nameField}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder="Client, Side project, Research…"
            className="mt-1 h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm text-ink outline-none placeholder:text-ink-3 focus:border-highlight/60"
          />
        </label>
        <div className="mt-3 text-xs text-ink-2">Color</div>
        <div className="mt-1 flex gap-2" role="radiogroup" aria-label="Color">
          {swatches.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={c === color}
              aria-label={SWATCHES.includes(c) ? colorName(c) : "Current colour"}
              title={SWATCHES.includes(c) ? colorName(c) : "Current colour"}
              onClick={() => setColor(c)}
              className="size-6 rounded-full ring-offset-2 ring-offset-surface aria-checked:ring-2 aria-checked:ring-ink"
              style={{ background: c }}
            />
          ))}
        </div>
        <div className="mt-4 text-xs text-ink-2">Mark</div>
        <div className="mt-1.5 grid grid-cols-7 gap-1.5" role="radiogroup" aria-label="Mark">
          {seeds.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={s === icon}
              aria-label={s === named && s !== existing?.icon ? "Mark from the name" : s.replace(/-/g, " ")}
              title={s === named && s !== existing?.icon ? "Mark from the name" : s.replace(/-/g, " ")}
              onClick={() => setSeed(s)}
              // The ring alone marks the choice: the marks are already colored,
              // so tinting the cell as well would just add noise.
              className="grid size-8 place-items-center rounded-lg ring-offset-2 ring-offset-surface aria-checked:ring-2 aria-checked:ring-ink"
            >
              <AvatarImage kind="workspace" seed={s} color={color} alt="" width={28} height={28} className="size-7 rounded-lg" />
            </button>
          ))}
        </div>
        {existing && (
          <p className="mt-4 flex items-center gap-1.5 text-[11px] text-ink-3">
            <Icon icon={Shield} size={12} />
            {workspaces.filter((other) => other.container_id === existing.container_id).length === 1
              ? "Its own cookies and logins, chosen when it was created."
              : "Shares cookies and logins with another workspace, chosen when it was created."}
          </p>
        )}
        {!existing && (
          <label className="mt-4 flex items-start gap-2 text-xs text-ink-2">
            <input type="checkbox" checked={separate} onChange={(e) => setSeparate(e.target.checked)} className="mt-0.5 accent-highlight" />
            <span>
              <span className="flex items-center gap-1.5 text-ink">
                <Icon icon={Shield} size={12} /> Separate cookies and logins
              </span>
              <span className="text-[11px] text-ink-3">Its own browser profile, so you can be signed in as two people at once.</span>
            </span>
          </label>
        )}
        {confirming ? (
          <div className="mt-5 rounded-lg border border-line bg-surface-2 p-3">
            <p className="text-xs text-ink-2">
              Delete {existing?.name} and close its {count} {count === 1 ? "tab" : "tabs"}? Its history and cookies stay on disk.
            </p>
            <div className="mt-3 flex gap-2">
              <span className="flex-1" />
              <button type="button" onClick={() => setConfirming(false)} className="h-8 rounded-full px-3 text-xs text-ink-2 hover:bg-surface-3">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => existing && void remove(existing.id)}
                className="h-8 rounded-full bg-danger px-4 text-xs font-medium text-danger-ink"
              >
                Delete workspace
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-5 flex items-center gap-2">
            {existing && workspaces.length > 1 && (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="flex h-8 items-center gap-1.5 rounded-full px-3 text-xs text-danger hover:bg-surface-2"
              >
                <Icon icon={Trash2} size={13} /> Delete
              </button>
            )}
            <span className="flex-1" />
            <button type="button" onClick={close} className="h-8 rounded-full px-3 text-xs text-ink-2 hover:bg-surface-2">
              Cancel
            </button>
            <button type="submit" disabled={!name.trim()} className="h-8 rounded-full bg-accent px-4 text-xs font-medium text-accent-ink disabled:opacity-40">
              {existing ? "Save" : "Create"}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
