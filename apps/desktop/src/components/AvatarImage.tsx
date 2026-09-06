import { useEffect, useState } from "react";
import type { ImgHTMLAttributes } from "react";
import { AvatarCache, avatarKey } from "../lib/avatarCache";
import type { AvatarInput } from "../lib/avatarCache";

const cache = new AvatarCache(
  () => {
    const worker = new Worker(new URL("../lib/avatar.worker.ts", import.meta.url), { type: "module", name: "Dive avatars" });
    // A single bounded diagnostic mark lets native probes distinguish warm
    // cache reuse from silently regenerating all artwork after every restart.
    if (!performance.getEntriesByName("dive:avatar-worker-start").length) performance.mark("dive:avatar-worker-start");
    return worker;
  },
  () => window.localStorage,
  (run) => {
    const idle = () => {
      if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 1500 });
      else setTimeout(run, 0);
    };
    // A frame callback precedes paint, and font readiness can delay FCP further.
    // Observe the actual paint before spending work on uncached artwork.
    if (performance.getEntriesByName("first-contentful-paint").length) {
      idle();
    } else if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes.includes("paint")) {
      const observer = new PerformanceObserver((entries) => {
        if (entries.getEntries().some((entry) => entry.name === "first-contentful-paint")) {
          observer.disconnect();
          idle();
        }
      });
      observer.observe({ type: "paint", buffered: true });
    } else {
      requestAnimationFrame(() => requestAnimationFrame(idle));
    }
  },
);

function placeholder(kind: AvatarInput["kind"], color: string) {
  const fill = /^#[\da-f]{6}$/i.test(color) ? color : "#7FD8C8";
  const mark = kind === "profile" ? '<circle cx="16" cy="12" r="5"/><path d="M6 29c0-12 20-12 20 0"/>' : '<path d="M9 8h14v16H9z"/>';
  return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${fill}"/><g fill="#141414" opacity=".55">${mark}</g></svg>`)}`;
}

/** Warm artwork paints synchronously; cold generation never runs on the UI thread. */
export function AvatarImage({ kind, seed, color, ...props }: AvatarInput & Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "color">) {
  const key = avatarKey({ kind, seed, color });
  const [loaded, setLoaded] = useState<{ key: string; url: string }>();
  const url = loaded?.key === key ? loaded.url : cache.get({ kind, seed, color });
  useEffect(() => {
    let active = true;
    void cache.load({ kind, seed, color }).then((result) => {
      if (active && result) setLoaded({ key, url: result });
    });
    return () => { active = false; };
  }, [key, kind, seed, color]);
  return <img {...props} src={url ?? placeholder(kind, color)} data-avatar-state={url ? "ready" : "pending"} />;
}
