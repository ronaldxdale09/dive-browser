import { useBrowser } from "../store/browser";
import { BrandLogo } from "./BrandLogo";

/**
 * Quick access to the three assistants people reach for most. Each click opens
 * the site in a new tab of the active workspace, so a ChatGPT tab lands next
 * to the work it is for rather than replacing it.
 *
 * The marks are the official brand logos from svgl.app in their own colours,
 * because a monochrome approximation of the OpenAI knot or the Gemini spark
 * is exactly the kind of thing the eye fails to recognise at 16px.
 */
export interface AiSite {
  id: "chatgpt" | "claude" | "gemini";
  name: string;
  url: string;
}

export const AI_SITES: readonly AiSite[] = [
  { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/" },
  { id: "claude", name: "Claude", url: "https://claude.ai/" },
  { id: "gemini", name: "Gemini", url: "https://gemini.google.com/" },
];

export function AiLogo({ id, size = 16, className = "" }: { id: AiSite["id"]; size?: number; className?: string }) {
  return <BrandLogo id={id} size={size} className={className} />;
}

/** Row of assistant shortcuts shown at the top of the expanded rail. */
export function AiShortcuts() {
  const openTab = useBrowser((s) => s.openTab);
  return (
    <div role="group" aria-label="AI shortcuts" className="shrink-0 pb-1">
      <p className="px-2 pb-1.5 text-[9.5px] font-medium tracking-[0.08em] text-ink-3 uppercase">AI shortcuts</p>
      <div className="grid grid-cols-3 gap-1">
        {AI_SITES.map((site) => (
          <button
            key={site.id}
            type="button"
            aria-label={`Open ${site.name} in a new tab`}
            title={`${site.name} — opens in a new tab`}
            onClick={() => void openTab(site.url)}
            className="pressable flex h-10 flex-col items-center justify-center gap-1 rounded-lg text-ink-3 transition-[color,background-color,transform] hover:bg-surface-2 hover:text-ink"
          >
            <AiLogo id={site.id} size={14} />
            <span className="text-[9px] leading-none">{site.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
