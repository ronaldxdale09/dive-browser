/**
 * The device picker: every device in the catalog by group, the recent ones
 * up top, a custom size, and the environment the page runs in — media
 * features, network, place and time.
 *
 * A panel rather than a menu because there are forty devices and choosing
 * one is a comparison, not a command. It covers the page while open, which
 * is a constraint of the native view painting above the chrome; the stage
 * comes back the moment it closes.
 */
import { Check, Gauge, Globe, Laptop, Moon, Printer, RotateCw, Search, Smartphone, Sun, Tablet, WifiOff, X, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { DEVICE_GROUPS, devicesIn, searchDevices } from "../../data/devices";
import type { DeviceGroup, DevicePreset } from "../../data/devices";
import { useBrowser } from "../../store/browser";
import { usePicker } from "../../store/simulator";
import { PLACES, baseFor, selectDevice, selectEnvironment, selectMedia, selectThrottle, useEmulation } from "../../store/emulation";
import { Icon, IconButton } from "../Icon";

export { usePicker };

const GROUP_ICON: Record<DeviceGroup, LucideIcon> = {
  "apple-phone": Smartphone,
  "android-phone": Smartphone,
  foldable: Smartphone,
  tablet: Tablet,
  laptop: Laptop,
};

export function DevicePicker() {
  const open = usePicker((s) => s.open);
  const setOpen = usePicker((s) => s.setOpen);
  const activeTab = useBrowser((s) => s.activeTab);
  const sel = useEmulation(selectDevice(activeTab));
  const recent = useEmulation((s) => s.recent);
  const setDevice = useEmulation((s) => s.setDevice);
  const setCustomSize = useEmulation((s) => s.setCustomSize);
  const toggleLandscape = useEmulation((s) => s.toggleLandscape);
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState({ width: sel?.custom?.width ?? 1024, height: sel?.custom?.height ?? 768 });
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  const matches = useMemo(() => searchDevices(query), [query]);
  const matching = new Set(matches.map((d) => d.id));

  if (!open || !activeTab) return null;
  const tab = activeTab;

  const choose = (d: DevicePreset) => void setDevice(tab, d.id);

  return (
    <aside role="region" aria-label="Device simulator" className="surface-enter flex h-full w-[min(420px,46%)] min-w-[300px] shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 px-4 pt-3 pb-2">
          <Icon icon={Smartphone} size={14} className="text-highlight" />
          <span className="text-sm font-medium">Device simulator</span>
          <span className="flex-1" />
          <IconButton icon={X} label="Close device simulator" onClick={() => setOpen(false)} size={14} />
        </div>

        <div className="px-4 pb-2">
          <label className="flex h-8 items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 focus-within:border-line-2">
            <Icon icon={Search} size={13} className="text-ink-3" />
            <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search devices, or type a size like 393x852" spellCheck={false} className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-ink-3" />
          </label>
        </div>

        <div className="scroll-hidden min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {/* What is on the stage now. */}
          <Section title="On the stage">
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip selected={!sel} onClick={() => void setDevice(tab, null)}>
                <Icon icon={Laptop} size={12} />
                Off — fill the window
              </Chip>
              {sel && (
                <Chip selected onClick={() => void toggleLandscape(tab)} title={sel.deviceId === "custom" ? undefined : "Rotate"}>
                  <Icon icon={sel.deviceId === "custom" ? Laptop : RotateCw} size={12} />
                  {sel.deviceId === "custom" ? `Custom ${sel.custom?.width}×${sel.custom?.height}` : `${baseFor(sel)?.name ?? sel.deviceId} · ${sel.landscape ? "landscape" : "portrait"}`}
                </Chip>
              )}
              {recent
                .filter((id) => id !== sel?.deviceId)
                .map((id) => {
                  const d = matches.find((m) => m.id === id) ?? devicesIn("apple-phone").find((m) => m.id === id);
                  return d ? (
                    <Chip key={id} onClick={() => choose(d)}>
                      <Icon icon={GROUP_ICON[d.group]} size={12} />
                      {d.name}
                    </Chip>
                  ) : null;
                })}
            </div>
          </Section>

          {DEVICE_GROUPS.map((group) => {
            const devices = devicesIn(group.id).filter((d) => matching.has(d.id));
            if (devices.length === 0) return null;
            return (
              <Section key={group.id} title={group.name}>
                <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(145px, 1fr))" }}>
                  {devices.map((d) => (
                    <DeviceCard key={d.id} device={d} selected={sel?.deviceId === d.id} onClick={() => choose(d)} />
                  ))}
                </div>
              </Section>
            );
          })}

          {matches.length === 0 && <p className="py-6 text-center text-xs text-ink-3">No device matches “{query}”.</p>}

          <Section title="Custom size">
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void setCustomSize(tab, Math.max(200, custom.width), Math.max(200, custom.height));
              }}
            >
              <SizeInput label="Width" value={custom.width} onChange={(width) => setCustom((c) => ({ ...c, width }))} />
              <span className="text-ink-3">×</span>
              <SizeInput label="Height" value={custom.height} onChange={(height) => setCustom((c) => ({ ...c, height }))} />
              <button type="submit" className="h-7 rounded-lg bg-surface-3 px-3 text-xs text-ink hover:bg-line-2">
                Apply
              </button>
              {sel?.deviceId === "custom" && <Icon icon={Check} size={13} className="text-highlight" />}
            </form>
          </Section>

          <Environment tab={tab} />
        </div>
      </div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="pt-3">
      <h3 className="pb-2 text-[10px] font-medium tracking-[0.08em] text-ink-3 uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Chip({ children, selected, onClick, title }: { children: React.ReactNode; selected?: boolean; onClick: () => void; title?: string | undefined }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={!!selected}
      onClick={onClick}
      className="flex h-7 items-center gap-1.5 rounded-full border border-line px-2.5 text-xs text-ink-2 hover:border-line-2 hover:text-ink aria-pressed:border-highlight aria-pressed:bg-highlight-soft aria-pressed:text-ink"
    >
      {children}
    </button>
  );
}

function DeviceCard({ device, selected, onClick }: { device: DevicePreset; selected: boolean; onClick: () => void }) {
  const tall = device.height > device.width;
  return (
    <button
      type="button"
      aria-label={`${device.name} ${device.width}×${device.height} @${device.dpr}x`}
      aria-pressed={selected}
      onClick={onClick}
      className="pressable flex min-w-0 items-center gap-2.5 rounded-lg border border-line px-2.5 py-2 text-left transition-[color,background-color,border-color,transform] hover:border-line-2 hover:bg-surface-2 aria-pressed:border-highlight aria-pressed:bg-highlight-soft"
    >
      <span aria-hidden className="grid h-8 w-7 shrink-0 place-items-center">
        <span className="rounded-[3px] border border-ink-3 bg-surface-3" style={{ width: tall ? 14 : 24, height: tall ? 24 : 14 }} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[11px] leading-tight text-ink">{device.name}</span>
        <span className="mt-1 block font-mono text-[9.5px] text-ink-3">
          {device.width}×{device.height} @{device.dpr}x
        </span>
      </span>
    </button>
  );
}

function SizeInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <input
      aria-label={label}
      type="number"
      min={200}
      max={4096}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-7 w-20 rounded-lg border border-line bg-surface-2 px-2 font-mono text-xs outline-none focus:border-highlight/60"
    />
  );
}

/** Media features, network and place — the parts of a device that are not its size. */
function Environment({ tab }: { tab: string }) {
  const media = useEmulation(selectMedia(tab));
  const setMedia = useEmulation((s) => s.setMedia);
  const throttle = useEmulation(selectThrottle(tab));
  const setThrottle = useEmulation((s) => s.setThrottle);
  const env = useEmulation(selectEnvironment(tab));
  const setEnvironment = useEmulation((s) => s.setEnvironment);
  return (
    <>
      <Section title="Appearance">
        <div className="flex flex-wrap gap-1.5">
          <Chip selected={media.colorScheme === "dark"} onClick={() => void setMedia(tab, { colorScheme: media.colorScheme === "dark" ? null : "dark" })}>
            <Icon icon={Moon} size={12} /> Dark
          </Chip>
          <Chip selected={media.colorScheme === "light"} onClick={() => void setMedia(tab, { colorScheme: media.colorScheme === "light" ? null : "light" })}>
            <Icon icon={Sun} size={12} /> Light
          </Chip>
          <Chip selected={media.reducedMotion} onClick={() => void setMedia(tab, { reducedMotion: !media.reducedMotion })}>
            <Icon icon={Zap} size={12} /> Reduced motion
          </Chip>
          <Chip selected={media.print} onClick={() => void setMedia(tab, { print: !media.print })}>
            <Icon icon={Printer} size={12} /> Print
          </Chip>
        </div>
      </Section>
      <Section title="Network">
        <div className="flex flex-wrap gap-1.5">
          <Chip selected={throttle === "offline"} onClick={() => void setThrottle(tab, throttle === "offline" ? null : "offline")}>
            <Icon icon={WifiOff} size={12} /> Offline
          </Chip>
          <Chip selected={throttle === "slow3g"} onClick={() => void setThrottle(tab, throttle === "slow3g" ? null : "slow3g")}>
            <Icon icon={Gauge} size={12} /> Slow 3G
          </Chip>
          <Chip selected={throttle === "fast3g"} onClick={() => void setThrottle(tab, throttle === "fast3g" ? null : "fast3g")}>
            <Icon icon={Gauge} size={12} /> Fast 3G
          </Chip>
        </div>
      </Section>
      <Section title="Place and time">
        <p className="pb-2 text-[11px] text-ink-3">Where the page thinks it is: geolocation, time zone and locale together.</p>
        <div className="flex flex-wrap gap-1.5">
          <Chip selected={!env.place} onClick={() => void setEnvironment(tab, { place: null, timezone: null, locale: null })}>
            <Icon icon={Globe} size={12} /> This machine
          </Chip>
          {PLACES.map((p) => (
            <Chip key={p.id} selected={env.place === p.id} onClick={() => void setEnvironment(tab, { place: p.id, timezone: null, locale: null })}>
              {p.name}
            </Chip>
          ))}
        </div>
      </Section>
    </>
  );
}
