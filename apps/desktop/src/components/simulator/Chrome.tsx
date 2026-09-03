/**
 * The strips around the page: the status bar, the device's cutout, the
 * browser's own bars, and the home indicator.
 *
 * Drawn in device CSS pixels and scaled by the frame, so the same markup
 * serves a 393-wide iPhone at 100% and at 42%. Nothing here overlaps the
 * page; that is not a stylistic choice but a constraint of the native
 * webview painting above the chrome. The upside is honesty: the page's
 * viewport is exactly what is left between these strips.
 */
import { ArrowLeft, ArrowRight, BookOpen, Copy, Lock, MoreVertical, RotateCw, Share, Square } from "lucide-react";
import { useEffect, useState } from "react";
import type { DevicePreset } from "../../data/devices";
import { browserFor, stripsFor } from "../../data/devices";
import { FOCUS_ADDRESS } from "../../lib/commands";
import { useBrowser } from "../../store/browser";
import type { UiMode } from "./geometry";

/** Wall-clock time as a phone shows it: hours and minutes, no seconds. */
export function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    const untilNextMinute = 60_000 - (Date.now() % 60_000);
    let interval: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => {
      tick();
      interval = setInterval(tick, 60_000);
    }, untilNextMinute);
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, []);
  return formatClock(now);
}

/** `9:41` on iOS, `09:41` on Android; both without a suffix, like the real bars. */
export function formatClock(date: Date, android = false): string {
  const h = date.getHours();
  const m = date.getMinutes().toString().padStart(2, "0");
  if (android) return `${h.toString().padStart(2, "0")}:${m}`;
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}:${m}`;
}

/** Host shown in a mobile address bar: no scheme, no path, no `www.`. */
export function displayHost(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "about:") return "";
    return u.hostname.replace(/^www\./, "") || u.href;
  } catch {
    return url;
  }
}

function SignalBars({ color }: { color: string }) {
  return (
    <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={i * 4.5} y={12 - (4 + i * 2.5)} width="3.2" height={4 + i * 2.5} rx="0.8" fill={color} />
      ))}
    </svg>
  );
}

function WifiGlyph({ color }: { color: string }) {
  return (
    <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden>
      <path d="M8 11.2a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6z" fill={color} />
      <path d="M4.2 6.4a5.4 5.4 0 0 1 7.6 0" stroke={color} strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <path d="M1.4 3.6a9.4 9.4 0 0 1 13.2 0" stroke={color} strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function BatteryGlyph({ color }: { color: string }) {
  return (
    <svg width="27" height="13" viewBox="0 0 27 13" aria-hidden>
      <rect x="0.8" y="0.8" width="22" height="11.4" rx="3" stroke={color} strokeOpacity="0.4" strokeWidth="1" fill="none" />
      <rect x="2.4" y="2.4" width="18.8" height="8.2" rx="1.8" fill={color} />
      <path d="M24.6 4.4v4.2a2.2 2.2 0 0 0 0-4.2z" fill={color} fillOpacity="0.4" />
    </svg>
  );
}

/**
 * The status bar. Real clock, full signal, full battery: the point is to
 * look like the device, not to report on it.
 *
 * Geometry follows the hardware. A phone with an island or a notch puts the
 * clock beside the cutout, well below the top edge; a classic iPhone has a
 * 20-point bar with small type; Android centres a slightly larger clock in a
 * 24-point bar.
 */
export function StatusBar({ device, height, dark }: { device: DevicePreset; height: number; dark: boolean }) {
  const android = device.platform === "Android";
  const clock = useClock();
  const color = dark ? "#fff" : "#000";
  if (height <= 0) return null;
  const large = device.frame === "island" || device.frame === "notch";
  const small = !large && !android;
  const fontSize = large ? 17 : android ? 14 : 12;
  const glyph = small ? 0.75 : android ? 0.9 : 1;
  // Where the clock's centre line sits.
  const centre = large ? (device.frame === "island" ? 25 : 22) : height / 2;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0"
      style={{ height, fontFamily: android ? "Roboto, system-ui, sans-serif" : "-apple-system, 'SF Pro Text', system-ui, sans-serif", color }}
    >
      <span
        className="absolute"
        style={{ left: large ? 30 : android ? 14 : 12, top: centre, transform: "translateY(-50%)", fontSize, fontWeight: 600, letterSpacing: large ? -0.4 : 0, lineHeight: 1 }}
      >
        {android ? formatClock(new Date(), true) : clock}
      </span>
      <span className="absolute flex items-center" style={{ right: large ? 22 : android ? 12 : 8, top: centre, transform: `translateY(-50%) scale(${glyph})`, transformOrigin: "right center", gap: 6 }}>
        <SignalBars color={color} />
        <WifiGlyph color={color} />
        <BatteryGlyph color={color} />
      </span>
    </div>
  );
}

/** The dynamic island, the notch, or a punch-hole camera, at the top of the screen. */
export function Cutout({ device, landscape }: { device: DevicePreset; landscape: boolean }) {
  if (landscape) return null;
  switch (device.frame) {
    case "island":
      // A hairline keeps it visible when the status strip is black too.
      return <div aria-hidden className="absolute rounded-full bg-black" style={{ top: 11, left: "50%", width: 126, height: 37, transform: "translateX(-50%)", boxShadow: "0 0 0 1px rgba(255,255,255,0.14)" }} />;
    case "notch":
      return (
        <div
          aria-hidden
          className="absolute bg-black"
          style={{ top: 0, left: "50%", width: Math.round(device.width * 0.56), height: 30, transform: "translateX(-50%)", borderRadius: "0 0 20px 20px", boxShadow: "0 1px 0 0 rgba(255,255,255,0.12)" }}
        />
      );
    case "punch":
      return <div aria-hidden className="absolute rounded-full bg-black" style={{ top: 10, left: "50%", width: 14, height: 14, transform: "translateX(-50%)", boxShadow: "0 0 0 1px rgba(255,255,255,0.18), inset 0 0 0 2px #0a0a0a" }} />;
    default:
      return null;
  }
}

/** The thin bar a person swipes up from on any modern phone. */
export function HomeIndicator({ height, dark }: { height: number; dark: boolean }) {
  if (height <= 0) return null;
  return (
    <div aria-hidden className="flex shrink-0 items-end justify-center" style={{ height, paddingBottom: 8 }}>
      <div className="rounded-full" style={{ width: 134, height: 5, background: dark ? "#fff" : "#000", opacity: 0.9 }} />
    </div>
  );
}

interface BarProps {
  device: DevicePreset;
  landscape: boolean;
  dark: boolean;
  url: string;
  secure: boolean;
}

/** Bars above the page: Safari's landscape strip, the classic iPhone's address bar, Chrome's toolbar. */
export function TopBar({ device, landscape, dark, url, secure }: BarProps) {
  const ui = stripsFor(device.frame, landscape);
  if (ui.top <= 0) return null;
  const browser = browserFor(device.frame);
  if (browser === "chrome") return <ChromeTopBar height={ui.top} dark={dark} url={url} secure={secure} />;
  if (device.frame === "home") return <SafariClassicAddressBar height={ui.top} dark={dark} url={url} secure={secure} />;
  return <SafariTopBar height={ui.top} dark={dark} url={url} secure={secure} compact={landscape} />;
}

/** The address field of Safari on a home-button iPhone: one grey field, nothing else. */
function SafariClassicAddressBar({ height, dark, url, secure }: { height: number; dark: boolean; url: string; secure: boolean }) {
  const t = tones(dark);
  const host = displayHost(url);
  return (
    <div className="flex shrink-0 items-center" style={{ height, background: t.bar, borderBottom: `0.5px solid ${dark ? "#3a3a3c" : "#d1d1d6"}`, paddingInline: 8 }}>
      <button
        type="button"
        aria-label="Address"
        onClick={() => window.dispatchEvent(new CustomEvent(FOCUS_ADDRESS))}
        className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[9px]"
        style={{ height: 30, background: t.pill, color: t.text, fontSize: 14, fontWeight: 500 }}
      >
        {secure && <Lock size={10} strokeWidth={2.5} style={{ color: t.muted }} />}
        <span className="truncate">{host || "Search or enter website name"}</span>
      </button>
    </div>
  );
}

/** Bars below the page: Safari's address pill and toolbar, or Chrome's gesture bar. */
export function BottomBar({ device, landscape, dark, url, secure }: BarProps) {
  const ui = stripsFor(device.frame, landscape);
  if (ui.bottom <= 0) return null;
  const browser = browserFor(device.frame);
  if (browser === "chrome") return <HomeIndicator height={ui.bottom} dark={dark} />;
  if (device.frame === "home") return <SafariClassicToolbar height={ui.bottom} dark={dark} />;
  if (landscape) return <HomeIndicator height={ui.bottom} dark={dark} />;
  return <SafariBottomBar height={ui.bottom} dark={dark} url={url} secure={secure} />;
}

/** Colours of the bars: Safari's translucent grey over the page, light or dark. */
function tones(dark: boolean) {
  return {
    bar: dark ? "#1c1c1e" : "#f7f7f7",
    pill: dark ? "#2c2c2e" : "#e9e9eb",
    text: dark ? "#f2f2f7" : "#1c1c1e",
    muted: dark ? "#8e8e93" : "#6e6e73",
    tint: "#0a84ff",
  };
}

function AddressPill({ url, secure, dark, height = 38, mutedBackground = false }: { url: string; secure: boolean; dark: boolean; height?: number; mutedBackground?: boolean }) {
  const t = tones(dark);
  const host = displayHost(url);
  return (
    <button
      type="button"
      aria-label="Address"
      onClick={() => window.dispatchEvent(new CustomEvent(FOCUS_ADDRESS))}
      className="flex min-w-0 flex-1 items-center rounded-xl"
      style={{ height, background: mutedBackground ? t.pill : t.pill, color: t.text, paddingInline: 12, fontSize: 15, fontWeight: 500 }}
    >
      <span style={{ fontSize: 14, color: t.muted, letterSpacing: -0.5 }}>AA</span>
      <span className="flex min-w-0 flex-1 items-center justify-center gap-1.5 truncate">
        {secure && <Lock size={11} strokeWidth={2.5} style={{ color: t.muted }} />}
        <span className="truncate">{host || "Search or enter website"}</span>
      </span>
      <RotateCw size={15} strokeWidth={2.2} style={{ color: t.text }} />
    </button>
  );
}

function ToolbarButton({ icon: Glyph, label, onClick, tint, disabled }: { icon: typeof ArrowLeft; label: string; onClick?: () => void; tint: string; disabled?: boolean }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} disabled={disabled} className="grid place-items-center disabled:opacity-35" style={{ width: 44, height: 44, color: tint }}>
      <Glyph size={22} strokeWidth={1.8} />
    </button>
  );
}

/** iOS 15+ Safari: address pill at the bottom, toolbar under it, then the home indicator. */
function SafariBottomBar({ height, dark, url, secure }: { height: number; dark: boolean; url: string; secure: boolean }) {
  const t = tones(dark);
  const back = useBrowser((s) => s.back);
  const forward = useBrowser((s) => s.forward);
  return (
    <div className="flex shrink-0 flex-col" style={{ height, background: t.bar, borderTop: `0.5px solid ${dark ? "#3a3a3c" : "#d1d1d6"}` }}>
      <div className="flex items-center" style={{ paddingInline: 8, paddingTop: 6 }}>
        <AddressPill url={url} secure={secure} dark={dark} />
      </div>
      <div className="flex items-center justify-between" style={{ paddingInline: 12, paddingTop: 2 }}>
        <ToolbarButton icon={ArrowLeft} label="Back" tint={t.tint} onClick={() => void back()} />
        <ToolbarButton icon={ArrowRight} label="Forward" tint={t.tint} onClick={() => void forward()} />
        <ToolbarButton icon={Share} label="Share" tint={t.tint} />
        <ToolbarButton icon={BookOpen} label="Bookmarks" tint={t.tint} />
        <ToolbarButton icon={Copy} label="Tabs" tint={t.tint} />
      </div>
      <HomeIndicator height={Math.max(0, height - 6 - 38 - 2 - 44)} dark={dark} />
    </div>
  );
}

/** Safari's compact top bar in landscape, and iPadOS's toolbar. */
function SafariTopBar({ height, dark, url, secure, compact }: { height: number; dark: boolean; url: string; secure: boolean; compact: boolean }) {
  const t = tones(dark);
  const back = useBrowser((s) => s.back);
  const forward = useBrowser((s) => s.forward);
  return (
    <div className="flex shrink-0 items-center" style={{ height, background: t.bar, borderBottom: `0.5px solid ${dark ? "#3a3a3c" : "#d1d1d6"}`, paddingInline: compact ? 6 : 12, gap: 4 }}>
      <ToolbarButton icon={ArrowLeft} label="Back" tint={t.tint} onClick={() => void back()} />
      <ToolbarButton icon={ArrowRight} label="Forward" tint={t.tint} onClick={() => void forward()} />
      <AddressPill url={url} secure={secure} dark={dark} height={34} />
      <ToolbarButton icon={Share} label="Share" tint={t.tint} />
      <ToolbarButton icon={Copy} label="Tabs" tint={t.tint} />
    </div>
  );
}

/** The bottom toolbar of Safari on a home-button iPhone. */
function SafariClassicToolbar({ height, dark }: { height: number; dark: boolean }) {
  const t = tones(dark);
  const back = useBrowser((s) => s.back);
  const forward = useBrowser((s) => s.forward);
  return (
    <div className="flex shrink-0 items-center justify-between" style={{ height, background: t.bar, borderTop: `0.5px solid ${dark ? "#3a3a3c" : "#d1d1d6"}`, paddingInline: 8 }}>
      <ToolbarButton icon={ArrowLeft} label="Back" tint={t.tint} onClick={() => void back()} />
      <ToolbarButton icon={ArrowRight} label="Forward" tint={t.tint} onClick={() => void forward()} />
      <ToolbarButton icon={Share} label="Share" tint={t.tint} />
      <ToolbarButton icon={BookOpen} label="Bookmarks" tint={t.tint} />
      <ToolbarButton icon={Copy} label="Tabs" tint={t.tint} />
    </div>
  );
}

/** Chrome on Android: the omnibox with the tab switcher and the menu. */
function ChromeTopBar({ height, dark, url, secure }: { height: number; dark: boolean; url: string; secure: boolean }) {
  const bar = dark ? "#1f1f1f" : "#ffffff";
  const pill = dark ? "#303134" : "#f1f3f4";
  const text = dark ? "#e8eaed" : "#202124";
  const muted = dark ? "#9aa0a6" : "#5f6368";
  const host = displayHost(url);
  return (
    <div className="flex shrink-0 items-center" style={{ height, background: bar, paddingInline: 8, gap: 8 }}>
      <button
        type="button"
        aria-label="Address"
        onClick={() => window.dispatchEvent(new CustomEvent(FOCUS_ADDRESS))}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-full"
        style={{ height: 40, background: pill, color: text, paddingInline: 14, fontSize: 15 }}
      >
        {secure && <Lock size={13} strokeWidth={2.2} style={{ color: muted }} />}
        <span className="truncate">{host || "Search or type URL"}</span>
      </button>
      <span className="grid place-items-center rounded-[6px]" style={{ width: 24, height: 24, border: `2px solid ${muted}`, color: muted, fontSize: 11, fontWeight: 700 }}>
        1
      </span>
      <MoreVertical size={22} strokeWidth={2} style={{ color: muted }} />
      <span className="sr-only">
        <Square />
      </span>
    </div>
  );
}

/** Whether to draw the bars dark: follows the page's emulated scheme, else the chrome's. */
export function useBarsDark(mode: UiMode, colorScheme: "light" | "dark" | null): boolean {
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  if (mode === "none") return true;
  return colorScheme ? colorScheme === "dark" : systemDark;
}
