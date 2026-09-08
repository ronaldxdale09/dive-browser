import { ChevronDown } from "lucide-react";
import { useId } from "react";
import type { ReactNode } from "react";
import { Icon } from "./Icon";

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

/** One setting: text on the left, control on the right. */
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
    <div className={`flex gap-4 border-b border-line py-3 last:border-b-0 ${stacked ? "flex-col" : "items-center"}`}>
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="text-xs font-medium text-ink">
          {label}
        </label>
        {hint && <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">{hint}</p>}
      </div>
      <div className={stacked ? "w-full" : "shrink-0"}>{control}</div>
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

/** Dropdown for a closed set of choices. */
export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  id,
  disabled = false,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string }[];
  label: string;
  id?: string;
  disabled?: boolean;
}) {
  return (
    <span className="relative inline-flex items-center">
      <select
        id={id}
        aria-label={label}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-8 appearance-none rounded-lg border border-line bg-surface-2 py-0 pr-7 pl-2.5 text-xs text-ink outline-none hover:border-line-2 focus:border-highlight/60 disabled:opacity-40"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon icon={ChevronDown} size={13} className="pointer-events-none absolute right-2 text-ink-3" />
    </span>
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

/** Single-line text setting. Committed on blur or Enter, never per keystroke. */
export function TextInput({
  value,
  onCommit,
  placeholder,
  label,
  id,
  mono = false,
  width = "w-[240px]",
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  label: string;
  id?: string;
  mono?: boolean;
  width?: string;
}) {
  return (
    <input
      id={id}
      aria-label={label}
      defaultValue={value}
      key={value}
      placeholder={placeholder}
      spellCheck={false}
      onBlur={(e) => e.target.value !== value && onCommit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          e.currentTarget.value = value;
          e.currentTarget.blur();
        }
      }}
      className={`h-8 rounded-lg border border-line bg-surface-2 px-2.5 text-xs text-ink outline-none select-text placeholder:text-ink-3 hover:border-line-2 focus:border-highlight/60 ${mono ? "font-mono" : ""} ${width}`}
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
  onCommit: (v: string) => void;
  placeholder?: string;
  label: string;
  rows?: number;
}) {
  return (
    <textarea
      aria-label={label}
      defaultValue={value}
      key={value}
      rows={rows}
      placeholder={placeholder}
      spellCheck={false}
      onBlur={(e) => e.target.value !== value && onCommit(e.target.value)}
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
}: {
  children: ReactNode;
  onClick: () => void;
  variant?: "quiet" | "primary" | "danger";
  disabled?: boolean;
}) {
  const tone =
    variant === "primary"
      ? "bg-accent text-accent-ink hover:opacity-90"
      : variant === "danger"
        ? "border border-line text-danger hover:bg-surface-3"
        : "border border-line text-ink-2 hover:bg-surface-3 hover:text-ink";
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`h-8 shrink-0 rounded-full px-3.5 text-xs disabled:opacity-40 ${tone}`}>
      {children}
    </button>
  );
}
