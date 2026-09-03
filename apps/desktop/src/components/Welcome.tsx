import {
  Camera,
  Clapperboard,
  ClipboardList,
  Layers,
  Network,
  Plug,
  Share2,
  Shuffle,
  Smartphone,
  Sparkles,
  Terminal,
  Video,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useBrowser } from "../store/browser";
import { Icon } from "./Icon";
import { OrbBurst } from "./OrbBurst";

interface Feature {
  icon: LucideIcon;
  title: string;
  text: string;
  keys?: string;
  /** What clicking the card opens. */
  open?: "palette" | "sidecar" | "dock" | "settings";
}

const FEATURES: Feature[] = [
  { icon: Video, title: "Screen recording", text: "Record any tab straight to a looping GIF, ready for a bug report or a PR.", keys: "⌘⇧R" },
  { icon: Camera, title: "Full-page capture", text: "Capture the whole document, mark it up with boxes, arrows, text and blur, copy it.", keys: "⌘⇧S" },
  { icon: Smartphone, title: "Mobile simulator", text: "Phone and tablet presets with touch, DPR and user agent, dark mode, reduced motion and 3G throttling." },
  { icon: Sparkles, title: "An agent that acts", text: "Reads the page, console and network, then clicks and types with your approval on every action.", keys: "⌘J", open: "sidecar" },
  { icon: Plug, title: "Built for coding agents", text: "Claude Code, Cursor and Codex connect over MCP and see your tabs, errors and traffic.", open: "settings" },
  { icon: Network, title: "Network inspector", text: "Replay and edit requests, export HAR or an inferred OpenAPI spec, watch WebSocket frames.", keys: "⌘⇧D", open: "dock" },
  { icon: Shuffle, title: "Mock and rewrite rules", text: "Block a request, answer it with a canned body, or add a header, per URL pattern and workspace.", open: "dock" },
  { icon: Terminal, title: "Console, vitals, a11y", text: "Errors resolved through source maps, Web Vitals with attribution, an axe audit and a storage editor.", open: "dock" },
  { icon: Clapperboard, title: "Recorder to Playwright", text: "Record your clicks and typing and export a spec with resilient locators." },
  { icon: ClipboardList, title: "Bug report composer", text: "One shortcut bundles a screenshot, console errors and failed requests into Markdown.", keys: "⌘⇧B" },
  { icon: Layers, title: "Workspaces", text: "Cookie-isolated containers per project; idle tabs archive themselves." },
  { icon: Share2, title: "Localhost and share", text: "Finds your dev servers, shares them on the LAN with a QR code." },
];

/** Empty-state landing: what Dive is and what it can do. */
export function Welcome() {
  const toggle = useBrowser((s) => s.toggle);
  return (
    <div className="welcome absolute inset-0 overflow-auto">
      <div className="mx-auto flex min-h-full w-full max-w-[1040px] flex-col items-center px-8 pt-6 pb-12">
        <OrbBurst width={190} height={190} className="-mb-4" />
        <p className="text-[10px] font-medium tracking-[0.18em] text-highlight uppercase">Dive</p>
        <h1 className="mt-2 text-center text-[30px] leading-tight font-semibold tracking-[-0.025em] text-balance">
          The browser built for developers
        </h1>
        <p className="mt-2 max-w-[520px] text-center text-[13px] leading-relaxed text-ink-2 text-balance">
          Chromium, a workspace per project, a developer toolkit that lives next to the page, and an agent that can work in your tabs.
        </p>
        <div className="mt-5 flex items-center gap-2">
          <button type="button" onClick={() => toggle("palette", true)} className="flex h-9 items-center gap-2 rounded-full bg-highlight px-4 text-xs font-medium text-ground transition-opacity hover:opacity-90">
            Open a tab <Kbd>⌘T</Kbd>
          </button>
          <button type="button" onClick={() => toggle("palette", true)} className="flex h-9 items-center gap-2 rounded-full border border-line-2 px-4 text-xs font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">
            Command palette <Kbd dim>⌘K</Kbd>
          </button>
          <button type="button" onClick={() => toggle("sidecar", true)} className="flex h-9 items-center gap-2 rounded-full border border-line-2 px-4 text-xs font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">
            <Icon icon={Sparkles} size={13} /> Agent <Kbd dim>⌘J</Kbd>
          </button>
        </div>

        <div className="mt-10 flex w-full items-center gap-3">
          <span className="h-px flex-1 bg-line" />
          <span className="text-[10px] font-medium tracking-[0.14em] text-ink-3 uppercase">Built in</span>
          <span className="h-px flex-1 bg-line" />
        </div>
        <ul className="mt-4 grid w-full grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
          {FEATURES.map((f) => (
            <li key={f.title}>
              <button
                type="button"
                onClick={() => f.open && toggle(f.open, true)}
                className={`group flex h-full w-full flex-col gap-2 rounded-xl border border-line bg-surface/70 p-3.5 text-left backdrop-blur-sm transition-colors ${
                  f.open ? "hover:border-line-2 hover:bg-surface-2" : "cursor-default"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-highlight-soft text-highlight">
                    <Icon icon={f.icon} size={14} />
                  </span>
                  <span className="text-[12.5px] font-medium text-ink">{f.title}</span>
                  <span className="flex-1" />
                  {f.keys && <Kbd dim>{f.keys}</Kbd>}
                </div>
                <p className="text-[11.5px] leading-relaxed text-ink-2">{f.text}</p>
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-[11px] text-ink-3">
          Press <Kbd dim>⌘K</Kbd> anywhere to search tabs, history, bookmarks, local servers and every command.
        </p>
      </div>
    </div>
  );
}

function Kbd({ children, dim = false }: { children: string; dim?: boolean }) {
  return <kbd className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${dim ? "bg-surface-3 text-ink-3" : "bg-ground/15"}`}>{children}</kbd>;
}
