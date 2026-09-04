import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import { useReducedMotion } from "../lib/useReducedMotion";

interface FontValue {
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number | string;
  lineHeight?: number | string;
  letterSpacing?: number | string;
  textAlign?: CSSProperties["textAlign"];
}

interface ColorsValue {
  paletteCount?: number;
  color1?: string;
  color2?: string;
  color3?: string;
  color4?: string;
  color5?: string;
}

interface CharacterBgProps {
  speed?: number;
  reverse?: boolean;
  gap?: number;
  backgroundColor?: string;
  className?: string;
  style?: CSSProperties;
  font?: FontValue;
  gridText?: string;
  colors?: ColorsValue;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseColor(input?: string): Rgb {
  if (!input) return { r: 255, g: 255, b: 255 };
  const value = input.trim();
  if (value.startsWith("#")) {
    let hex = value.slice(1);
    if (hex.length === 3) hex = [...hex].map((character) => character + character).join("");
    const parsed = Number.parseInt(hex.slice(0, 6), 16);
    if (Number.isNaN(parsed)) return { r: 255, g: 255, b: 255 };
    return { r: (parsed >> 16) & 255, g: (parsed >> 8) & 255, b: parsed & 255 };
  }
  const match = value.match(/rgba?\(([^)]+)\)/i);
  if (!match?.[1]) return { r: 255, g: 255, b: 255 };
  const parts = match[1].split(",").map((part) => Number.parseFloat(part));
  return { r: parts[0] || 0, g: parts[1] || 0, b: parts[2] || 0 };
}

function paletteAt(colors: string[], position: number): string {
  if (colors.length === 0) return "rgb(255, 255, 255)";
  if (colors.length === 1) return colors[0] ?? "rgb(255, 255, 255)";
  const scaled = Math.max(0, Math.min(1, position)) * (colors.length - 1);
  const index = Math.floor(scaled);
  const fraction = scaled - index;
  const start = parseColor(colors[index]);
  const end = parseColor(colors[Math.min(index + 1, colors.length - 1)]);
  return `rgb(${Math.round(start.r + (end.r - start.r) * fraction)}, ${Math.round(start.g + (end.g - start.g) * fraction)}, ${Math.round(start.b + (end.b - start.b) * fraction)})`;
}

function useInView(ref: RefObject<HTMLElement | null>) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? false), { threshold: 0 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return inView;
}

/** Repeating characters animated by one shared CSS time value. */
export function CharacterBg({
  speed = 75,
  reverse = true,
  gap = 10,
  backgroundColor = "transparent",
  className,
  style,
  font = {
    fontFamily: '"Geist Mono Variable", monospace',
    fontWeight: 500,
    fontSize: 12,
    lineHeight: 1,
    letterSpacing: "0.08em",
    textAlign: "left",
  },
  gridText = "DIVE",
  colors: colorsProp = { paletteCount: 1, color1: "#70C2E9" },
}: CharacterBgProps) {
  const cleanId = useId().replace(/:/g, "");
  const instanceId = `character-bg-${cleanId}`;
  const palette = Array.from({ length: Math.max(1, Math.min(5, colorsProp.paletteCount ?? 1)) }, (_, index) => {
    const key = `color${index + 1}` as keyof ColorsValue;
    const value = colorsProp[key];
    return typeof value === "string" ? value.trim() : "";
  }).filter(Boolean);
  if (palette.length === 0) palette.push("#FFFFFF");

  const parsedFontSize = Number.parseFloat(String(font.fontSize));
  const tileSize = Math.max(Number.isNaN(parsedFontSize) ? 14 : parsedFontSize, 10) + gap;
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(containerRef);
  const reducedMotion = useReducedMotion();

  const rawCols = Math.max(1, Math.ceil(dimensions.width / tileSize));
  const cols = rawCols + (rawCols % 2 === 1 ? 1 : 0);
  const rows = Math.max(1, Math.ceil(dimensions.height / tileSize));

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      setDimensions((current) => (current.width === width && current.height === height ? current : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [tileSize]);

  useEffect(() => {
    if (!isInView || reducedMotion) return;
    let animationFrame = 0;
    let time = 0;
    let lastFrameTime = 0;
    // This field is texture, not the focal animation. Fifteen updates a
    // second preserve its slow wave while halving style recalculation work.
    const frameInterval = 1000 / 15;
    const updateTime = (timestamp: number) => {
      if (!lastFrameTime || timestamp - lastFrameTime >= frameInterval) {
        time = (time + (reverse ? -10 : 10)) % 86_400_000;
        mainRef.current?.style.setProperty("--t", String(time));
        mainRef.current?.style.setProperty("--speed-factor", String(speed / 25));
        lastFrameTime = timestamp;
      }
      animationFrame = requestAnimationFrame(updateTime);
    };
    animationFrame = requestAnimationFrame(updateTime);
    return () => cancelAnimationFrame(animationFrame);
  }, [isInView, reducedMotion, reverse, speed]);

  const characters = gridText.length > 0 ? [...gridText] : ["D"];
  const styleContent = `
@property --t { syntax: "<integer>"; initial-value: 0; inherits: true; }
@property --speed-factor { syntax: "<number>"; initial-value: 1; inherits: true; }
.${instanceId}-canvas {
  position: relative;
  width: fit-content;
  height: fit-content;
  margin: 0 auto;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}
.${instanceId}-letter {
  position: absolute;
  --offset-x: calc(var(--x) - 0.5);
  --abs-x: calc(max(var(--offset-x), -1 * var(--offset-x)));
  --offset-y: calc(var(--y) - 0.5);
  --abs-y: calc(max(var(--offset-y), -1 * var(--offset-y)));
  --l: calc(sin(var(--abs-x) / cos(sin(var(--abs-y) * 2 + 60) * 2.5) * 3 - (var(--t) * var(--speed-factor)) / 350));
  display: flex;
  align-items: center;
  justify-content: center;
  width: ${tileSize}px;
  height: ${tileSize}px;
  color: var(--base-color);
  opacity: max(var(--l), 0.05);
  text-align: center;
}`;

  return (
    <div
      ref={containerRef}
      data-testid="character-background"
      aria-hidden="true"
      className={className}
      style={{
        overflow: "hidden",
        position: "relative",
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
        backgroundColor,
        pointerEvents: "none",
        contain: "strict",
        ...style,
        ...font,
      }}
    >
      <style>{styleContent}</style>
      <div
        ref={mainRef}
        className={`${instanceId}-canvas`}
        style={{ "--t": 0, width: cols * tileSize, height: rows * tileSize } as CSSProperties}
      >
        {Array.from({ length: cols * rows }, (_, index) => {
          const column = index % cols;
          const row = Math.floor(index / cols);
          const baseColor = paletteAt(palette, cols > 1 ? column / (cols - 1) : 0);
          return (
            <div
              className={`${instanceId}-letter`}
              style={
                {
                  "--x": ((index + 1) % cols) / (cols + 1),
                  "--y": (rows - row) / rows,
                  "--base-color": baseColor,
                  left: column * tileSize,
                  top: row * tileSize,
                } as CSSProperties
              }
              key={index}
            >
              {characters[index % characters.length]}
            </div>
          );
        })}
      </div>
    </div>
  );
}
