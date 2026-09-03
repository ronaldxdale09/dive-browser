import { ChevronDown, CircleDot, Square, Video } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { useBrowser } from "../store/browser";
import { selectErrorCount, useConsole } from "../store/console";
import { useRecorder } from "../store/recorder";
import { DeviceMenu } from "./DeviceMenu";
import { Icon, IconButton } from "./Icon";
import { Tooltip } from "./Tooltip";
import { AgentIcon } from "./agent/AgentIcon";

/**
 * Below this many pixels of title bar, the labelled buttons drop their words.
 * At the 720px window minimum the bar with labels leaves the tab strip a
 * sliver; icons alone give the tabs back about 180px.
 */
export const COLLAPSE_BELOW = 900;

/**
 * Whether the bar's row is too narrow for labels. Measures the parent (the
 * title-bar row) rather than the bar, which is `shrink-0` and so says
 * nothing about the room around it. An unmeasured row (width 0, as before
 * first layout) counts as wide, so nothing flashes to icons and back.
 */
function useNarrow(ref: RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const row = ref.current?.parentElement;
    if (!row) return;
    const apply = (width: number) => setNarrow(width > 0 && width < COLLAPSE_BELOW);
    apply(row.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => apply(entries[0]?.contentRect.width ?? row.getBoundingClientRect().width));
    observer.observe(row);
    return () => observer.disconnect();
  }, [ref]);
  return narrow;
}

/**
 * The title-bar action cluster: the features people reach for by name —
 * record, the device emulator, test interaction recorder, the agent.
 */
export function FeatureBar() {
  const toggle = useBrowser((s) => s.toggle);
  const ref = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(ref);

  return (
    <div ref={ref} data-narrow={narrow || undefined} className="flex h-full shrink-0 items-center gap-0.5 pr-2">
      <RecordAction compact={narrow} />
      <TestRecorderAction compact={narrow} />
      {narrow ? <DeviceMenu /> : <DeviceMenu label="Mobile" />}
      <AgentAction compact={narrow} />
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
function RecordAction({ compact }: { compact: boolean }) {
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
      iconOnly={compact}
      onClick={() => void toggle()}
    >
      {recording && <span className="size-1.5 animate-pulse rounded-full bg-danger motion-reduce:animate-none" aria-hidden />}
    </FeatureButton>
  );
}

/** Start/stop recording user interactions into a Playwright test. */
function TestRecorderAction({ compact }: { compact: boolean }) {
  const active = useBrowser((s) => s.activeTab);
  const recordingTab = useRecorder((s) => s.recordingTab);
  const start = useRecorder((s) => s.start);
  const stop = useRecorder((s) => s.stop);
  const steps = useRecorder((s) => s.steps);
  const recording = recordingTab !== null;

  return (
    <FeatureButton
      icon={recording ? Square : CircleDot}
      label={recording ? `Test (${steps.length})` : "Record Test"}
      tip={recording ? "Stop and export Playwright test" : "Record clicks and input to Playwright test"}
      tone={recording ? "hi" : "quiet"}
      active={recording}
      disabled={!active && !recording}
      iconOnly={compact}
      onClick={() => {
        if (recording) {
          void stop();
        } else if (active) {
          void start(active);
        }
      }}
    >
      {recording && <span className="size-1.5 animate-pulse rounded-full bg-highlight motion-reduce:animate-none" aria-hidden />}
    </FeatureButton>
  );
}

/** Opens the agent sidecar; carries the active tab's error count while it is closed. */
function AgentAction({ compact }: { compact: boolean }) {
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
        className={
          compact
            ? `relative ml-0.5 grid size-7 place-items-center rounded-full transition-colors ${open ? "bg-accent text-accent-ink" : "text-ink-2 hover:bg-surface-3 hover:text-ink"}`
            : `ml-0.5 flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] font-medium transition-colors ${
                open ? "bg-accent text-accent-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
              }`
        }
      >
        <AgentIcon size={compact ? 15 : 13} className={open ? "text-accent-ink" : "text-highlight"} />
        {!compact && "Agent"}
        {errorCount > 0 && !open && (
          <span
            className={`rounded-full bg-danger px-1.5 py-px font-mono text-[10px] leading-4 text-white ${compact ? "absolute -top-1 -right-1.5" : "ml-0.5"}`}
            aria-label={`${errorCount} errors`}
          >
            {errorCount > 99 ? "99+" : errorCount}
          </span>
        )}
      </button>
    </Tooltip>
  );
}
