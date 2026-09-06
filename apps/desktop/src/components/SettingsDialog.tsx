import {
  Captions,
  Info,
  Keyboard,
  Palette as PaletteIcon,
  Plug,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { ipc } from "../lib/ipc";
import type { AppInfo } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import type { SettingsSection } from "../store/browser";
import { usePrefs } from "../store/prefs";
import { Icon, IconButton } from "./Icon";
import { useCoversContent } from "../lib/overlay";
import { useFadeClose } from "../lib/useFadeClose";
import { useFocusTrap } from "../lib/useFocusTrap";
import { AgentIcon } from "./agent/AgentIcon";
import { About } from "./settings/About";
import { Agent } from "./settings/Agent";
import { Appearance } from "./settings/Appearance";
import { Developer } from "./settings/Developer";
import { General } from "./settings/General";
import { Privacy } from "./settings/Privacy";
import { Shortcuts } from "./settings/Shortcuts";
import { SubtitlesControls } from "./settings/SubtitlesControls";

/** The panels the dialog has. "downloads" stays a valid request and lands on General, which holds the download folder. */
type SectionId = Exclude<SettingsSection, "downloads">;

export function resolveSection(section: SettingsSection): SectionId {
  return section === "downloads" ? "general" : section;
}

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "privacy", label: "Privacy", icon: ShieldCheck },
  { id: "developer", label: "Developer", icon: Plug },
  { id: "agent", label: "Agent", icon: AgentIcon as LucideIcon },
  { id: "subtitles", label: "Live subtitles", icon: Captions },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
  { id: "about", label: "About", icon: Info },
];

/** Settings: a section list on the left, one panel of settings on the right. */
export function SettingsDialog() {
  useCoversContent(true);
  const toggle = useBrowser((s) => s.toggle);
  // Opened on whichever panel the caller asked for (`openSettings("about")`).
  const initial = useBrowser((s) => s.settingsSection);
  const [section, setSection] = useState<SectionId>(() => resolveSection(initial));
  const [info, setInfo] = useState<AppInfo | null>(null);
  const load = usePrefs((s) => s.load);
  useEffect(() => {
    let alive = true;
    void ipc.appInfo().then((v) => alive && setInfo(v)).catch(() => alive && setInfo(null));
    void load();
    return () => {
      alive = false;
    };
  }, [load]);
  const { close, className } = useFadeClose(() => toggle("settings", false));
  const root = useRef<HTMLDivElement>(null);
  useFocusTrap(root);

  // Up and down move through the sections, as in any preferences window.
  const onNavKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const at = SECTIONS.findIndex((s) => s.id === section);
    const next = SECTIONS[(at + (e.key === "ArrowDown" ? 1 : SECTIONS.length - 1)) % SECTIONS.length];
    if (next) setSection(next.id);
  };

  return (
    <div ref={root} className={`overlay-backdrop fixed inset-0 z-50 grid place-items-center ${className}`} onMouseDown={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
        className="flex h-[min(620px,88vh)] w-[860px] max-w-[92vw] overflow-hidden rounded-2xl border border-line-2 bg-surface shadow-2xl"
      >
        <nav
          role="tablist"
          aria-label="Settings sections"
          aria-orientation="vertical"
          onKeyDown={onNavKey}
          className="flex w-[188px] shrink-0 flex-col border-r border-line bg-ground p-2.5"
        >
          <h2 className="px-2 pt-1 pb-2.5 text-sm font-semibold">Settings</h2>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              id={`settings-tab-${s.id}`}
              aria-selected={s.id === section}
              aria-controls={`settings-panel-${s.id}`}
              tabIndex={s.id === section ? 0 : -1}
              onClick={() => setSection(s.id)}
              className="flex h-8 items-center gap-2.5 rounded-lg px-2 text-xs text-ink-2 hover:bg-surface-2 hover:text-ink aria-selected:bg-surface-3 aria-selected:text-ink"
            >
              <Icon icon={s.icon} size={14} />
              {s.label}
            </button>
          ))}
          <span className="flex-1" />
          {info && <p className="px-2 pb-1 font-mono text-[10px] text-ink-3">Dive {info.version}</p>}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center border-b border-line px-5">
            <h3 className="text-sm font-semibold">{SECTIONS.find((s) => s.id === section)?.label}</h3>
            <span className="flex-1" />
            <IconButton icon={X} label="Close settings" onClick={close} />
          </header>
          <div
            role="tabpanel"
            id={`settings-panel-${section}`}
            aria-labelledby={`settings-tab-${section}`}
            className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-2"
          >
            <Panel section={section} info={info} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Panel({ section, info }: { section: SectionId; info: AppInfo | null }) {
  switch (section) {
    case "general":
      return <General />;
    case "appearance":
      return <Appearance />;
    case "privacy":
      return <Privacy />;
    case "developer":
      return <Developer info={info} />;
    case "agent":
      return <Agent />;
    case "subtitles":
      return <SubtitlesControls />;
    case "shortcuts":
      return <Shortcuts />;
    case "about":
      return <About info={info} />;
  }
}
