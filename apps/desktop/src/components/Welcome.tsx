import { Sparkles } from "lucide-react";
import { useBrowser } from "../store/browser";
import { Icon } from "./Icon";
import { OrbBurst } from "./OrbBurst";
import { CharacterBg } from "./CharacterBg";
import { FeatureReel } from "./FeatureReel";

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
            <Icon icon={Sparkles} size={13} /> Agent <Kbd dim>⌘J</Kbd>
          </button>
        </div>

        {/* One minute, every feature, looping: it says more than a grid of
            twelve cards could, and it is drawn from the same tokens as the
            chrome around it. */}
        <div className="mt-8 w-full">
          <FeatureReel />
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
