import { Check, Gauge, Moon, Printer, RotateCw, Smartphone, Sun, WifiOff, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DEVICES } from "../data/devices";
import { useBrowser } from "../store/browser";
import { selectMedia, selectThrottle, useEmulation } from "../store/emulation";
import { Icon } from "./Icon";

/** Toolbar button + popover for the device simulator and media overrides. */
export function DeviceMenu() {
  const activeTab = useBrowser((s) => s.activeTab);
  const sel = useEmulation((s) => (activeTab ? s.byTab[activeTab] : undefined));
  const media = useEmulation(selectMedia(activeTab));
  const setDevice = useEmulation((s) => s.setDevice);
  const toggleLandscape = useEmulation((s) => s.toggleLandscape);
  const setMedia = useEmulation((s) => s.setMedia);
  const throttle = useEmulation(selectThrottle(activeTab));
  const setThrottle = useEmulation((s) => s.setThrottle);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = !!sel;
  const disabled = !activeTab;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Device simulator"
        title="Device simulator"
        aria-pressed={active}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="grid size-7 place-items-center rounded-full text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-35 aria-pressed:bg-surface-3 aria-pressed:text-highlight"
      >
        <Icon icon={Smartphone} />
      </button>
      {open && activeTab && (
        <div role="menu" className="absolute right-0 z-40 mt-1 w-64 rounded-xl border border-line-2 bg-surface p-1.5 text-xs shadow-2xl">
          <div className="px-2 pt-1 pb-1 text-[10px] tracking-wider text-ink-3 uppercase">Device</div>
          <Item label="Responsive (off)" checked={!sel} onClick={() => void setDevice(activeTab, null)} />
          {DEVICES.map((d) => (
            <Item
              key={d.id}
              label={d.name}
              hint={`${d.width}×${d.height} @${d.dpr}x`}
              checked={sel?.deviceId === d.id}
              onClick={() => void setDevice(activeTab, d.id)}
            />
          ))}
          <Item label="Rotate" icon={RotateCw} disabled={!sel} onClick={() => void toggleLandscape(activeTab)} />
          <div className="my-1 h-px bg-line" />
          <div className="px-2 pt-1 pb-1 text-[10px] tracking-wider text-ink-3 uppercase">Media</div>
          <Item label="Prefer dark" icon={Moon} checked={media.colorScheme === "dark"} onClick={() => void setMedia(activeTab, { colorScheme: media.colorScheme === "dark" ? null : "dark" })} />
          <Item label="Prefer light" icon={Sun} checked={media.colorScheme === "light"} onClick={() => void setMedia(activeTab, { colorScheme: media.colorScheme === "light" ? null : "light" })} />
          <Item label="Reduced motion" icon={Zap} checked={media.reducedMotion} onClick={() => void setMedia(activeTab, { reducedMotion: !media.reducedMotion })} />
          <Item label="Print media" icon={Printer} checked={media.print} onClick={() => void setMedia(activeTab, { print: !media.print })} />
          <div className="my-1 h-px bg-line" />
          <div className="px-2 pt-1 pb-1 text-[10px] tracking-wider text-ink-3 uppercase">Network</div>
          <Item label="Offline" icon={WifiOff} checked={throttle === "offline"} onClick={() => void setThrottle(activeTab, throttle === "offline" ? null : "offline")} />
          <Item label="Slow 3G" hint="2 s · 400 kbps" icon={Gauge} checked={throttle === "slow3g"} onClick={() => void setThrottle(activeTab, throttle === "slow3g" ? null : "slow3g")} />
          <Item label="Fast 3G" hint="0.5 s · 1.6 Mbps" icon={Gauge} checked={throttle === "fast3g"} onClick={() => void setThrottle(activeTab, throttle === "fast3g" ? null : "fast3g")} />
        </div>
      )}
    </div>
  );
}

function Item({ label, hint, icon, checked, disabled, onClick }: { label: string; hint?: string; icon?: typeof Check; checked?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={!!checked}
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-35 aria-checked:text-ink"
    >
      <span className="grid size-4 place-items-center text-highlight">{checked ? <Icon icon={Check} size={13} /> : icon ? <Icon icon={icon} size={13} className="text-ink-3" /> : null}</span>
      <span className="flex-1">{label}</span>
      {hint && <span className="font-mono text-[10px] text-ink-3">{hint}</span>}
    </button>
  );
}
