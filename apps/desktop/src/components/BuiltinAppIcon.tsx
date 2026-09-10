import { useId } from "react";

// Original 32-unit glyphs: a shared optical weight, distinct silhouettes and
// two-tone surfaces. The ink contour carries recognition even with a low-
// contrast custom highlight; colour is never the only identifying feature.
const tint = "var(--color-highlight)";
const soft = { fill: tint, fillOpacity: 0.18 };
const solid = { fill: tint, stroke: "none" };

const artwork = {
  divescreen: <>
    <rect x="3" y="5" width="26" height="19" rx="5" {...soft} />
    <path d="m13 10 8 4.5-8 4.5Z" {...solid} />
    <path d="M7 28h12m4 0h2" />
    <circle cx="25" cy="7" r="3" fill={tint} stroke="var(--color-surface-2)" />
  </>,
  screenshot: <>
    <path d="M4 11V6a2 2 0 0 1 2-2h5m10 0h5a2 2 0 0 1 2 2v5m0 10v5a2 2 0 0 1-2 2h-5m-10 0H6a2 2 0 0 1-2-2v-5" />
    <path d="m16 7 8 4.5v9L16 25l-8-4.5v-9Z" {...soft} />
    <circle cx="16" cy="16" r="4" fill={tint} stroke="none" />
    <path d="m16 7 4 7m4 6.5H16M8 20.5l4-6.5" />
  </>,
  recorder: <>
    <path d="M8 3h12l5 5v16a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z" {...soft} />
    <path d="M19 3v6h6M10 12h5m-5 5h8m-8 5h4" />
    <circle cx="24" cy="23" r="6" fill="var(--color-surface-2)" />
    <path d="m22 20 5 3-5 3Z" {...solid} />
  </>,
  agent: <>
    <path d="m16 3 9.2 3.8L29 16l-3.8 9.2L16 29l-9.2-3.8L3 16l3.8-9.2Z" {...soft} />
    <path d="M16 3v4m13 9h-4m-9 13v-4M3 16h4" />
    <path d="m16 10 6 6-6 6-6-6Z" fill={tint} fillOpacity="0.5" />
    <circle cx="16" cy="16" r="1.8" fill="currentColor" stroke="none" />
  </>,
  subtitles: <>
    <path d="M8 8V5m4 3V2m4 6V4m4 4V2m4 6V5" stroke={tint} />
    <path d="M6 12h20a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H13l-5 3v-3H6a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3Z" {...soft} />
    <path d="M8 18h6m4 0h6M8 22h3m4 0h9" />
  </>,
  dock: <>
    <rect x="3" y="4" width="26" height="24" rx="4" />
    <path d="M3 17h26v7a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z" {...soft} />
    <path d="m8 21 2 2-2 2m6 0h4M3 10h26m-9 0v7" />
    <path d="M7 7h.01M10 7h.01" stroke={tint} strokeWidth="2" />
  </>,
  devtools: <>
    <path d="m16 3 12 7v13l-12 7-12-7V10Z" {...soft} />
    <path d="m11 11-5 5 5 5m10-10 5 5-5 5" />
    <path d="m18 10-4 12" stroke={tint} strokeWidth="2.5" />
  </>,
  simulator: <>
    <rect x="3" y="4" width="19" height="23" rx="3.5" {...soft} />
    <path d="M7 8h9M10 23h4" />
    <rect x="17" y="11" width="12" height="19" rx="3" fill="var(--color-surface-2)" />
    <rect x="20" y="16" width="6" height="7" rx="1" {...solid} />
    <path d="M22 14h2m-1 13h.01" />
  </>,
  extensions: <>
    <path d="m16 3 7 4-7 4-7-4Z" {...soft} />
    <path d="M9 7v8l7 4 7-4V7m-7 4v8" />
    <path d="m9 17 7 4-7 4-7-4Zm14 0 7 4-7 4-7-4Z" fill={tint} fillOpacity="0.4" />
    <path d="M2 21v6l7 4 7-4 7 4 7-4v-6M9 25v6m7-10v6m7-2v6" />
  </>,
  privacy: <>
    <path d="M16 2C12 5 8 6 5 6v10c0 7 6 11 11 14 5-3 11-7 11-14V6c-3 0-7-1-11-4Z" {...soft} />
    <path d="M16 6v19c4-2.5 7-5.5 7-10V9c-2.5-.5-5-1.5-7-3Z" {...solid} />
    <path d="m10 16 4 4 8-9" />
  </>,
  passwords: <>
    <rect x="4" y="3" width="24" height="26" rx="5" {...soft} />
    <path d="M8 3v26m20-18h-2m2 10h-2" />
    <circle cx="18" cy="13" r="4" fill={tint} fillOpacity="0.5" />
    <path d="M18 17v7m0-3h3" />
  </>,
  library: <>
    <path d="M3 28h26" />
    <rect x="4" y="6" width="6" height="19" rx="1.5" {...soft} />
    <rect x="12" y="3" width="6" height="22" rx="1.5" fill={tint} fillOpacity="0.45" />
    <path d="m20 8 4-1 5 17-4 1Z" {...soft} />
    <path d="M6 10h2m6-3h2m-2 14h2" />
  </>,
  // Stacked layers: what a page is built on, read from the bottom up.
  stack: <>
    <path d="m16 4 12 6-12 6L4 10Z" {...soft} />
    <path d="m4 16 12 6 12-6" />
    <path d="m4 22 12 6 12-6" />
  </>,
  // A dropper over a swatch: the pick, and what it landed on.
  color: <>
    <rect x="4" y="19" width="24" height="9" rx="2.5" {...soft} />
    <path d="M25.5 5.5a3 3 0 0 0-4.2 0l-1.6 1.6-1-1-2.1 2.1 6.2 6.2 2.1-2.1-1-1 1.6-1.6a3 3 0 0 0 0-4.2Z" />
    <path d="m18.4 11.6-7 7V22h3.4l7-7" {...solid} />
  </>,
} as const;

export type BuiltinAppId = keyof typeof artwork;

/** Self-contained SVG tile; all paints follow the current Dive palette. */
export function BuiltinAppIcon({ app, size = 40, className = "" }: { app: BuiltinAppId; size?: number; className?: string }) {
  const gradient = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" className={`shrink-0 ${className}`} style={{ color: "var(--color-ink)" }}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop stopColor="color-mix(in oklab, var(--color-highlight) 12%, var(--color-surface-2))" />
          <stop offset="1" stopColor="var(--color-surface-2)" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="39" height="39" rx="11" fill={`url(#${gradient})`} stroke="var(--color-line-2)" />
      <g transform="translate(6 6) scale(.875)" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
        {artwork[app]}
      </g>
    </svg>
  );
}
