import { isPrivateWindow } from "../lib/privateMode";
import { PrivateBadge } from "./PrivateMode";
import { AlertTriangle, ArrowDownToLine, LayoutGrid, Loader2, Pause, Play, Plug, Square, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { useBrowser } from "../store/browser";
import { useUpdates } from "../store/updates";
import { elapsedSeconds, useRecording } from "../store/recording";
import { recordingClock } from "../lib/recordingFormat";
import { Icon, IconButton } from "./Icon";
import { Tooltip } from "./Tooltip";
import { AgentIcon } from "./agent/AgentIcon";
import { McpDialog } from "./McpDialog";
import { usePicker } from "../store/simulator";
import { useConnectHint } from "../store/connectHint";

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
 * The bar's feature cluster: the two things reached for all day, the agent
 * and the Apps launcher that holds everything else, plus whatever is
 * happening right now (a recording's controls, an update waiting).
 */
export function FeatureBar({ compact = false }: { compact?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const measuredNarrow = useNarrow(ref);
  const narrow = compact || measuredNarrow;

  return (
    <div ref={ref} data-narrow={narrow || undefined} className="flex h-full shrink-0 items-center gap-0.5 pr-2">
      <RecordingStatus compact={narrow} />
      {!isPrivateWindow() && <UpdatePill compact={narrow} />}
      {isPrivateWindow() && <PrivateBadge />}
      {!isPrivateWindow() && <AgentAction compact={narrow} />}
      {!isPrivateWindow() && <McpAction compact={narrow} />}
      <AppsAction compact={narrow} />
    </div>
  );
}

/**
 * Beside the agent, because it answers the question the agent raises: this
 * browser can be driven by *your* agent too. A dialog rather than a settings
 * page -- connecting is a one-time copy, and burying it in Developer meant
 * nobody found it.
 *
 * Labelled for what it does rather than for the protocol it speaks. "MCP"
 * names the standard precisely and belongs in the dialog, where the agent
 * needs the word; on a button beside Agent and Apps it says nothing about
 * what pressing it achieves.
 */
function McpAction({ compact }: { compact: boolean }) {
  const [open, setOpen] = useState(false);
  const seen = useConnectHint((s) => s.seen);
  const markSeen = useConnectHint((s) => s.markSeen);
  // A light passes over it every few seconds until it has been opened once.
  // The sweep is a mask over the button's own contents rather than a colour
  // change, so the label stays legible while it moves and the button does
  // not shift or resize -- a bar that jumps is worse than one nobody notices.
  const hinting = !seen && !open;
  return (
    <>
      <Tooltip label="Connect an agent: drive Dive from Claude Code, Cursor or Codex" side="bottom" align="end">
        <button
          type="button"
          aria-label="Connect an agent"
          aria-haspopup="dialog"
          aria-expanded={open}
          data-hinting={hinting || undefined}
          onClick={() => {
            markSeen();
            setOpen(true);
          }}
          className={
            compact
              ? `pressable dive-shimmer relative ml-0.5 grid size-7 place-items-center rounded-full transition-[color,background-color,transform] ${open ? "bg-accent text-accent-ink" : "text-ink-2 hover:bg-surface-3 hover:text-ink"}`
              : `pressable dive-shimmer relative ml-0.5 flex h-7 items-center gap-1.5 overflow-hidden rounded-lg px-2.5 text-[11.5px] font-medium transition-[color,background-color,transform] ${
                  open ? "bg-accent text-accent-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
                }`
          }
        >
          <Icon icon={Plug} size={compact ? 15 : 13} />
          {!compact && "Connect"}
        </button>
      </Tooltip>
      {open && <McpDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/** Opens the Apps launcher. */
function AppsAction({ compact }: { compact: boolean }) {
  const open = useBrowser((s) => s.open.apps ?? false);
  const toggle = useBrowser((s) => s.toggle);
  return <FeatureButton icon={LayoutGrid} label="Apps" tip="Apps: everything Dive can do" shortcut="⌘⇧Space" hasPopup="dialog" active={open} iconOnly={compact} onClick={() => toggle("apps", true)} />;
}

/**
 * A newer build is waiting. A pill rather than a dialog: it sits here until
 * the person has a moment, and opens the About panel that installs it.
 */
function UpdatePill({ compact }: { compact: boolean }) {
  const status = useUpdates((s) => s.status);
  const version = useUpdates((s) => s.update?.version);
  const openSettings = useBrowser((s) => s.openSettings);
  if (status !== "available") return null;
  return (
    <Tooltip label={`Dive ${version ?? ""} is ready to install`} side="bottom">
      <button
        type="button"
        aria-label="Update available"
        onClick={() => openSettings("about")}
        className="mr-1 flex h-6 shrink-0 items-center gap-1 rounded-full border border-highlight/40 bg-highlight/15 px-2 text-[10.5px] font-medium text-highlight hover:bg-highlight/25"
      >
        <Icon icon={ArrowDownToLine} size={11} />
        {!compact && "Update available"}
      </button>
    </Tooltip>
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
  tooltipAlign,
  hasPopup,
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
  tooltipAlign?: "start" | "center" | "end";
  /** The button opens a popover: `active` then means expanded, not pressed. */
  hasPopup?: "menu" | "dialog";
  children?: ReactNode;
}) {
  const color = tone === "danger" ? "text-danger" : tone === "hi" ? "text-highlight" : "text-ink-2";
  const state = hasPopup ? { "aria-haspopup": hasPopup, "aria-expanded": active } : { "aria-pressed": active };
  return (
    <Tooltip label={tip ?? label} shortcut={shortcut} side="bottom" align={tooltipAlign}>
      <button
        type="button"
        aria-label={tip ?? label}
        {...state}
        disabled={disabled}
        onClick={onClick}
        className={
          iconOnly
            ? `pressable relative grid size-7 place-items-center rounded-full transition-[color,background-color,transform] duration-150 hover:bg-surface-3 hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent aria-pressed:bg-surface-3 aria-pressed:text-ink aria-expanded:bg-surface-3 aria-expanded:text-ink ${color}`
            : `pressable flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11.5px] transition-[color,background-color,transform] duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent aria-pressed:bg-surface-3 aria-pressed:text-ink aria-expanded:bg-surface-3 aria-expanded:text-ink ${color}`
        }
      >
        <Icon icon={icon} size={iconOnly ? 15 : 13} />
        {!iconOnly && label}
        {iconOnly ? <span className="absolute -top-0.5 -right-1 flex">{children}</span> : children}
      </button>
    </Tooltip>
  );
}

/** While a recording runs, its controls sit here so they are always on screen. */
function RecordingStatus({ compact }: { compact: boolean }) {
  const phase = useRecording((s) => s.phase);
  if (phase === "starting" || phase === "countdown" || phase === "recording" || phase === "paused" || phase === "finishing") {
    return <RecordingHud compact={compact} />;
  }
  return null;
}

/** The live controls of a recording in progress. */
function RecordingHud({ compact }: { compact: boolean }) {
  const phase = useRecording((s) => s.phase);
  const countdown = useRecording((s) => s.countdown);
  const pause = useRecording((s) => s.pause);
  const resume = useRecording((s) => s.resume);
  const stop = useRecording((s) => s.stop);
  const cancel = useRecording((s) => s.cancel);
  const error = useRecording((s) => s.error);
  const elapsed = useElapsed(phase === "recording");
  const paused = phase === "paused";

  if (phase === "starting") {
    return (
      <div role="status" aria-live="polite" className="flex h-7 items-center gap-2 rounded-lg bg-surface-2 px-2.5 text-[11.5px] text-ink-2">
        <Icon icon={Loader2} size={13} className="motion-safe:animate-spin" />
        {!compact && "Preparing…"}
      </div>
    );
  }

  if (phase === "countdown") {
    return (
      <div role="status" aria-live="polite" className="flex h-7 items-center gap-2 rounded-lg bg-surface-2 pr-1 pl-2.5 text-[11.5px] text-ink">
        <span className="size-2 rounded-full bg-danger" aria-hidden />
        {compact ? countdown : `Recording in ${countdown}…`}
        <IconButton icon={X} label="Cancel recording" size={13} onClick={() => void cancel()} />
      </div>
    );
  }
  if (phase === "finishing") {
    return (
      <div role="status" aria-live="polite" className="flex h-7 items-center gap-2 rounded-lg bg-surface-2 px-2.5 text-[11.5px] text-ink-2">
        <Icon icon={Loader2} size={13} className="motion-safe:animate-spin" />
        {!compact && "Saving…"}
      </div>
    );
  }
  return (
    <div role="group" aria-label={paused ? "Recording paused" : "Recording"} className={`flex h-7 items-center gap-1 rounded-lg pr-1 pl-2.5 text-[11.5px] ${paused ? "bg-surface-2 text-ink-2" : "bg-danger/15 text-ink"}`}>
      <span className={`size-2 rounded-full ${paused ? "bg-ink-3" : "bg-danger motion-safe:animate-pulse"}`} aria-hidden />
      <span role="timer" aria-label={`${recordingClock(elapsed)} recorded`} className="min-w-8 font-mono tabular-nums" aria-live="off">
        {recordingClock(elapsed)}
      </span>
      {paused && !compact && <span className="text-ink-3">paused</span>}
      {error && <Icon icon={AlertTriangle} size={13} role="img" aria-label={error} className="text-danger" />}
      <IconButton icon={paused ? Play : Pause} label={paused ? "Resume recording" : "Pause recording"} size={13} onClick={() => void (paused ? resume() : pause())} />
      <Tooltip label="Stop and save" shortcut="⌘⇧R">
        <button type="button" aria-label="Stop and save" onClick={() => void stop()} className="grid size-7 place-items-center rounded-full text-danger transition-colors hover:bg-danger/20">
          <Icon icon={Square} size={12} className="fill-current" />
        </button>
      </Tooltip>
      <IconButton icon={X} label="Discard recording" size={13} onClick={() => void cancel()} />
    </div>
  );
}

/** Seconds recorded, ticking while recording; frozen at the pause while paused. */
function useElapsed(ticking: boolean): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    // The label is whole seconds, so repainting it four times a second only
    // burns chrome work without changing what the person can read.
    const id = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);
  const startedAt = useRecording((s) => s.startedAt);
  const pausedAt = useRecording((s) => s.pausedAt);
  const pausedTotal = useRecording((s) => s.pausedTotal);
  // Paused: the clock reads exactly the moment of the pause.
  return elapsedSeconds({ startedAt, pausedAt, pausedTotal }, ticking ? tick : (pausedAt ?? tick));
}

/** Opens the agent sidecar. */
function AgentAction({ compact }: { compact: boolean }) {
  const open = useBrowser((s) => s.open.sidecar);
  const toggle = useBrowser((s) => s.toggle);
  const setPickerOpen = usePicker((s) => s.setOpen);
  return (
    <Tooltip label="Agent" shortcut="⌘J" align="end" side="bottom">
      <button
        type="button"
        aria-label="Agent"
        aria-pressed={open}
        onClick={() => {
          if (compact && !open) {
            setPickerOpen(false);
            toggle("dock", false);
          }
          toggle("sidecar");
        }}
        className={
          compact
            ? `pressable relative ml-0.5 grid size-7 place-items-center rounded-full transition-[color,background-color,transform] ${open ? "bg-accent text-accent-ink" : "text-ink-2 hover:bg-surface-3 hover:text-ink"}`
            : `pressable ml-0.5 flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] font-medium transition-[color,background-color,transform] ${
                open ? "bg-accent text-accent-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"
              }`
        }
      >
        <AgentIcon size={compact ? 15 : 13} className={open ? "text-accent-ink" : "text-highlight"} />
        {!compact && "Agent"}
      </button>
    </Tooltip>
  );
}
