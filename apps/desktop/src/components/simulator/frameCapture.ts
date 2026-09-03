/**
 * A screenshot with the device drawn around it.
 *
 * The engine captures the page at the device's pixel ratio, so an iPhone 15
 * capture is 1179 pixels wide. This draws the body, the status bar, the
 * browser bars and the home indicator around it at the same ratio, so the
 * result is the picture a person would take of the phone: sharp, correctly
 * proportioned, and ready to drop into a bug report or a design review.
 */
import type { DevicePreset } from "../../data/devices";
import { browserFor, stripsFor } from "../../data/devices";
import { ipc } from "../../lib/ipc";
import { displayHost, formatClock } from "./Chrome";
import { bezelFor, screenFor, stripsAround } from "./geometry";
import type { UiMode } from "./geometry";

/** Size of the framed image in output pixels, and the bezel in those pixels. */
export function framedSize(device: DevicePreset, landscape: boolean, ratio: number): { width: number; height: number; bezel: { sides: number; top: number; bottom: number } } {
  const screen = screenFor(device, landscape);
  const bezel = bezelFor(device.frame);
  return {
    width: Math.round((screen.width + bezel.sides * 2) * ratio),
    height: Math.round((screen.height + bezel.top + bezel.bottom) * ratio),
    bezel: { sides: bezel.sides * ratio, top: bezel.top * ratio, bottom: bezel.bottom * ratio },
  };
}

/**
 * The ratio between capture pixels and device CSS pixels. Read from the
 * capture rather than assumed from the preset, so a capture taken at a
 * different DPR still lines up.
 */
export function captureRatio(imageWidth: number, viewportWidth: number): number {
  return viewportWidth > 0 ? imageWidth / viewportWidth : 1;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function loadImage(base64: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not decode the capture"));
    img.src = `data:image/png;base64,${base64}`;
  });
}

export interface FramedCaptureInput {
  tabId: string;
  device: DevicePreset;
  landscape: boolean;
  mode: UiMode;
  dark: boolean;
  url: string;
}

/**
 * Capture the page and draw the device around it. Returns the saved path.
 */
export async function captureFramed({ tabId, device, landscape, mode, dark, url }: FramedCaptureInput): Promise<string> {
  const path = await ipc.tabCapture(tabId, false);
  const image = await loadImage(await ipc.captureRead(path));
  const screen = screenFor(device, landscape);
  const strips = stripsAround(device, landscape, mode);
  const viewportWidth = screen.width - strips.left - strips.right;
  const ratio = captureRatio(image.width, viewportWidth);
  const size = framedSize(device, landscape, ratio);

  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas");

  // Body.
  const outerRadius = (device.radius + Math.min(bezelFor(device.frame).sides, bezelFor(device.frame).top)) * ratio;
  const body = ctx.createLinearGradient(0, 0, size.width, size.height);
  const light = device.frame === "home";
  body.addColorStop(0, light ? "#f4f4f4" : "#3a3a3f");
  body.addColorStop(1, light ? "#d8d8d8" : "#0e0e10");
  roundedRect(ctx, 0, 0, size.width, size.height, outerRadius);
  ctx.fillStyle = body;
  ctx.fill();

  // Screen, clipped to its corners.
  const sx = size.bezel.sides;
  const sy = size.bezel.top;
  const sw = screen.width * ratio;
  const sh = screen.height * ratio;
  ctx.save();
  roundedRect(ctx, sx, sy, sw, sh, device.radius * ratio);
  ctx.clip();
  ctx.fillStyle = dark ? "#000" : "#fff";
  ctx.fillRect(sx, sy, sw, sh);

  // Page.
  const px = sx + strips.left * ratio;
  const py = sy + strips.top * ratio;
  ctx.drawImage(image, px, py);

  // Strips.
  const text = dark ? "#fff" : "#000";
  const barBg = dark ? "#1c1c1e" : "#f7f7f7";
  const pill = dark ? "#2c2c2e" : "#e9e9eb";
  const muted = dark ? "#8e8e93" : "#6e6e73";
  ctx.font = `600 ${16 * ratio}px -apple-system, "SF Pro Text", system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  if (strips.top > 0 && mode !== "none") {
    const android = device.platform === "Android";
    const statusH = (mode === "browser" ? strips.top - topBar(device, landscape) : strips.top) * ratio;
    // Status bar: clock left, indicators right.
    if (statusH > 0) {
      const cy = sy + (android ? statusH / 2 : Math.max(statusH - 18 * ratio, statusH / 2));
      ctx.fillStyle = text;
      ctx.textAlign = "left";
      ctx.fillText(formatClock(new Date(), android), sx + 28 * ratio, cy);
      // Signal, wifi and battery as simple shapes.
      const right = sx + sw - 28 * ratio;
      for (let i = 0; i < 4; i++) {
        const h = (4 + i * 2.5) * ratio;
        ctx.fillRect(right - 60 * ratio + i * 4.5 * ratio, cy + 6 * ratio - h, 3.2 * ratio, h);
      }
      ctx.beginPath();
      ctx.arc(right - 32 * ratio, cy + 4 * ratio, 1.5 * ratio, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1.6 * ratio;
      ctx.strokeStyle = text;
      ctx.beginPath();
      ctx.arc(right - 32 * ratio, cy + 5 * ratio, 5 * ratio, Math.PI * 1.2, Math.PI * 1.8);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(right - 32 * ratio, cy + 5 * ratio, 9 * ratio, Math.PI * 1.2, Math.PI * 1.8);
      ctx.stroke();
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = 1 * ratio;
      roundedRect(ctx, right - 23 * ratio, cy - 6 * ratio, 22 * ratio, 12 * ratio, 3 * ratio);
      ctx.stroke();
      ctx.globalAlpha = 1;
      roundedRect(ctx, right - 21.4 * ratio, cy - 4.4 * ratio, 18.8 * ratio, 8.8 * ratio, 2 * ratio);
      ctx.fill();
    }
    // Browser top bar.
    if (mode === "browser") {
      const th = topBar(device, landscape) * ratio;
      if (th > 0) {
        const ty = sy + statusH;
        ctx.fillStyle = browserFor(device.frame) === "chrome" ? (dark ? "#1f1f1f" : "#ffffff") : barBg;
        ctx.fillRect(sx, ty, sw, th);
        roundedRect(ctx, sx + 12 * ratio, ty + (th - 38 * ratio) / 2, sw - 24 * ratio, 38 * ratio, 12 * ratio);
        ctx.fillStyle = pill;
        ctx.fill();
        ctx.fillStyle = text;
        ctx.textAlign = "center";
        ctx.font = `500 ${15 * ratio}px -apple-system, system-ui, sans-serif`;
        ctx.fillText(displayHost(url), sx + sw / 2, ty + th / 2);
      }
    }
    // Cutout, over everything in the status area.
    if (!landscape) {
      ctx.fillStyle = "#000";
      if (device.frame === "island") {
        roundedRect(ctx, sx + sw / 2 - 63 * ratio, sy + 11 * ratio, 126 * ratio, 37 * ratio, 18.5 * ratio);
        ctx.fill();
      } else if (device.frame === "notch") {
        const w = Math.round(device.width * 0.56) * ratio;
        roundedRect(ctx, sx + sw / 2 - w / 2, sy - 20 * ratio, w, 50 * ratio, 20 * ratio);
        ctx.fill();
      } else if (device.frame === "punch") {
        ctx.beginPath();
        ctx.arc(sx + sw / 2, sy + 17 * ratio, 7 * ratio, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  if (strips.bottom > 0 && mode !== "none") {
    const bh = strips.bottom * ratio;
    const by = sy + sh - bh;
    if (mode === "browser" && browserFor(device.frame) === "safari" && !landscape && device.frame !== "home") {
      ctx.fillStyle = barBg;
      ctx.fillRect(sx, by, sw, bh);
      roundedRect(ctx, sx + 8 * ratio, by + 6 * ratio, sw - 16 * ratio, 38 * ratio, 12 * ratio);
      ctx.fillStyle = pill;
      ctx.fill();
      ctx.fillStyle = text;
      ctx.textAlign = "center";
      ctx.font = `500 ${15 * ratio}px -apple-system, system-ui, sans-serif`;
      ctx.fillText(displayHost(url), sx + sw / 2, by + 25 * ratio);
      ctx.fillStyle = muted;
      ctx.font = `${14 * ratio}px -apple-system, system-ui, sans-serif`;
      ctx.textAlign = "left";
      ctx.fillText("AA", sx + 20 * ratio, by + 25 * ratio);
    } else if (mode === "browser" && device.frame === "home") {
      ctx.fillStyle = barBg;
      ctx.fillRect(sx, by, sw, bh);
    }
    // Home indicator on anything with one.
    if (device.frame !== "home" && device.frame !== "laptop") {
      ctx.fillStyle = text;
      ctx.globalAlpha = 0.9;
      roundedRect(ctx, sx + sw / 2 - 67 * ratio, sy + sh - 13 * ratio, 134 * ratio, 5 * ratio, 2.5 * ratio);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();

  const png = canvas.toDataURL("image/png").split(",")[1] ?? "";
  return ipc.captureSave(png);
}

/** Only the browser's own bar; the status bar is the rest of the strip. */
function topBar(device: DevicePreset, landscape: boolean): number {
  return stripsFor(device.frame, landscape).top;
}
