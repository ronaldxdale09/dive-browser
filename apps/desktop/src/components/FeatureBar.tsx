import { isPrivateWindow } from "../lib/privateMode";
import { PrivateBadge } from "./PrivateMode";
import { AlertTriangle, ArrowDownToLine, Camera, ChevronDown, Loader2, LoaderCircle, Pause, Play, Square, Video, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDismiss } from "../lib/useDismiss";
import { useCoversContent } from "../lib/overlay";
import { useFocusTrap } from "../lib/useFocusTrap";
import type { ReactNode, RefObject } from "react";
import { useBrowser } from "../store/browser";
import { useUpdates } from "../store/updates";
import { elapsedSeconds, useRecording } from "../store/recording";
import { recordingClock } from "../lib/recordingFormat";
import { BuildBadge } from "./BuildBadge";
import { DeviceMenu } from "./DeviceMenu";
import { Icon, IconButton } from "./Icon";
import { Tooltip } from "./Tooltip";
import { AgentIcon } from "./agent/AgentIcon";
import { usePicker } from "../store/simulator";

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
 * capture (a recording or a screenshot), the device emulator, the agent.
 */
export function FeatureBar({ compact = false }: { compact?: boolean }) {
  const openPalette = useBrowser((s) => s.openPalette);
  const ref = useRef<HTMLDivElement>(null);
  const measuredNarrow = useNarrow(ref);
  const narrow = compact || measuredNarrow;

  return (
    <div ref={ref} data-narrow={narrow || undefined} className="flex h-full shrink-0 items-center gap-0.5 pr-2">
      <CaptureAction compact={narrow} />
      {narrow ? <DeviceMenu /> : <DeviceMenu label="Mobile" />}
      {!isPrivateWindow() && <AgentAction compact={narrow} />}
      <span className="mx-1.5 h-4 w-px bg-line-2" aria-hidden />
      {!isPrivateWindow() && <UpdatePill compact={narrow} />}
      {isPrivateWindow() ? <PrivateBadge /> : <BuildBadge />}
      <IconButton icon={ChevronDown} label="All tabs" onClick={() => openPalette("tabs")} size={14} tooltipAlign="end" tooltipSide="bottom" />
    </div>
  );
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

/**
 * Capture: one control for the two ways of taking the page away with you,
 * a recording (video or GIF) and a full-page screenshot. While a recording
 * runs it turns into the recording's controls (time, pause, stop, discard)
 * so they are always on screen without covering the page.
 */
function CaptureAction({ compact }: { compact: boolean }) {
  const active = useBrowser((s) => s.activeTab);
  const capture = useBrowser((s) => s.capture);
  const capturing = useBrowser((s) => s.capturing);
  const phase = useRecording((s) => s.phase);
  const openSetup = useRecording((s) => s.openSetup);
  const [open, setOpen] = useState(false);
  const dismiss = useCallback(() => setOpen(false), []);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useCoversContent(open);
  useFocusTrap(menu, { active: open, menu: true, onEscape: dismiss });
  useDismiss(root, open, dismiss);
  if (phase === "starting" || phase === "countdown" || phase === "recording" || phase === "paused" || phase === "finishing") {
    return <RecordingHud compact={compact} />;
  }
  const item = "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-xs text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent";
  return (
    <div ref={root} className="relative">
      <FeatureButton
        icon={capturing ? LoaderCircle : Camera}
        label="Capture"
        tip={capturing ? "Capturing the page…" : "Capture: record a video or GIF, or screenshot the page"}
        disabled={!active}
        iconOnly={compact}
        hasPopup="menu"
        active={open}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div ref={menu} role="menu" aria-label="Capture" className="surface-enter absolute top-full left-0 z-50 mt-1 w-60 rounded-xl border border-line-2 bg-surface p-1.5 shadow-2xl">
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              dismiss();
              openSetup();
            }}
          >
            <Icon icon={Video} size={13} />
            <span className="flex-1">Record video or GIF</span>
            <kbd className="font-mono text-[9px] text-ink-3">⌘⇧R</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            className={item}
            disabled={capturing}
            onClick={() => {
              dismiss();
              void capture(true);
            }}
          >
            <Icon icon={Camera} size={13} />
            <span className="flex-1">Screenshot the full page</span>
            <kbd className="font-mono text-[9px] text-ink-3">⌘⇧S</kbd>
          </button>
        </div>
      )}
    </div>
  );
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
