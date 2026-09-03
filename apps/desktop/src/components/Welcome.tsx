import { ArrowRight } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { events, ipc } from "../lib/ipc";
import type { DevServer } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { OrbBurst } from "./OrbBurst";
import { CharacterBg } from "./CharacterBg";
import { AgentIcon } from "./agent/AgentIcon";

// Remotion is sizeable and only appears in the no-tabs welcome screen. Keep
// it off the browser chrome's startup path when a session restores real tabs.
const FeatureReel = lazy(() => import("./FeatureReel").then((module) => ({ default: module.FeatureReel })));

/** Empty-state landing: what Dive is and what it can do. */
export function Welcome() {
  const toggle = useBrowser((s) => s.toggle);
  return (
    <div className="welcome absolute inset-0 overflow-auto">
      <CharacterBg
        gridText="DIVE"
        colors={{ paletteCount: 1, color1: "#70C2E9" }}
        style={{ position: "absolute", inset: 0, opacity: 0.04 }}
      />
      <div className="relative z-10 mx-auto flex min-h-full w-full max-w-[1040px] flex-col items-center px-8 pt-6 pb-12">
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
            <AgentIcon size={13} className="text-highlight" /> Agent <Kbd dim>⌘J</Kbd>
          </button>
        </div>

        <ActiveDevServers />

        {/* One minute, every feature, looping: it says more than a grid of
            twelve cards could, and it is drawn from the same tokens as the
            chrome around it. */}
        <div className="mt-8 w-full">
          <Suspense fallback={<div className="aspect-[16/9] w-full rounded-2xl border border-line bg-surface" />}>
            <FeatureReel />
          </Suspense>
        </div>
        <p className="mt-4 text-[11px] text-ink-3">
          Press <Kbd dim>⌘K</Kbd> anywhere to search tabs, history, bookmarks, local servers and every command.
        </p>
      </div>
    </div>
  );
}
function Kbd({ children, dim = false }: { children: string; dim?: boolean }) {
  return <kbd className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${dim ? "bg-surface-3 text-ink-3" : "bg-ground/15"}`}>{children}</kbd>;
}

function ActiveDevServers() {
  const [servers, setServers] = useState<DevServer[]>([]);
  const openTab = useBrowser((s) => s.openTab);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    // `listen` resolves asynchronously; if the screen unmounts first the
    // handle would arrive after cleanup, so release it on arrival instead.
    let live = true;
    void ipc.devServersWatch(true);
    void ipc
      .devServers()
      .then((list) => {
        if (live) setServers(list);
      })
      .catch(() => undefined);
    void events.devServersChanged.listen((e) => setServers(e.payload.servers)).then((u) => {
      if (live) unlisten = u;
      else u();
    });
    return () => {
      live = false;
      unlisten?.();
      void ipc.devServersWatch(false);
    };
  }, []);

  if (servers.length === 0) return null;

  return (
    <div className="mt-6 w-full max-w-[560px] rounded-2xl border border-line bg-surface-2/60 p-3 shadow-sm">
      <div className="flex items-center gap-2 px-1 pb-2">
        <span className="size-2 animate-pulse rounded-full bg-emerald-400" aria-hidden />
        <span className="text-[11px] font-semibold tracking-wider text-ink uppercase">
          Detected Dev Server{servers.length > 1 ? "s" : ""}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {servers.map((s) => (
          <div
            key={s.port}
            className="flex items-center justify-between rounded-xl border border-line bg-surface px-3 py-2 transition-colors hover:border-line-2"
          >
            <div className="flex items-center gap-2.5">
              <span className="rounded-md bg-highlight-soft px-1.5 py-0.5 font-mono text-[11px] font-semibold text-highlight">
                :{s.port}
              </span>
              <span className="text-xs font-medium text-ink">{s.framework || "Web Server"}</span>
              {s.title && <span className="text-xs text-ink-3">({s.title})</span>}
            </div>
            <button
              type="button"
              onClick={() => void openTab(s.url)}
              className="flex h-7 items-center gap-1 rounded-lg bg-surface-2 px-2.5 text-xs font-medium text-ink transition-colors hover:bg-highlight hover:text-ground"
            >
              Open Tab
              <ArrowRight size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
