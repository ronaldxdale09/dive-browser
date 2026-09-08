import { Check as CheckIcon, ClipboardPaste, Copy, RotateCcw } from "lucide-react";
import { useId, useState } from "react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Icon } from "../Icon";
import { Button, Group, Row, Segmented, Select, Switch } from "../SettingsFields";
import { DEFAULT_APPEARANCE, DEFAULT_PREFS, usePrefs } from "../../store/prefs";
import { colorName } from "../../lib/profileAvatar";
import type { Prefs } from "../../store/prefs";
import { CUSTOM_PRESET_ID, PRESETS, contrastRatio, exportTheme, findPreset, importTheme, isHex, presetSeeds, resolveScheme } from "../../lib/theme";
import type { Preset, Seeds } from "../../lib/theme";

const ACCENTS = ["#7FD8C8", "#8FB8F0", "#B79CF0", "#F0B35E", "#E58C8C", "#9ED67B", "#E9E9E9"];

const FONT_OPTIONS = [
  { value: "geist", label: "Geist" },
  { value: "system", label: "System" },
  { value: "mono", label: "Mono" },
  { value: "serif", label: "Serif" },
] as const;

/**
 * Settings › Appearance. Everything here writes straight to the preferences,
 * and the preferences land on the document root at once (store/prefs.ts), so
 * the preview at the top and the dialog around it both change as a control
 * is touched: the preview is drawn from the same tokens as the chrome.
 */
export function Appearance() {
  const prefs = usePrefs((s) => s.prefs);
  const update = usePrefs((s) => s.update);
  const set = (patch: Partial<Prefs>) => void update(patch);
  const preset = findPreset(prefs.appearance_preset);
  const custom = prefs.appearance_preset === CUSTOM_PRESET_ID;
  const fixed = preset !== undefined && preset.scheme !== "auto";
  const scheme = resolveScheme(prefs);

  return (
    <>
      <Preview scheme={scheme} note={fixed ? `This template is ${preset.scheme} only.` : custom ? "A custom template follows its background colour." : undefined} />

      <Group title="Templates" description="A template is three colours; the rest of the chrome is mixed from them.">
        <div role="radiogroup" aria-label="Template" className="grid grid-cols-2 gap-2 py-3 sm:grid-cols-3">
          {PRESETS.map((p) => (
            <TemplateCard key={p.id} preset={p} selected={prefs.appearance_preset === p.id} onSelect={() => set({ appearance_preset: p.id })} />
          ))}
          <TemplateCard
            preset={{ id: CUSTOM_PRESET_ID, name: "Custom", description: "Your own three colours.", scheme: "auto" }}
            seeds={{ ground: prefs.custom_ground, ink: prefs.custom_ink, highlight: prefs.custom_highlight }}
            selected={custom}
            onSelect={() => set({ appearance_preset: CUSTOM_PRESET_ID })}
          />
        </div>
      </Group>

      <Group title="Theme">
        <Row
          label="Mode"
          hint={fixed ? `${preset.name} is ${preset.scheme} only; choose Graphite or Custom to follow the system.` : custom ? "Custom follows the background colour you choose." : undefined}
          control={
            <div className={fixed || custom ? "opacity-40" : undefined} aria-disabled={fixed || custom || undefined}>
              <Segmented
                label="Mode"
                value={prefs.theme}
                onChange={(theme) => !(fixed || custom) && set({ theme })}
                options={[
                  { value: "system", label: "System" },
                  { value: "dark", label: "Dark" },
                  { value: "light", label: "Light" },
                ]}
              />
            </div>
          }
        />
        {custom && <CustomColours prefs={prefs} set={set} />}
        <Row
          label="Accent"
          hint="Highlights, focus rings and the active state. The first swatch keeps each template's own highlight."
          control={
            <div className="flex items-center gap-2">
              <div className="flex gap-2" role="radiogroup" aria-label="Accent">
                {ACCENTS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={c.toUpperCase() === prefs.accent.toUpperCase()}
                    aria-label={c === DEFAULT_PREFS.accent ? "Template accent" : colorName(c)}
                    title={c === DEFAULT_PREFS.accent ? "Template accent" : colorName(c)}
                    onClick={() => set({ accent: c })}
                    className="size-5 rounded-full ring-offset-2 ring-offset-surface aria-checked:ring-2 aria-checked:ring-ink"
                    style={{ background: c }}
                  />
                ))}
              </div>
              <ColourWell label="Custom accent" value={prefs.accent} onChange={(accent) => set({ accent })} />
            </div>
          }
        />
        <Row
          label="Tell pages the theme"
          hint={
            prefs.theme === "system" && !fixed && !custom
              ? "Available once the theme is set to Dark or Light; Dive cannot read the system setting on the page's behalf."
              : "Pages see prefers-color-scheme: " + scheme + ". The device menu's per-tab override still wins."
          }
          control={
            <Switch
              label="Tell pages the theme"
              disabled={prefs.theme === "system" && !fixed && !custom}
              checked={prefs.tell_pages_theme && (prefs.theme !== "system" || fixed || custom)}
              onChange={(tell_pages_theme) => set({ tell_pages_theme })}
            />
          }
        />
      </Group>

      <Group title="Type">
        <Row
          label="Font"
          hint={<span className="text-ink-2" style={{ fontFamily: "var(--font-sans)" }}>The quick brown fox jumps over the lazy dog 0123456789</span>}
          control={<Select label="Font" value={prefs.ui_font} onChange={(ui_font) => set({ ui_font })} options={FONT_OPTIONS} />}
        />
        <ScaleRow value={prefs.ui_scale} onChange={(ui_scale) => set({ ui_scale })} />
      </Group>

      <Group title="Layout">
        <Row
          label="Density"
          hint="Row heights and the space between controls."
          control={
            <Segmented
              label="Density"
              value={prefs.density}
              onChange={(density) => set({ density })}
              options={[
                { value: "compact", label: "Compact" },
                { value: "comfortable", label: "Comfortable" },
                { value: "relaxed", label: "Relaxed" },
              ]}
            />
          }
        />
        <Row
          label="Corners"
          control={
            <Segmented
              label="Corners"
              value={prefs.corner_radius}
              onChange={(corner_radius) => set({ corner_radius })}
              options={[
                { value: "sharp", label: "Sharp" },
                { value: "soft", label: "Soft" },
                { value: "round", label: "Round" },
              ]}
            />
          }
        />
        <Row
          label="Tabs"
          hint="Pill tabs sit on a surface; flat tabs mark the active one with a line."
          control={
            <Segmented
              label="Tabs"
              value={prefs.tab_style}
              onChange={(tab_style) => set({ tab_style })}
              options={[
                { value: "pill", label: "Pill" },
                { value: "flat", label: "Flat" },
              ]}
            />
          }
        />
      </Group>

      <Group title="Motion">
        <Row
          label="Animation"
          hint="Reduce stops loops and slides in the chrome; Full ignores the OS reduce-motion setting for the chrome alone."
          control={
            <Segmented
              label="Motion"
              value={prefs.motion}
              onChange={(motion) => set({ motion })}
              options={[
                { value: "system", label: "System" },
                { value: "reduce", label: "Reduce" },
                { value: "full", label: "Full" },
              ]}
            />
          }
        />
      </Group>

      <Group title="Welcome screen">
        <Row
          label="Background"
          hint="Welcome backgrounds stay still unless Motion is set to Full."
          control={
            <Segmented
              label="Welcome background"
              value={prefs.welcome_background}
              onChange={(welcome_background) => set({ welcome_background })}
              options={[
                { value: "orbs", label: "Orbs" },
                { value: "plain", label: "Plain" },
                { value: "gradient", label: "Gradient" },
              ]}
            />
          }
        />
      </Group>

      <Share prefs={prefs} set={set} />
    </>
  );
}

/** A mock of the chrome drawn from the live tokens, so it changes with them. */
function Preview({ scheme, note }: { scheme: "dark" | "light"; note?: string | undefined }) {
  return (
    <section className="mb-6" aria-label="Preview" data-scheme={scheme}>
      <div className="overflow-hidden rounded-xl border border-line bg-ground" data-testid="appearance-preview">
        <div className="flex h-[calc(var(--row-h)-2px)] items-center gap-[var(--ui-gap)] px-2">
          <span className="ml-1 size-2.5 rounded-full bg-line-2" aria-hidden />
          <span className="size-2.5 rounded-full bg-line-2" aria-hidden />
          <span className="mr-1 size-2.5 rounded-full bg-line-2" aria-hidden />
          <span className="tab-item flex h-[calc(var(--row-h)-10px)] w-20 items-center gap-1.5 px-2 text-[10px]" data-active>
            <span className="size-2 rounded-full bg-highlight" aria-hidden /> Dive
          </span>
          <span className="tab-item flex h-[calc(var(--row-h)-10px)] w-20 items-center gap-1.5 px-2 text-[10px]">
            <span className="size-2 rounded-full bg-ink-3" aria-hidden /> Docs
          </span>
          <span className="tab-item flex h-[calc(var(--row-h)-10px)] w-20 items-center gap-1.5 px-2 text-[10px]">
            <span className="size-2 rounded-full bg-ink-3" aria-hidden /> Local
          </span>
        </div>
        <div className="flex">
          <div className="flex w-10 flex-col items-center gap-[var(--ui-gap)] border-r border-line py-2">
            <span className="grid size-6 place-items-center rounded-full bg-surface-3 ring-1 ring-line-2">
              <span className="size-2.5 rounded-sm bg-highlight" aria-hidden />
            </span>
            <span className="grid size-6 place-items-center rounded-full">
              <span className="size-2.5 rotate-45 rounded-sm bg-ink-3" aria-hidden />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex h-[calc(var(--row-h)-2px)] items-center gap-[var(--ui-gap)] px-2">
              <span className="size-3 rounded-sm bg-surface-3" aria-hidden />
              <span className="size-3 rounded-sm bg-surface-3" aria-hidden />
              <span className="flex h-[calc(var(--row-h)-12px)] flex-1 items-center rounded-lg border border-line bg-surface px-2 text-[10px] text-ink-3">dive.local/settings</span>
            </div>
            <div className="border-t border-line bg-surface px-4 py-3">
              <p className="text-xs font-medium text-ink">Every surface, from three colours.</p>
              <p className="mt-0.5 text-[11px] text-ink-2">Ground, ink and highlight; the rest is mixed.</p>
              <span className="mt-2 inline-block rounded-full bg-highlight px-2.5 py-1 text-[10px] font-medium text-highlight-ink">Open a tab</span>
              <span className="ml-2 inline-block rounded-full border border-line-2 px-2.5 py-1 text-[10px] text-ink-2">Agent</span>
            </div>
          </div>
        </div>
      </div>
      {note && <p className="mt-1.5 text-[11px] text-ink-3">{note}</p>}
    </section>
  );
}

function TemplateCard({ preset, seeds, selected, onSelect }: { preset: Preset; seeds?: Seeds; selected: boolean; onSelect: () => void }) {
  const dots = seeds ?? preset.dark ?? preset.light!;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={preset.name}
      onClick={onSelect}
      className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-2.5 text-left transition-colors hover:border-line-2 aria-checked:border-highlight aria-checked:ring-1 aria-checked:ring-highlight"
    >
      <span className="flex items-center gap-1.5">
        <span className="flex -space-x-1" aria-hidden>
          <Dot colour={dots.ground} />
          <Dot colour={dots.ink} />
          <Dot colour={dots.highlight} />
        </span>
        <span className="text-xs font-medium text-ink">{preset.name}</span>
        {preset.scheme !== "auto" && <span className="ml-auto text-[10px] text-ink-3">{preset.scheme}</span>}
      </span>
      <span className="text-[11px] leading-snug text-ink-3">{preset.description}</span>
    </button>
  );
}

function Dot({ colour }: { colour: string }) {
  return <span className="size-3.5 rounded-full ring-1 ring-line-2" style={{ background: colour }} />;
}

function CustomColours({ prefs, set }: { prefs: Prefs; set: (patch: Partial<Prefs>) => void }) {
  const source = findPreset("graphite")!;
  const [from, setFrom] = useState(source.id);
  const fromPreset = findPreset(from) ?? source;
  const ratio = contrastRatio(prefs.custom_ink, prefs.custom_ground);
  const low = ratio < 4.5;
  return (
    <Row
      label="Custom colours"
      stacked
      hint={
        <span className={low ? "text-danger" : undefined} data-testid="contrast-readout">
          Text on background: {ratio.toFixed(1)}:1{low ? " — below 4.5, hard to read." : ""}
        </span>
      }
      control={
        <div className="flex flex-wrap items-end gap-3">
          <ColourField label="Background" value={prefs.custom_ground} onChange={(custom_ground) => set({ custom_ground })} />
          <ColourField label="Text" value={prefs.custom_ink} onChange={(custom_ink) => set({ custom_ink })} />
          <ColourField label="Highlight" value={prefs.custom_highlight} onChange={(custom_highlight) => set({ custom_highlight })} />
          <div className="flex items-center gap-1.5">
            <Select label="Start from template" value={from} onChange={setFrom} options={PRESETS.map((p) => ({ value: p.id, label: p.name }))} />
            <Button
              onClick={() => {
                const seeds = presetSeeds(fromPreset, fromPreset.scheme === "light" ? "light" : "dark") ?? fromPreset.dark ?? fromPreset.light!;
                set({ custom_ground: seeds.ground, custom_ink: seeds.ink, custom_highlight: seeds.highlight });
              }}
            >
              Start from {fromPreset.name}
            </Button>
          </div>
        </div>
      }
    />
  );
}

/** A colour picker beside a hex field; either one commits a valid hex. */
function ColourField({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-[11px] text-ink-3">
      {label}
      <span className="flex items-center gap-1.5">
        <ColourWell label={`${label} colour`} value={value} onChange={onChange} />
        <HexInput id={id} label={`${label} hex`} value={value} onCommit={onChange} />
      </span>
    </label>
  );
}

function ColourWell({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  return (
    <input
      type="color"
      aria-label={label}
      value={isHex(value) ? value.toLowerCase() : "#000000"}
      onChange={(e) => onChange(e.target.value.toUpperCase())}
      className="size-7 cursor-pointer rounded-md border border-line bg-surface-2 p-0.5"
    />
  );
}

function HexInput({ id, label, value, onCommit }: { id: string; label: string; value: string; onCommit: (hex: string) => void }) {
  const commit = (raw: string) => {
    const hex = raw.trim().startsWith("#") ? raw.trim() : `#${raw.trim()}`;
    if (isHex(hex) && hex.toUpperCase() !== value.toUpperCase()) onCommit(hex.toUpperCase());
  };
  return (
    <input
      id={id}
      aria-label={label}
      key={value}
      defaultValue={value.toUpperCase()}
      spellCheck={false}
      maxLength={7}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          e.currentTarget.value = value.toUpperCase();
          e.currentTarget.blur();
        }
      }}
      className="h-7 w-[84px] rounded-md border border-line bg-surface-2 px-2 font-mono text-[11px] text-ink outline-none select-text hover:border-line-2 focus:border-line-2"
    />
  );
}

function ScaleRow({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const id = useId();
  const percent = Math.round(value * 100);
  return (
    <Row
      label="Interface size"
      htmlFor={id}
      hint="Scales everything in the chrome; pages are unaffected."
      control={
        <div className="flex items-center gap-2">
          <input
            id={id}
            type="range"
            min={80}
            max={130}
            step={5}
            value={percent}
            aria-label="Interface size"
            aria-valuetext={`${percent}%`}
            onChange={(e) => onChange(Number(e.target.value) / 100)}
            className="w-36 accent-highlight"
          />
          <span className="w-10 text-right font-mono text-[11px] text-ink-2" data-testid="scale-value">{percent}%</span>
          <Button onClick={() => onChange(1)} disabled={value === 1}>Reset</Button>
        </div>
      }
    />
  );
}

function Share({ prefs, set }: { prefs: Prefs; set: (patch: Partial<Prefs>) => void }) {
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  const copy = async () => {
    try {
      await clipboard!.writeText(exportTheme(prefs));
      setStatus({ kind: "ok", text: "Theme copied. Paste it into another Dive to apply it." });
    } catch (e) {
      setStatus({ kind: "error", text: e instanceof Error ? e.message : "Could not reach the clipboard." });
    }
  };
  const paste = async () => {
    try {
      const text = await clipboard!.readText();
      set(importTheme(text));
      setStatus({ kind: "ok", text: "Theme applied." });
    } catch (e) {
      setStatus({ kind: "error", text: e instanceof Error ? e.message : "Could not read the clipboard." });
    }
  };
  return (
    <Group title="Share" description="A theme travels as a short block of text.">
      <Row
        label="Theme as text"
        hint={status ? <span className={status.kind === "error" ? "text-danger" : undefined} role={status.kind === "error" ? "alert" : "status"}>{status.text}</span> : "Copy this appearance to share it, or paste one that was shared with you."}
        control={
          <div className="flex gap-2">
            <Button onClick={() => void copy()} disabled={!clipboard}>
              <Inline icon={status?.kind === "ok" && status.text.startsWith("Theme copied") ? CheckIcon : Copy}>Copy theme</Inline>
            </Button>
            <Button onClick={() => void paste()} disabled={!clipboard}>
              <Inline icon={ClipboardPaste}>Paste theme</Inline>
            </Button>
          </div>
        }
      />
      <Row
        label="Reset appearance"
        hint="Back to Graphite, Geist, the default size and layout."
        control={
          <Button
            onClick={() => {
              set({ ...DEFAULT_APPEARANCE });
              setStatus(null);
            }}
          >
            <Inline icon={RotateCcw}>Reset appearance</Inline>
          </Button>
        }
      />
    </Group>
  );
}

function Inline({ icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <Icon icon={icon} size={13} />
      {children}
    </span>
  );
}
