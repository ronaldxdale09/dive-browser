import { useEffect, useRef, useState } from "react";
import { AVATAR_SEEDS, seedFromName } from "../../lib/workspaceAvatar";
import { useBrowser } from "../../store/browser";
import { useOnboarding } from "../../store/onboarding";
import { AvatarImage } from "../AvatarImage";
import { StepActions } from "./Shell";

const SWATCHES = ["#7FD8C8", "#F0B35E", "#E58C8C", "#8FB8F0", "#B79CF0", "#9ED67B", "#E9E9E9"];
/** Names people reach for first; one click fills the field. */
const IDEAS = ["Work", "Side project", "Client", "Research"];

/**
 * Where the first tabs will live. The install's Home workspace is renamed
 * and coloured here; more come from the rail, each with its own logins.
 */
export function WorkspaceStep() {
  const workspaces = useBrowser((s) => s.workspaces);
  const activeWorkspace = useBrowser((s) => s.activeWorkspace);
  const update = useBrowser((s) => s.updateWorkspace);
  const next = useOnboarding((s) => s.next);
  const workspace = workspaces.find((w) => w.id === activeWorkspace) ?? workspaces[0];
  const [name, setName] = useState("");
  const [color, setColor] = useState(workspace?.color ?? SWATCHES[0]!);
  const [seed, setSeed] = useState("");
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus({ preventScroll: true });
  }, []);
  const icon = seed || seedFromName(name || workspace?.name || "Home");
  const seeds = [seedFromName(name), ...AVATAR_SEEDS.filter((s) => s !== seedFromName(name))].slice(0, 8);

  const submit = async () => {
    if (!workspace || !name.trim()) return;
    setSaving(true);
    try {
      await update(workspace.id, { name: name.trim(), color, icon });
      next();
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-4">
        <AvatarImage kind="workspace" seed={icon} color={color} alt="" width={56} height={56} className="size-14 shrink-0 rounded-2xl" />
        <div className="min-w-0">
          <p className="font-mono text-[10.5px] tracking-[0.18em] text-highlight uppercase">Step 2 of 3</p>
          <h2 className="mt-1 text-lg font-semibold tracking-[-0.02em]">Your first workspace</h2>
          <p className="mt-0.5 text-xs text-ink-3">A workspace is a set of tabs for one thing you do. Switch between them with ⌘1 to ⌘9.</p>
        </div>
      </div>
      <label className="mt-6 block text-[11px] text-ink-2">
        Name
        <input
          ref={field}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={workspace?.name ?? "Home"}
          maxLength={40}
          className="mt-1 h-10 w-full rounded-xl border border-line bg-surface-2 px-3 text-sm text-ink outline-none placeholder:text-ink-3 focus:border-line-2"
        />
      </label>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {IDEAS.map((idea) => (
          <button key={idea} type="button" onClick={() => setName(idea)} className="pressable h-7 rounded-full border border-line px-2.5 text-[11px] text-ink-2 hover:bg-surface-2 hover:text-ink">
            {idea}
          </button>
        ))}
      </div>
      <div className="mt-5 grid grid-cols-[1fr_auto] items-start gap-6">
        <div>
          <p className="text-[11px] text-ink-2">Mark</p>
          <div role="radiogroup" aria-label="Mark" className="mt-1.5 grid grid-cols-8 gap-2">
            {seeds.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={s === icon} aria-label={s.replace(/-/g, " ")} onClick={() => setSeed(s)} className="grid aspect-square place-items-center rounded-lg ring-offset-2 ring-offset-surface aria-checked:ring-2 aria-checked:ring-highlight">
                <AvatarImage kind="workspace" seed={s} color={color} alt="" className="size-full rounded-lg" />
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="text-[11px] text-ink-2">Colour</p>
          <div role="radiogroup" aria-label="Colour" className="mt-1.5 grid grid-cols-4 gap-2">
            {SWATCHES.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={c === color} aria-label={c} onClick={() => setColor(c)} className="size-6 rounded-full ring-offset-2 ring-offset-surface aria-checked:ring-2 aria-checked:ring-highlight" style={{ background: c }} />
            ))}
          </div>
        </div>
      </div>
      <StepActions primary={saving ? "Saving…" : "Continue"} disabled={!name.trim() || saving} onPrimary={() => void submit()} skip={next} />
    </form>
  );
}
