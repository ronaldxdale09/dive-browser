/**
 * One device on the stage: the body, the screen, the strips around the
 * page, and the page slot whose rectangle the engine positions the native
 * view over.
 *
 * Everything inside the screen is laid out in device CSS pixels and scaled
 * as a whole, so the strips, the cutout and the page keep their proportions
 * at any zoom. `getBoundingClientRect` accounts for the transform, which is
 * what makes the reported page rectangle correct at 42% as well as at 100%.
 */
import { useEffect, useRef } from "react";
import type { DevicePreset } from "../../data/devices";
import { stripsFor } from "../../data/devices";
import { createBoundsReporter, elementBounds } from "../../lib/boundsReporter";
import { BottomBar, Cutout, HomeIndicator, StatusBar, TopBar } from "./Chrome";
import type { Layout, UiMode } from "./geometry";

export interface DeviceFrameProps {
  /** Unrotated device. */
  device: DevicePreset;
  landscape: boolean;
  mode: UiMode;
  layout: Layout;
  /** Draw the bars dark. */
  dark: boolean;
  url: string;
  secure: boolean;
  /** Frozen live viewport shown while a chrome dialog covers the native view. */
  preview?: string | null;
  /** Called with the page slot's rectangle whenever it moves or resizes. */
  onPageRect: (rect: { x: number; y: number; width: number; height: number }) => void;
  /** Optional caption under the frame. */
  caption?: string;
}

/** The body colour and finish for a frame kind. */
function bodyStyle(device: DevicePreset, scale: number): { background: string; border: string; shadow: string } {
  const rim = Math.max(1.5, 2.5 * scale);
  switch (device.frame) {
    case "island":
    case "notch":
      // Titanium rim around a near-black bezel.
      return {
        background: "#0a0a0b",
        border: `${rim}px solid #6b6b70`,
        shadow: `0 ${40 * scale}px ${80 * scale}px -${24 * scale}px rgba(0,0,0,0.75), inset 0 0 0 ${Math.max(1, scale)}px rgba(255,255,255,0.12), 0 0 0 ${Math.max(1, 0.75 * scale)}px rgba(0,0,0,0.6)`,
      };
    case "home":
      // Silver iPhone: white face, aluminium edge.
      return {
        background: "linear-gradient(180deg, #fbfbfb, #ededed)",
        border: `${rim}px solid #bdbdbd`,
        shadow: `0 ${40 * scale}px ${80 * scale}px -${24 * scale}px rgba(0,0,0,0.6), inset 0 0 0 ${Math.max(1, scale)}px rgba(255,255,255,0.8)`,
      };
    case "punch":
      return {
        background: "#0c0c0d",
        border: `${rim}px solid #3a3a3e`,
        shadow: `0 ${40 * scale}px ${80 * scale}px -${24 * scale}px rgba(0,0,0,0.75), inset 0 0 0 ${Math.max(1, scale)}px rgba(255,255,255,0.08)`,
      };
    case "bezel":
      return {
        background: "#0e0e10",
        border: `${rim}px solid #4a4a4e`,
        shadow: `0 ${40 * scale}px ${80 * scale}px -${24 * scale}px rgba(0,0,0,0.7), inset 0 0 0 ${Math.max(1, scale)}px rgba(255,255,255,0.08)`,
      };
    case "laptop":
      return {
        background: "linear-gradient(180deg, #232326, #131315)",
        border: `${rim}px solid #3a3a3e`,
        shadow: `0 ${40 * scale}px ${80 * scale}px -${24 * scale}px rgba(0,0,0,0.7)`,
      };
  }
}

/** Side buttons: mute switch and volume on the left, power on the right. */
function SideButtons({ device, landscape, outer, scale }: { device: DevicePreset; landscape: boolean; outer: { width: number; height: number }; scale: number }) {
  if (device.frame === "home" || device.frame === "laptop" || device.frame === "bezel") return null;
  const apple = device.platform === "iOS";
  const thickness = 3.5 * scale;
  const colour = apple ? "#5c5c61" : "#2c2c2f";
  const radius = 2 * scale;
  // Positions along the long edge, as fractions of its length.
  const left = apple ? [{ at: 0.17, len: 0.035 }, { at: 0.24, len: 0.07 }, { at: 0.33, len: 0.07 }] : [{ at: 0.2, len: 0.06 }, { at: 0.28, len: 0.12 }];
  const right = apple ? [{ at: 0.27, len: 0.11 }] : [{ at: 0.24, len: 0.09 }];
  const along = landscape ? outer.width : outer.height;
  const place = (side: "left" | "right" | "top" | "bottom", b: { at: number; len: number }) => {
    const size = b.len * along;
    const offset = b.at * along;
    if (!landscape) {
      return side === "left"
        ? { left: -thickness, top: offset, width: thickness, height: size }
        : { right: -thickness, top: offset, width: thickness, height: size };
    }
    // Rotated: the left edge becomes the top, the right edge the bottom.
    return side === "left"
      ? { top: -thickness, left: along - offset - size, height: thickness, width: size }
      : { bottom: -thickness, left: along - offset - size, height: thickness, width: size };
  };
  return (
    <>
      {left.map((b, i) => (
        <span key={`l${i}`} aria-hidden className="absolute" style={{ ...place("left", b), background: colour, borderRadius: radius }} />
      ))}
      {right.map((b, i) => (
        <span key={`r${i}`} aria-hidden className="absolute" style={{ ...place("right", b), background: colour, borderRadius: radius }} />
      ))}
    </>
  );
}

export function DeviceFrame({ device, landscape, mode, layout, dark, url, secure, preview, onPageRect, caption }: DeviceFrameProps) {
  const slot = useRef<HTMLDivElement>(null);
  const { scale, screen, strips, bezel, outer } = layout;
  const body = bodyStyle(device, scale);
  const outerRadius = (device.radius + Math.min(bezel.sides, bezel.top)) * scale;

  useEffect(() => {
    const el = slot.current;
    if (!el) return;
    const reporter = createBoundsReporter(() => elementBounds(el), onPageRect);
    reporter.schedule();
    const ro = new ResizeObserver(reporter.schedule);
    ro.observe(el);
    window.addEventListener("resize", reporter.schedule);
    return () => {
      reporter.dispose();
      ro.disconnect();
      window.removeEventListener("resize", reporter.schedule);
    };
    // Layout changes move the slot without resizing it (a zoom change at the
    // same fit), so the effect re-runs on every layout as well.
  }, [onPageRect, layout]);

  const statusHeight = mode === "none" ? 0 : strips.top - (mode === "browser" ? topBarHeight(device, landscape) : 0);

  return (
    <figure className="m-0 flex shrink-0 flex-col items-center gap-2">
      <div
        aria-label={`${device.name}${landscape ? ", landscape" : ""}`}
        className="relative"
        style={{
          width: outer.width,
          height: outer.height,
          borderRadius: outerRadius,
          background: body.background,
          boxShadow: body.shadow,
          border: body.border,
        }}
      >
        <SideButtons device={device} landscape={landscape} outer={outer} scale={scale} />
        {device.frame === "home" && !landscape && (
          <>
            {/* Earpiece and front camera in the forehead. */}
            <span aria-hidden className="absolute rounded-full" style={{ top: (bezel.top / 2 - 3) * scale, left: "50%", width: 54 * scale, height: 6 * scale, transform: "translateX(-50%)", background: "#3a3a3c", boxShadow: "inset 0 1px 1px rgba(0,0,0,0.6)" }} />
            <span aria-hidden className="absolute rounded-full" style={{ top: (bezel.top / 2 - 5) * scale, left: `calc(50% - ${50 * scale}px)`, width: 10 * scale, height: 10 * scale, background: "radial-gradient(circle at 35% 35%, #4a5a6a, #101418 70%)" }} />
            {/* Home button with its Touch ID ring. */}
            <span aria-hidden className="absolute rounded-full" style={{ bottom: (bezel.bottom / 2 - 27) * scale, left: "50%", width: 54 * scale, height: 54 * scale, transform: "translateX(-50%)", border: `${2.5 * scale}px solid #c4c4c6`, background: "radial-gradient(circle at 50% 40%, #ffffff, #e6e6e6)", boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.05)" }} />
          </>
        )}
        {device.frame === "home" && landscape && (
          <span aria-hidden className="absolute rounded-full" style={{ right: (bezel.bottom / 2 - 27) * scale, top: "50%", width: 54 * scale, height: 54 * scale, transform: "translateY(-50%)", border: `${2.5 * scale}px solid #c4c4c6`, background: "radial-gradient(circle at 50% 40%, #ffffff, #e6e6e6)" }} />
        )}
        {device.frame === "laptop" && (
          <>
            <span aria-hidden className="absolute rounded-full" style={{ top: (bezel.top / 2 - 3) * scale, left: "50%", width: 6 * scale, height: 6 * scale, transform: "translateX(-50%)", background: "radial-gradient(circle at 35% 35%, #3b4a5a, #0c1014 70%)" }} />
            <span aria-hidden className="absolute" style={{ bottom: 0, left: 0, right: 0, height: (bezel.bottom - 8) * scale, background: "linear-gradient(180deg, #2a2a2d, #1c1c1f)", borderTop: `${Math.max(1, scale)}px solid #3a3a3e`, borderRadius: `0 0 ${8 * scale}px ${8 * scale}px` }} />
            <span aria-hidden className="absolute rounded-b-md" style={{ bottom: (bezel.bottom - 12) * scale, left: "50%", width: outer.width * 0.16, height: 4 * scale, transform: "translateX(-50%)", background: "#0b0b0c" }} />
          </>
        )}
        {/* The screen: laid out at device size, scaled as one. */}
        <div
          className="absolute overflow-hidden bg-black"
          style={{
            left: bezel.sides * scale,
            top: bezel.top * scale,
            width: screen.width * scale,
            height: screen.height * scale,
            borderRadius: device.radius * scale,
            boxShadow: device.frame === "home" ? "none" : `inset 0 0 0 ${Math.max(1, scale)}px rgba(255,255,255,0.04)`,
          }}
        >
          <div
            className="flex flex-col"
            style={{ width: screen.width, height: screen.height, transform: `scale(${scale})`, transformOrigin: "top left", background: dark ? "#000" : "#fff" }}
          >
            {strips.top > 0 && (
              <div className="relative flex shrink-0 flex-col" style={{ height: strips.top }}>
                <StatusBar device={device} height={statusHeight} dark={dark} />
                <div style={{ height: statusHeight }} />
                {mode === "browser" && <TopBar device={device} landscape={landscape} dark={dark} url={url} secure={secure} />}
                <Cutout device={device} landscape={landscape} />
              </div>
            )}
            <div className="flex min-h-0 flex-1" style={{ paddingLeft: strips.left, paddingRight: strips.right }}>
              {/* The page: a native view is positioned over this element. */}
              <div ref={slot} className="relative min-h-0 flex-1 overflow-hidden" style={{ background: dark ? "#000" : "#fff" }}>
                {preview && <img aria-hidden src={preview} className="pointer-events-none absolute inset-0 size-full object-fill" />}
              </div>
            </div>
            {strips.bottom > 0 && (
              <div className="shrink-0" style={{ height: strips.bottom }}>
                {mode === "browser" ? <BottomBar device={device} landscape={landscape} dark={dark} url={url} secure={secure} /> : <HomeIndicator height={strips.bottom} dark={dark} />}
              </div>
            )}
          </div>
        </div>
      </div>
      {caption && <figcaption className="font-mono text-[10px] text-ink-3">{caption}</figcaption>}
    </figure>
  );
}

/** Height of the browser's top bar, so the status bar gets the rest of the top strip. */
function topBarHeight(device: DevicePreset, landscape: boolean): number {
  return stripsFor(device.frame, landscape).top;
}
