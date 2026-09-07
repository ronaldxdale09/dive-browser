import { useEffect, useRef, useState } from "react";
import { PROFILE_COLORS, PROFILE_SEEDS, seedFromProfileName } from "../../lib/profileAvatar";
import { useBrowser } from "../../store/browser";
import { useOnboarding } from "../../store/onboarding";
import { AvatarImage } from "../AvatarImage";
import { StepActions } from "./Shell";

/**
 * Who is diving. A fresh install already has one profile, so this step
 * names it rather than making a second; Skip keeps it as it is.
 */
export function ProfileStep() {
  const profiles = useBrowser((s) => s.profiles);
  const activeProfile = useBrowser((s) => s.activeProfile);
  const update = useBrowser((s) => s.updateProfile);
  const next = useOnboarding((s) => s.next);
  const profile = profiles.find((p) => p.id === activeProfile) ?? profiles[0];
  const [name, setName] = useState("");
  const [color, setColor] = useState(profile?.color ?? PROFILE_COLORS[0]!);
  const [seed, setSeed] = useState("");
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus({ preventScroll: true });
  }, []);
  const avatar = seed || seedFromProfileName(name || profile?.name || "");
  const seeds = [seedFromProfileName(name), ...PROFILE_SEEDS.filter((s) => s !== seedFromProfileName(name))].slice(0, 8);

  const submit = async () => {
    if (!profile || !name.trim()) return;
    setSaving(true);
    try {
      await update(profile.id, { name: name.trim(), color, avatar, note: profile.note });
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
        <AvatarImage kind="profile" seed={avatar} color={color} alt="" width={56} height={56} className="size-14 shrink-0 rounded-full" />
        <div className="min-w-0">
          <p className="font-mono text-[10.5px] tracking-[0.18em] text-highlight uppercase">Step 1 of 3</p>
          <h2 className="mt-1 text-lg font-semibold tracking-[-0.02em]">Who's diving?</h2>
          <p className="mt-0.5 text-xs text-ink-3">A profile keeps its own cookies, logins and workspaces. Add more later for work and clients.</p>
        </div>
      </div>
      <label className="mt-6 block text-[11px] text-ink-2">
        Your name
        <input
          ref={field}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={profile?.name ?? "Personal"}
          maxLength={40}
          className="mt-1 h-10 w-full rounded-xl border border-line bg-surface-2 px-3 text-sm text-ink outline-none placeholder:text-ink-3 focus:border-line-2"
        />
      </label>
      <div className="mt-5 grid grid-cols-[1fr_auto] items-start gap-6">
        <div>
          <p className="text-[11px] text-ink-2">Face</p>
          <div role="radiogroup" aria-label="Face" className="mt-1.5 grid grid-cols-8 gap-2">
            {seeds.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={avatar === s} aria-label={`Face ${s}`} onClick={() => setSeed(s)} className={`aspect-square rounded-full ring-offset-2 ring-offset-surface ${avatar === s ? "ring-2 ring-highlight" : "opacity-75 hover:opacity-100"}`}>
                <AvatarImage kind="profile" seed={s} color={color} alt="" className="size-full rounded-full" />
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="text-[11px] text-ink-2">Colour</p>
          <div role="radiogroup" aria-label="Colour" className="mt-1.5 grid grid-cols-4 gap-2">
            {PROFILE_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} onClick={() => setColor(c)} className={`size-6 rounded-full ring-offset-2 ring-offset-surface ${color === c ? "ring-2 ring-highlight" : ""}`} style={{ background: c }} />
            ))}
          </div>
        </div>
      </div>
      <StepActions primary={saving ? "Saving…" : "Continue"} disabled={!name.trim() || saving} onPrimary={() => void submit()} skip={next} />
    </form>
  );
}
