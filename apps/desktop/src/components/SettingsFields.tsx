import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
export { Select } from "./Select";

/**
 * Form primitives for the settings dialog. They exist so every setting is
 * laid out the same way: a label and its explanation on the left, the control
 * on the right, hairlines between rows.
 */

/** A titled block of rows. */
export function Group({ title, description, children, id }: { title: string; description?: string; children: ReactNode; id?: string }) {
  return (
    <section className="mb-6" id={id}>
      <h4 className="text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">{title}</h4>
      {description && <p className="mt-1 text-xs text-ink-2">{description}</p>}
      <div className="mt-2 rounded-xl border border-line bg-surface-2/40 px-3.5">{children}</div>
    </section>
  );
}

/**
 * One setting: text on the left, control on the right. When the panel is
 * narrower than about 560px -- the window at its minimum width -- the control
 * goes under its label instead of squeezing the label into a column a few
 * words wide. The panel is a size container (SettingsDialog), so this follows
 * the panel, not the window.
 */
export function Row({
  label,
  hint,
  control,
  htmlFor,
  stacked = false,
}: {
  label: string;
  hint?: ReactNode;
  control: ReactNode;
  htmlFor?: string;
  stacked?: boolean;
}) {
  return (
    <div data-settings-row className={`flex gap-2 border-b border-line py-3 last:border-b-0 ${stacked ? "flex-col" : "flex-col @min-[560px]:flex-row @min-[560px]:items-center @min-[560px]:gap-4"}`}>
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="text-xs font-medium text-ink">
          {label}
        </label>
        {hint && <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">{hint}</p>}
      </div>
      <div className={stacked ? "w-full" : "max-w-full min-w-0 shrink-0"}>{control}</div>
    </div>
  );
}

/** On/off control. A switch rather than a checkbox: these apply immediately. */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative h-[22px] w-[38px] shrink-0 rounded-full border border-line-2 bg-surface-3 transition-colors aria-checked:border-highlight aria-checked:bg-highlight disabled:opacity-40"
    >
      <span
        className="absolute top-[2px] left-[2px] size-4 rounded-full bg-ink-2 transition-transform"
        style={checked ? { transform: "translateX(16px)", background: "var(--color-accent-ink)" } : undefined}
      />
    </button>
  );
}

/** A row of mutually exclusive choices, for two to four short options. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string }[];
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className="h-7 rounded-[7px] px-2.5 text-xs text-ink-2 hover:text-ink aria-checked:bg-surface-3 aria-checked:text-ink"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * What a text field shows: the host's value, or the edit being typed. Once a
 * commit settles, the field shows what the host kept -- a value it refused or
 * corrected (a folder it expanded, an address it trimmed) is not left on
 * screen looking saved. Keyed on nothing, so focus survives the round trip.
 */
function useCommittedText(value: string, onCommit: (v: string) => void | Promise<unknown>) {
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(value);
  }
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  });
  const commit = (text: string) => {
    if (text === value) return;
    void Promise.resolve(onCommit(text)).finally(() => setDraft(latest.current));
  };
  return { draft, setDraft, commit, revert: () => setDraft(value) };
}

/** Single-line text setting. Committed on blur or Enter, never per keystroke. */
export function TextInput({
  value,
  onCommit,
  placeholder,
  label,
  id,
  mono = false,
  width = "w-[240px]",
  invalid = false,
  describedBy,
}: {
  value: string;
  onCommit: (v: string) => void | Promise<unknown>;
  placeholder?: string;
  label: string;
  id?: string;
  mono?: boolean;
  width?: string;
  /** The saved value will be ignored; the row's hint says why. */
  invalid?: boolean;
  describedBy?: string;
}) {
  const { draft, setDraft, commit, revert } = useCommittedText(value, onCommit);
  return (
    <input
      id={id}
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      data-settings-field
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        // Escape with an edit in the field takes the edit back and stops
        // there; it used to go on and close the whole of Settings with it.
        // In a field that was not changed, it closes Settings as usual.
        if (e.key === "Escape" && draft !== value) {
          e.stopPropagation();
          revert();
        }
      }}
      className={`h-8 max-w-full rounded-lg border bg-surface-2 px-2.5 text-xs text-ink outline-none select-text placeholder:text-ink-3 hover:border-line-2 focus:border-highlight/60 ${invalid ? "border-warn" : "border-line"} ${mono ? "font-mono" : ""} ${width}`}
    />
  );
}

/** Multi-line text setting, one value per line. Committed on blur. */
export function TextArea({
  value,
  onCommit,
  placeholder,
  label,
  rows = 4,
}: {
  value: string;
  onCommit: (v: string) => void | Promise<unknown>;
  placeholder?: string;
  label: string;
  rows?: number;
}) {
  const { draft, setDraft, commit, revert } = useCommittedText(value, onCommit);
  return (
    <textarea
      aria-label={label}
      value={draft}
      rows={rows}
      placeholder={placeholder}
      spellCheck={false}
      data-settings-field
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        // As in TextInput: Escape takes back an edit before it closes anything.
        if (e.key === "Escape" && draft !== value) {
          e.stopPropagation();
          revert();
        }
      }}
      className="w-full resize-none rounded-lg border border-line bg-surface-2 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink outline-none select-text placeholder:text-ink-3 hover:border-line-2 focus:border-highlight/60"
    />
  );
}

/** Checkbox with a label, for choices confirmed by a button. */
export function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-xs text-ink-2">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-highlight" />
      {label}
    </label>
  );
}

/** Pill button in the dialog's two weights. */
export function Button({
  children,
  onClick,
  variant = "quiet",
  disabled = false,
  ariaLabel,
}: {
  children: ReactNode;
  onClick: () => void;
  variant?: "quiet" | "primary" | "danger";
  disabled?: boolean;
  /** A fuller name than the visible text, where several buttons read the same ("Remove"). */
  ariaLabel?: string;
}) {
  const tone =
    variant === "primary"
      ? "bg-accent text-accent-ink hover:opacity-90"
      : variant === "danger"
        ? "border border-line text-danger hover:bg-surface-3"
        : "border border-line text-ink-2 hover:bg-surface-3 hover:text-ink";
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={ariaLabel} className={`h-8 shrink-0 rounded-full px-3.5 text-xs disabled:opacity-40 ${tone}`}>
      {children}
    </button>
  );
}
