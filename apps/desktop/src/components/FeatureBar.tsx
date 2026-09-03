import { ChevronDown, Sparkles, Square, Video } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useBrowser } from "../store/browser";
import { selectErrorCount, useConsole } from "../store/console";
import { DeviceMenu } from "./DeviceMenu";
import { Icon, IconButton } from "./Icon";
import { Tooltip } from "./Tooltip";

/**
 * The title-bar action cluster: the three features people reach for by name —
 * record, the device emulator, the agent — labelled, beside the environment
 * badge. Everything that acts on the page itself (capture, DevTools, the dock,
 * downloads, protection) stays in the address row as icons.
 */
export function FeatureBar() {
  const toggle = useBrowser((s) => s.toggle);

  return (
    <div className="flex h-full shrink-0 items-center gap-0.5 pr-2">
      <RecordAction />
      <DeviceMenu label="Mobile" />
      <AgentAction />
      <span className="mx-1.5 h-4 w-px bg-line-2" aria-hidden />
      {import.meta.env.DEV && (
        <span
          aria-label="Development environment"
          title="Development environment"
          className="flex h-5 shrink-0 items-center gap-1 rounded-full border border-danger/40 bg-danger/15 px-2 font-mono text-[10px] font-semibold tracking-[0.12em] text-danger"
        >
          <span className="size-1.5 rounded-full bg-danger" aria-hidden />
          DEV
        </span>
      )}
      <IconButton icon={ChevronDown} label="All tabs" onClick={() => toggle("palette", true)} size={14} tooltipAlign="end" />
    </div>
  );
}

/** Icon-and-word button shared by every action in the bar. */
export function FeatureButton({
  icon,
  label,
  tip,
  shortcut,
  onClick,
  active = false,
  disabled = false,
  tone = "quiet",
  iconOnly = false,
  children,
}: {
  icon: LucideIcon;
  label: string;
  /** Tooltip text when the visible label is too short to explain the action. */
  tip?: string;
  shortcut?: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  tone?: "quiet" | "hi" | "danger";
  /** Round glyph-only button for the address row; the label becomes the tooltip. */
  iconOnly?: boolean;
  children?: ReactNode;
}) {
  const color = tone === "danger" ? "text-danger" : tone === "hi" ? "text-highlight" : "text-ink-2";
  return (
    <Tooltip label={tip ?? label} shortcut={shortcut}>
      <button
        type="button"
        aria-label={tip ?? label}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        className={
          iconOnly
            ? `relative grid size-7 place-items-center rounded-full transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent aria-pressed:bg-surface-3 aria-pressed:text-ink ${color}`
            : `flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11.5px] transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent aria-pressed:bg-surface-3 aria-pressed:text-ink ${color}`
        }
      >
        <Icon icon={icon} size={iconOnly ? 15 : 13} />
        {!iconOnly && label}
        {iconOnly ? <span className="absolute -top-0.5 -right-1 flex">{children}</span> : children}
      </button>
    </Tooltip>
  );
}

/** Start/stop recording the active tab as a GIF; pulses while recording. */
function RecordAction() {
  const active = useBrowser((s) => s.activeTab);
  const recordingTab = useBrowser((s) => s.recordingTab);
  const toggle = useBrowser((s) => s.screencastToggle);
  const recording = recordingTab !== null;
  return (
    <FeatureButton
      icon={recording ? Square : Video}
      label={recording ? "Stop" : "Record"}
      tip={recording ? "Stop recording" : "Record tab as GIF"}
      shortcut="⌘⇧R"
      tone={recording ? "danger" : "quiet"}
      active={recording}
      disabled={!active && !recording}
      onClick={() => void toggle()}
    >
      {recording && <span className="size-1.5 animate-pulse rounded-full bg-danger" aria-hidden />}
    </FeatureButton>
  );
}

/** Opens the agent sidecar; carries the active tab's error count while it is closed. */
function AgentAction() {
  const activeTab = useBrowser((s) => s.activeTab);
  const open = useBrowser((s) => s.open.sidecar);
  const toggle = useBrowser((s) => s.toggle);
  const errorCount = useConsole(selectErrorCount(activeTab));
  return (
    <Tooltip label="Agent" shortcut="⌘J" align="end">
      <button
        type="button"
        aria-label="Agent"
        aria-pressed={open}
        onClick={() => toggle("sidecar")}
        className={`ml-0.5 flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] font-medium transition-colors ${
          open ? "bg-accent text-accent-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
        }`}
      >
        <Icon icon={Sparkles} size={13} />
        Agent
        {errorCount > 0 && !open && (
          <span className="ml-0.5 rounded-full bg-danger px-1.5 py-px font-mono text-[10px] leading-4 text-white" aria-label={`${errorCount} errors`}>
            {errorCount > 99 ? "99+" : errorCount}
          </span>
        )}
      </button>
    </Tooltip>
  );
}
