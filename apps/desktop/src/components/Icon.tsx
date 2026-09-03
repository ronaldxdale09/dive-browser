import type { LucideIcon, LucideProps } from "lucide-react";

/** One place to fix icon size and stroke so every glyph in the chrome matches. */
export function Icon({ icon: Glyph, size = 15, ...rest }: { icon: LucideIcon; size?: number } & LucideProps) {
  return <Glyph size={size} strokeWidth={1.75} absoluteStrokeWidth aria-hidden {...rest} />;
}

/** Round icon button used across the toolbar and tab strip. */
export function IconButton({
  icon,
  label,
  onClick,
  active = false,
  disabled = false,
  size = 15,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  size?: number;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-full text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent aria-pressed:bg-surface-3 aria-pressed:text-ink"
    >
      <Icon icon={icon} size={size} />
    </button>
  );
}
