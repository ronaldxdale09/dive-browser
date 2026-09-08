import { AvatarImage } from "./AvatarImage";
import { Shield, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { colorName, PROFILE_COLORS, PROFILE_SEEDS, seedFromProfileName } from "../lib/profileAvatar";
import { useCoversContent } from "../lib/overlay";
import { useFadeClose } from "../lib/useFadeClose";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useBrowser } from "../store/browser";
import { Icon } from "./Icon";

/** Create or edit a profile: a name, a line under it, a face and a colour. */
export function ProfileDialog() {
  const editing = useBrowser((s) => s.editingProfile);
  if (!editing) return null;
  return <ProfileForm key={editing.id ?? "new"} id={editing.id} />;
}

function ProfileForm({ id }: { id: string | null }) {
  const profiles = useBrowser((s) => s.profiles);
  const workspaces = useBrowser((s) => s.workspaces);
  const setEditing = useBrowser((s) => s.setEditingProfile);
  const create = useBrowser((s) => s.createProfile);
  const update = useBrowser((s) => s.updateProfile);
  const remove = useBrowser((s) => s.deleteProfile);
  const existing = id ? profiles.find((p) => p.id === id) : undefined;
  const [name, setName] = useState(existing?.name ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [color, setColor] = useState(existing?.color ?? PROFILE_COLORS[0]!);
  // An empty seed follows the name, so the face changes as the name is
  // typed; picking one below pins it.
  const [seed, setSeed] = useState(existing?.avatar ?? "");
  const [confirming, setConfirming] = useState(false);
  useCoversContent(true);
  const root = useRef<HTMLDivElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  useFocusTrap(root, { initialFocus: nameField });
  const { close, className } = useFadeClose(() => setEditing(null));
  const avatar = seed || seedFromProfileName(name);
  const seeds = [seedFromProfileName(name), ...PROFILE_SEEDS.filter((s) => s !== seedFromProfileName(name))].slice(0, 12);
  const spaces = existing ? workspaces.filter((w) => w.profile_id === existing.id).length : 0;
  const last = profiles.length <= 1;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const draft = { name, color, avatar, note };
    if (existing) void update(existing.id, draft);
    else void create(draft);
  };

  return (
    <div ref={root} className={`fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] ${className}`} onMouseDown={close}>
      <form
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={existing ? "Edit profile" : "New profile"}
        onKeyDown={(e) => e.key === "Escape" && close()}
        className="mx-auto mt-24 w-[420px] rounded-2xl border border-line-2 bg-surface p-4 shadow-2xl"
      >
        <div className="flex items-center gap-3">
          <AvatarImage kind="profile" seed={avatar} color={color} alt="" width={44} height={44} className="size-11 shrink-0 rounded-full" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{existing ? "Edit profile" : "New profile"}</h2>
            <p className="text-[11px] text-ink-3">A profile is a person using Dive: its own cookies and logins, and its own workspaces.</p>
          </div>
        </div>

        <label className="mt-4 block text-[11px] text-ink-2">
          Name
          <input ref={nameField} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ronald" maxLength={40} required className="mt-1 h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-xs text-ink outline-none focus:border-highlight/60" />
        </label>
        <label className="mt-3 block text-[11px] text-ink-2">
          Shown under the name <span className="text-ink-3">(optional)</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Work · ronald@company.com" maxLength={80} className="mt-1 h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-xs text-ink outline-none focus:border-highlight/60" />
        </label>

        <p className="mt-4 text-[11px] text-ink-2">Face</p>
        <div role="radiogroup" aria-label="Face" className="mt-1.5 grid grid-cols-6 gap-2">
          {seeds.map((s) => (
            <button key={s} type="button" role="radio" aria-checked={avatar === s} aria-label={s === seedFromProfileName(name) ? "Face from the name" : `Face ${s}`} title={s === seedFromProfileName(name) ? "Face from the name" : s} onClick={() => setSeed(s)} className={`aspect-square rounded-full ring-offset-2 ring-offset-surface transition ${avatar === s ? "ring-2 ring-highlight" : "opacity-80 hover:opacity-100"}`}>
              <AvatarImage kind="profile" seed={s} color={color} alt="" className="size-full rounded-full" />
            </button>
          ))}
        </div>

        <p className="mt-4 text-[11px] text-ink-2">Colour</p>
        <div role="radiogroup" aria-label="Colour" className="mt-1.5 flex gap-2">
          {PROFILE_COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={colorName(c)} title={colorName(c)} onClick={() => setColor(c)} className={`size-7 rounded-full ring-offset-2 ring-offset-surface ${color === c ? "ring-2 ring-highlight" : ""}`} style={{ background: c }} />
          ))}
        </div>

        <p className="mt-4 flex items-center gap-1.5 text-[11px] text-ink-3">
          <Icon icon={Shield} size={12} />
          {existing ? `${spaces} ${spaces === 1 ? "workspace" : "workspaces"} · own cookies and logins` : "Starts with a Home workspace and its own cookies."}
        </p>

        <div className="mt-4 flex items-center gap-2">
          {existing && !confirming && (
            <button type="button" disabled={last} title={last ? "The last profile stays" : "Delete this profile and everything in it"} onClick={() => setConfirming(true)} className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-ink-3 hover:bg-surface-2 hover:text-danger disabled:opacity-40">
              <Icon icon={Trash2} size={13} /> Delete
            </button>
          )}
          {existing && confirming && (
            <>
              <span className="text-xs text-ink-2">Delete {existing.name} and its {spaces} {spaces === 1 ? "workspace" : "workspaces"}?</span>
              <button type="button" onClick={() => void remove(existing.id)} className="h-8 rounded-lg bg-danger px-3 text-xs font-medium text-white">
                Delete
              </button>
            </>
          )}
          <span className="flex-1" />
          <button type="button" onClick={close} className="h-8 rounded-lg px-3 text-xs text-ink-2 hover:bg-surface-2 hover:text-ink">
            Cancel
          </button>
          <button type="submit" disabled={!name.trim()} className="h-8 rounded-lg bg-accent px-3.5 text-xs font-medium text-accent-ink hover:brightness-110 disabled:opacity-40">
            {existing ? "Save" : "Create profile"}
          </button>
        </div>
      </form>
    </div>
  );
}
