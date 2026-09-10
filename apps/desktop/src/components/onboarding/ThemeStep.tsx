import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CUSTOM_PRESET_ID, PRESETS, type Preset, type Seeds } from "../../lib/theme";
import { usePrefs } from "../../store/prefs";
import { useOnboarding } from "../../store/onboarding";
import { Icon } from "../Icon";
import { StepActions, stepLabel } from "./Shell";

/**
 * Pick the chrome's colours. The whole window re-paints on click, so the
 * choice is its own preview and the card needs no mock browser inside it.
 *
 * Deliberately smaller than Settings › Appearance: swatches and a name, no
 * descriptions, and none of the mode, accent, font or density controls. A
 * first run should be one glance and one click; Settings has the rest, and
 * this step says so.
 */
export function ThemeStep() {
  const prefs = usePrefs((s) => s.prefs);
  const update = usePrefs((s) => s.update);
  const next = useOnboarding((s) => s.next);
  // The template applies immediately, so leaving the step is just Continue;
  // a save that fails should not trap anyone on this screen.
  const [saving, setSaving] = useState(false);
  // The heading takes focus as the step arrives, like every other step, so
  // the keyboard and a screen reader follow the dialog rather than the chrome.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  const selected = prefs.appearance_preset;
  const custom: Preset = { id: CUSTOM_PRESET_ID, name: "Custom", description: "", scheme: "auto" };
  const customSeeds: Seeds = { ground: prefs.custom_ground, ink: prefs.custom_ink, highlight: prefs.custom_highlight };

  const choose = (id: string) => {
    setSaving(true);
    void update({ appearance_preset: id }).finally(() => setSaving(false));
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        next();
      }}
    >
      <div className="flex items-center gap-4">
        <span aria-hidden className="grid size-14 shrink-0 place-items-center rounded-2xl border border-line-2 bg-surface">
          <span className="flex -space-x-1.5">
            <Swatch colour="var(--color-ground)" size={5} />
            <Swatch colour="var(--color-ink)" size={5} />
            <Swatch colour="var(--color-highlight)" size={5} />
          </span>
        </span>
        <div className="min-w-0">
          <p className="font-mono text-[10.5px] tracking-[0.18em] text-highlight uppercase">{stepLabel("theme")}</p>
          <h2 ref={heading} tabIndex={-1} className="mt-1 text-lg font-semibold tracking-[-0.02em] outline-none">Make it yours</h2>
          <p className="mt-0.5 text-xs text-ink-3">A template is three colours — ground, ink and highlight; the rest of the chrome is mixed from them.</p>
        </div>
      </div>

      <div role="radiogroup" aria-label="Template" className="mt-5 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {PRESETS.map((preset) => (
          <TemplateTile key={preset.id} preset={preset} selected={selected === preset.id} onSelect={() => choose(preset.id)} />
        ))}
        <TemplateTile preset={custom} seeds={customSeeds} selected={selected === CUSTOM_PRESET_ID} onSelect={() => choose(CUSTOM_PRESET_ID)} />
      </div>

      <p className="mt-3 text-[11px] text-ink-3">Mode, accent, font and density live in Settings › Appearance.</p>
      <StepActions primary="Continue" disabled={saving} onPrimary={next} />
    </form>
  );
}

/**
 * One template: its three colours and its name. A tick rather than a ring
 * alone, so the chosen one still reads at a glance on a light template where
 * a highlight ring is faint.
 */
function TemplateTile({ preset, seeds, selected, onSelect }: { preset: Preset; seeds?: Seeds; selected: boolean; onSelect: () => void }) {
  const dots = seeds ?? preset.dark ?? preset.light!;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={preset.name}
      onClick={onSelect}
      className="group flex items-center gap-2 rounded-lg border border-line bg-surface px-2 py-1.5 text-left transition-colors hover:border-line-2 hover:bg-surface-2 aria-checked:border-highlight aria-checked:ring-1 aria-checked:ring-highlight"
    >
      <span className="flex shrink-0 -space-x-1" aria-hidden>
        <Swatch colour={dots.ground} />
        <Swatch colour={dots.ink} />
        <Swatch colour={dots.highlight} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink">{preset.name}</span>
      {selected && <Icon icon={Check} size={12} className="shrink-0 text-highlight" />}
    </button>
  );
}

function Swatch({ colour, size = 3 }: { colour: string; size?: number }) {
  return <span className="rounded-full ring-1 ring-line-2" style={{ background: colour, width: `${size * 4}px`, height: `${size * 4}px` }} />;
}
