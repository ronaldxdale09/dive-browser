/**
 * The stage: where the page is shown inside a device.
 *
 * Measures the space it has, works out how big the frame can be, and tells
 * both sides — the frame, so it can draw at that size, and the engine, so
 * it can render the viewport at that scale while reporting the device's real
 * dimensions to the page. The page slot's rectangle becomes the native
 * view's bounds.
 */
import { Camera, Maximize2, MonitorSmartphone, RotateCw, Smartphone, X, ZoomIn } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "../../lib/ipc";
import { useBrowser } from "../../store/browser";
import { baseFor, selectMedia, useEmulation } from "../../store/emulation";
import type { DeviceSelection } from "../../store/emulation";
import { IconButton } from "../Icon";
import { useBarsDark } from "./Chrome";
import { DeviceFrame } from "./DeviceFrame";
import { usePicker } from "./DevicePicker";
import { captureFramed } from "./frameCapture";
import { layoutFor } from "./geometry";
import type { UiMode, Zoom } from "./geometry";

/** Width of the tool strip down the right edge of the stage. */
const TOOLS_WIDTH = 44;
/** Caption line under the frame, gap included. */
const CAPTION_HEIGHT = 26;

const ZOOMS: Zoom[] = ["fit", 50, 75, 100];

const UI_MODES: { id: UiMode; label: string }[] = [
  { id: "browser", label: "Browser" },
  { id: "standalone", label: "Web app" },
  { id: "none", label: "Screen" },
];

export function DeviceStage({ tabId, sel }: { tabId: string; sel: DeviceSelection }) {
  const stage = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  const tab = useBrowser((s) => s.tabs.find((t) => t.id === tabId));
  const media = useEmulation(selectMedia(tabId));
  const setScale = useEmulation((s) => s.setScale);
  const toggleLandscape = useEmulation((s) => s.toggleLandscape);
  const setZoom = useEmulation((s) => s.setZoom);
  const setUi = useEmulation((s) => s.setUi);
  const setDevice = useEmulation((s) => s.setDevice);
  const openPicker = usePicker((s) => s.setOpen);
  const setNotice = useCallback((notice: string | null) => useBrowser.setState({ notice }), []);
  const dark = useBarsDark(sel.ui, media.colorScheme);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    // The caption under the frame and the tool strip beside it come out of
    // the budget, or the frame fits and the caption does not.
    const measure = () => setAvailable({ width: el.clientWidth - TOOLS_WIDTH, height: el.clientHeight - CAPTION_HEIGHT });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const device = baseFor(sel);
  const layout = device && available.width > 0 ? layoutFor(device, sel.landscape, sel.ui, sel.zoom, available) : null;

  // The engine hears the scale after the stage has measured it, never a guess.
  useEffect(() => {
    if (layout) void setScale(tabId, layout.scale);
  }, [layout?.scale, tabId, setScale, layout]);

  const onPageRect = useCallback((rect: { x: number; y: number; width: number; height: number }) => {
    void ipc.setContentBounds(rect).catch(() => undefined);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.key === "r") void toggleLandscape(tabId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabId, toggleLandscape]);

  if (!device) return null;
  const url = tab?.url ?? "";
  const secure = url.startsWith("https://");
  const isLaptop = device.frame === "laptop";
  const zoomLabel = sel.zoom === "fit" ? (layout ? `${Math.round(layout.scale * 100)}%` : "fit") : `${sel.zoom}%`;
  const nextZoom = ZOOMS[(ZOOMS.indexOf(sel.zoom) + 1) % ZOOMS.length] ?? "fit";
  const nextUi = UI_MODES[(UI_MODES.findIndex((m) => m.id === sel.ui) + 1) % UI_MODES.length]?.id ?? "browser";
  const uiLabel = UI_MODES.find((m) => m.id === sel.ui)?.label ?? "Browser";

  const snapshot = async () => {
    try {
      const path = await captureFramed({ tabId, device, landscape: sel.landscape, mode: sel.ui, dark, url });
      setNotice(`Saved ${path.split("/").pop() ?? path}`);
      setTimeout(() => setNotice(null), 4000);
    } catch (e) {
      useBrowser.setState({ error: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div ref={stage} className="relative flex min-h-0 min-w-0 items-stretch bg-ground">
      <div className="scroll-hidden grid min-w-0 flex-1 place-items-center overflow-auto p-6" style={{ background: "radial-gradient(ellipse at 50% 40%, rgba(255,255,255,0.035), transparent 60%)" }}>
        {layout && (
          <DeviceFrame
            device={device}
            landscape={sel.landscape}
            mode={sel.ui}
            layout={layout}
            dark={dark}
            url={url}
            secure={secure}
            onPageRect={onPageRect}
            caption={`${device.name} · ${layout.viewport.width}×${layout.viewport.height} @${device.dpr}x · ${Math.round(layout.scale * 100)}%`}
          />
        )}
      </div>
      <div className="flex shrink-0 flex-col items-center gap-1 border-l border-line py-2" style={{ width: TOOLS_WIDTH }}>
        <IconButton icon={Smartphone} label="Choose device" onClick={() => openPicker(true)} tooltipAlign="end" />
        <IconButton icon={RotateCw} label="Rotate" shortcut="R" disabled={sel.deviceId === "custom"} onClick={() => void toggleLandscape(tabId)} tooltipAlign="end" />
        <IconButton icon={MonitorSmartphone} label={`Around the page: ${uiLabel}`} disabled={isLaptop} onClick={() => void setUi(tabId, nextUi)} tooltipAlign="end" active={sel.ui !== "browser" && !isLaptop} />
        <Tool label={`Zoom ${zoomLabel}`} onClick={() => setZoom(tabId, nextZoom)}>
          <ZoomIn size={15} strokeWidth={1.75} aria-hidden />
        </Tool>
        <IconButton icon={Maximize2} label="Fit to window" active={sel.zoom === "fit"} onClick={() => setZoom(tabId, "fit")} tooltipAlign="end" />
        <IconButton icon={Camera} label="Screenshot with device frame" onClick={() => void snapshot()} tooltipAlign="end" />
        <span className="flex-1" />
        <IconButton icon={X} label="Leave the simulator" onClick={() => void setDevice(tabId, null)} tooltipAlign="end" />
      </div>
    </div>
  );
}

/** An icon button with a text label under it, for the zoom readout. */
function Tool({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="flex w-9 flex-col items-center gap-0.5 rounded-lg py-1 text-ink-2 hover:bg-surface-3 hover:text-ink">
      {children}
      <span className="font-mono text-[9px] leading-none">{label.replace("Zoom ", "")}</span>
    </button>
  );
}
