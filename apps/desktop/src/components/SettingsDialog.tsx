import {
  Captions,
  Check as CheckIcon,
  Copy,
  Download,
  ArrowDownToLine,
  Info,
  KeyRound,
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
import type { AppInfo, Command, Decision, ProviderInfo, SitePermission } from "../lib/ipc";
import { isReady, useAgent } from "../store/agent";
import { useBrowser } from "../store/browser";
import type { SettingsSection } from "../store/browser";
import { useUpdates } from "../store/updates";
import { formatChord } from "../lib/commands";
import { usePrefs } from "../store/prefs";
import type { Prefs } from "../store/prefs";
import { usePrivacy } from "../store/privacy";
import { Icon, IconButton } from "./Icon";
import { Button, Check, Group, Row, Segmented, Select, Switch, TextArea, TextInput } from "./SettingsFields";
import { useCoversContent } from "../lib/overlay";
import { useFadeClose } from "../lib/useFadeClose";
import { useFocusTrap } from "../lib/useFocusTrap";
import { AgentIcon } from "./agent/AgentIcon";
import { Appearance } from "./settings/Appearance";
import { SubtitlesControls } from "./settings/SubtitlesControls";

type SectionId = SettingsSection;

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "privacy", label: "Privacy", icon: ShieldCheck },
  { id: "downloads", label: "Downloads", icon: Download },
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
  const [section, setSection] = useState<SectionId>(initial);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const load = usePrefs((s) => s.load);
  useEffect(() => {
    void ipc.appInfo().then(setInfo);
    void load();
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
    case "downloads":
      return <Downloads />;
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

/** Preferences and the writer that persists a change to one of them. */
function usePref(): [Prefs, (patch: Partial<Prefs>) => void] {
  const prefs = usePrefs((s) => s.prefs);
  const update = usePrefs((s) => s.update);
  return [prefs, (patch) => void update(patch)];
}

const ENGINES = [
  { value: "duckduckgo", label: "DuckDuckGo" },
  { value: "google", label: "Google" },
  { value: "bing", label: "Bing" },
  { value: "brave", label: "Brave" },
  { value: "kagi", label: "Kagi" },
  { value: "startpage", label: "Startpage" },
  { value: "custom", label: "Custom…" },
] as const;

const ZOOMS = [50, 67, 75, 90, 100, 110, 125, 150, 175, 200].map((z) => ({ value: String(z), label: `${z}%` }));

function General() {
  const [prefs, set] = usePref();
  return (
    <>
      <Group title="Startup">
        <Row
          label="On launch"
          hint="What the window shows when Dive opens."
          control={
            <Segmented
              label="On launch"
              value={prefs.startup}
              onChange={(startup) => set({ startup })}
              options={[
                { value: "restore", label: "Last tab" },
                { value: "home", label: "Home page" },
                { value: "none", label: "Nothing" },
              ]}
            />
          }
        />
        <Row
          label="Home page"
          htmlFor="pref-homepage"
          hint="Opened at launch when “Home page” is chosen above. Leave it empty for the welcome screen."
          control={
            <TextInput
              id="pref-homepage"
              label="Home page"
              value={prefs.homepage}
              placeholder="https://…"
              onCommit={(homepage) => set({ homepage })}
            />
          }
        />
      </Group>

      <Group title="Search">
        <Row
          label="Search engine"
          htmlFor="pref-engine"
          hint="Used when what you type in the address bar is not a URL."
          control={
            <Select
              id="pref-engine"
              label="Search engine"
              value={prefs.search_engine}
              onChange={(search_engine) => set({ search_engine })}
              options={ENGINES}
            />
          }
        />
        {prefs.search_engine === "custom" && (
          <Row
            label="Search URL"
            htmlFor="pref-template"
            hint="Must contain {query}; without it Dive falls back to DuckDuckGo."
            control={
              <TextInput
                id="pref-template"
                label="Search URL"
                mono
                width="w-[300px]"
                value={prefs.search_template}
                placeholder="https://example.com/search?q={query}"
                onCommit={(search_template) => set({ search_template })}
              />
            }
          />
        )}
      </Group>

      <Group title="Pages">
        <Row
          label="Default zoom"
          htmlFor="pref-zoom"
          hint="Zoom new tabs open at. ⌘+ and ⌘− still change the tab in front of you."
          control={
            <Select
              id="pref-zoom"
              label="Default zoom"
              value={String(Math.round(prefs.default_zoom * 100))}
              onChange={(z) => set({ default_zoom: Number(z) / 100 })}
              options={ZOOMS}
            />
          }
        />
        <Row
          label="Fill tab with videos"
          hint="Hover a video for a control that makes it fill the tab, without taking over the screen. ⌘⇧F toggles it; Escape leaves."
          control={<Switch label="Fill tab with videos" checked={prefs.video_fill_tab} onChange={(video_fill_tab) => set({ video_fill_tab })} />}
        />
      </Group>
    </>
  );
}

const RETENTION = [
  { value: "0", label: "Forever" },
  { value: "90", label: "90 days" },
  { value: "30", label: "30 days" },
  { value: "7", label: "7 days" },
];

function Privacy() {
  const [prefs, set] = usePref();
  const privacyInfo = usePrivacy((s) => s.info);
  return (
    <>
      <Group
        title="DivePrivacy"
        description="Dive's curated ad, tracker, cosmetic, and YouTube protections. Rules ship inside the signed app and work offline."
      >
        <Row
          label="DivePrivacy protection"
          hint="Blocks common advertising, analytics, fingerprinting, telemetry, cryptomining, and popup infrastructure with bundled rules."
          control={
            <Switch
              label="DivePrivacy protection"
              checked={prefs.block_trackers}
              onChange={(block_trackers) => set({ block_trackers })}
            />
          }
        />
        <Row
          label="YouTube protection"
          hint="Applies narrow, fail-open protections on supported YouTube pages. Turning this off does not weaken general tracker protection."
          control={
            <Switch
              label="YouTube protection"
              checked={prefs.youtube_protection}
              disabled={!prefs.block_trackers}
              onChange={(youtube_protection) => set({ youtube_protection })}
            />
          }
        />
        <Row
          stacked
          label="Site exceptions"
          hint="Protection is paused only for these exact hosts. Developer request rules still apply."
          control={
            prefs.privacy_exceptions.length === 0 ? (
              <p className="text-[11px] text-ink-3">No site exceptions.</p>
            ) : (
              <div role="list" aria-label="Sites with paused DivePrivacy protection" className="flex flex-wrap gap-2">
                {prefs.privacy_exceptions.map((host) => (
                  <span
                    key={host}
                    role="listitem"
                    className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface-2 pl-2.5 pr-1 font-mono text-[10.5px] text-ink-2"
                  >
                    {host}
                    <button
                      type="button"
                      aria-label={`Resume protection on ${host}`}
                      onClick={() => set({ privacy_exceptions: prefs.privacy_exceptions.filter((exception) => exception !== host) })}
                      className="grid size-5 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink"
                    >
                      <Icon icon={X} size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )
          }
        />
        <Row
          label="Bundled ruleset"
          hint="This version is packaged with Dive and changes only when the app is updated."
          control={<span className="font-mono text-[11px] text-ink-2">{privacyInfo?.version ?? "…"}</span>}
        />
      </Group>

      <Group title="Requests">
        <Row
          label="Send “Do Not Track”"
          hint="Adds DNT: 1 and Sec-GPC: 1 to every request. Most sites ignore both."
          control={<Switch label="Send Do Not Track" checked={prefs.do_not_track} onChange={(do_not_track) => set({ do_not_track })} />}
        />
        <Row
          label="Run page JavaScript"
          hint="Off loads every page with scripting disabled — useful for checking what a page does without it."
          control={<Switch label="Run page JavaScript" checked={prefs.javascript} onChange={(javascript) => set({ javascript })} />}
        />
      </Group>

      <Group title="Advanced" description="Your custom URL globs are separate from DivePrivacy's curated rules.">
        <Row
          stacked
          label="Custom URL rules"
          hint="One host or URL pattern per line. A bare host matches anywhere in the URL; * is a wildcard."
          control={
            <TextArea
              label="Custom URL rules"
              value={prefs.blocked_patterns.join("\n")}
              placeholder={"ads.example.com\n*://*.tracker.dev/*"}
              onCommit={(text) =>
                set({
                  blocked_patterns: text
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean),
                })
              }
            />
          }
        />
      </Group>

      <Group title="History">
        <Row
          label="Keep history for"
          htmlFor="pref-history"
          hint="Older visits are dropped from the address bar and the palette."
          control={
            <Select
              id="pref-history"
              label="Keep history for"
              value={String(prefs.history_days)}
              onChange={(days) => set({ history_days: Number(days) })}
              options={RETENTION}
            />
          }
        />
      </Group>

      <ClearData />

      <SitePermissions />
    </>
  );
}

/** The kinds a page can ask for, as the rows name them. */
export const PERMISSION_KINDS: Record<string, string> = {
  camera: "Camera",
  microphone: "Microphone",
  geolocation: "Location",
  notifications: "Notifications",
  clipboard_read: "Read clipboard",
  display_capture: "Screen capture",
};

const DECISIONS: { value: Decision; label: string }[] = [
  { value: "allow", label: "Allow" },
  { value: "deny", label: "Block" },
  { value: "ask", label: "Ask" },
];

/** Remembered decisions, by origin; setting one back to Ask forgets it. */
export function groupPermissions(list: SitePermission[]): { origin: string; kinds: SitePermission[] }[] {
  const byOrigin = new Map<string, SitePermission[]>();
  for (const p of list) byOrigin.set(p.origin, [...(byOrigin.get(p.origin) ?? []), p]);
  return [...byOrigin.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([origin, kinds]) => ({ origin, kinds: kinds.sort((a, b) => a.kind.localeCompare(b.kind)) }));
}

function SitePermissions() {
  const [list, setList] = useState<SitePermission[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState<Record<string, true>>({});
  useEffect(() => {
    let alive = true;
    ipc
      .permissionsList()
      .then((l) => alive && setList(l))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [reload]);
  const decide = (p: SitePermission, decision: Decision) => {
    const key = `${p.origin}\n${p.kind}`;
    setList((l) => (l ?? []).flatMap((x) => (x.origin === p.origin && x.kind === p.kind ? (decision === "ask" ? [] : [{ ...x, decision }]) : [x])));
    setError(null);
    setSaving((s) => ({ ...s, [key]: true }));
    void ipc
      .permissionSet(p.origin, p.kind, decision)
      .catch((e: unknown) => {
        setList((l) => {
          const current = l ?? [];
          const without = current.filter((x) => !(x.origin === p.origin && x.kind === p.kind));
          return [...without, p];
        });
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setSaving((s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== key))));
  };
  const groups = groupPermissions(list ?? []);
  return (
    <Group title="Site permissions" description="What you have allowed or blocked, by site. A page asks again for anything set back to Ask.">
      {list === null && !error && <p className="py-3 text-xs text-ink-3">Loading…</p>}
      {error && (
        <div role="alert" className="flex items-center gap-3 py-3 text-xs text-danger">
          <span className="min-w-0 flex-1">{error}</span>
          <Button
            variant="quiet"
            onClick={() => {
              setList(null);
              setError(null);
              setReload((n) => n + 1);
            }}
          >
            Retry site permissions
          </Button>
        </div>
      )}
      {list !== null && !error && groups.length === 0 && <p className="py-3 text-xs text-ink-3">No site has asked for anything yet.</p>}
      {groups.map((g) => (
        <div key={g.origin} className="border-b border-line py-3 last:border-b-0">
          <p className="mb-1.5 truncate font-mono text-xs text-ink">{g.origin}</p>
          <div className="flex flex-col gap-1.5">
            {g.kinds.map((p) => (
              <div key={p.kind} className="flex items-center gap-3">
                <span className="min-w-0 flex-1 text-[11px] text-ink-2">{PERMISSION_KINDS[p.kind] ?? p.kind}</span>
                <Select disabled={Boolean(saving[`${p.origin}\n${p.kind}`])} label={`${g.origin} ${PERMISSION_KINDS[p.kind] ?? p.kind}`} value={p.decision} onChange={(d) => decide(p, d)} options={DECISIONS} />
                <button
                  type="button"
                  disabled={Boolean(saving[`${p.origin}\n${p.kind}`])}
                  aria-label={`Forget ${g.origin} ${PERMISSION_KINDS[p.kind] ?? p.kind}`}
                  onClick={() => decide(p, "ask")}
                  className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink"
                >
                  <Icon icon={X} size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </Group>
  );
}

function ClearData() {
  const [what, setWhat] = useState({ history: true, cookies: false, cache: false, site_data: false });
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nothing = !what.history && !what.cookies && !what.cache && !what.site_data;
  const clear = () => {
    setBusy(true);
    setResult(null);
    void ipc
      .browsingDataClear(what)
      .then(setResult)
      .catch((e: unknown) => setResult(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Group title="Clear browsing data" description="Open profiles clear immediately. Restart Dive after clearing cookies, cache, or site data to finish closed profiles and every stored origin.">
      <div className="flex flex-col gap-2 py-3">
        <Check label="Browsing history" checked={what.history} onChange={(history) => setWhat({ ...what, history })} />
        <Check label="Cookies and logins" checked={what.cookies} onChange={(cookies) => setWhat({ ...what, cookies })} />
        <Check label="Cached files" checked={what.cache} onChange={(cache) => setWhat({ ...what, cache })} />
        <Check label="Site data (local storage, IndexedDB)" checked={what.site_data} onChange={(site_data) => setWhat({ ...what, site_data })} />
        <div className="mt-1 flex items-center gap-3">
          <Button variant="danger" onClick={clear} disabled={busy || nothing}>
            {busy ? "Clearing…" : "Clear now"}
          </Button>
          {result && (
            <><span role="status" className="text-[11px] text-ink-2">{result}</span>{result.includes("restart Dive") && <Button onClick={() => ipc.appRestart()}>Restart now</Button>}</>
          )}
        </div>
      </div>
    </Group>
  );
}

function Downloads() {
  const [prefs, set] = usePref();
  return (
    <Group title="Files">
      <Row
        label="Save files to"
        htmlFor="pref-downloads"
        hint="Leave empty for ~/Downloads. A name already taken gets a “ (2)” suffix rather than overwriting."
        control={
          <TextInput
            id="pref-downloads"
            label="Save files to"
            mono
            width="w-[300px]"
            value={prefs.download_dir}
            placeholder="~/Downloads"
            onCommit={(download_dir) => set({ download_dir })}
          />
        }
      />
    </Group>
  );
}

function Developer({ info }: { info: AppInfo | null }) {
  const [prefs, set] = usePref();
  const command = info ? `claude mcp add --transport http dive ${info.mcp_url} --header "Authorization: Bearer $(cat '${info.mcp_token_path}')"` : "";
  return (
    <>
      <Group title="Tabs">
        <Row
          label="Open DevTools with new tabs"
          hint="Every tab opens with the Chromium inspector already attached."
          control={<Switch label="Open DevTools with new tabs" checked={prefs.devtools_on_open} onChange={(devtools_on_open) => set({ devtools_on_open })} />}
        />
      </Group>

      <Group title="Editor" description="Choose the editor to open when clicking source files or stack traces.">
        <Row
          label="Preferred editor"
          htmlFor="pref-editor"
          hint="Used for Jump-to-Source in console errors and element inspections."
          control={
            <Select
              id="pref-editor"
              label="Preferred editor"
              value={prefs.preferred_editor || "vscode"}
              onChange={(preferred_editor) => set({ preferred_editor })}
              options={[
                { value: "vscode", label: "VS Code (vscode://)" },
                { value: "cursor", label: "Cursor (cursor://)" },
                { value: "zed", label: "Zed (zed://)" },
              ]}
            />
          }
        />
      </Group>

      <Group title="Coding agents (MCP)" description="Claude Code, Cursor and Codex can read your tabs, console, network and screenshots. Run this once:">
        <div className="py-3">
          <CopyBlock text={command} />
          <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
            Only processes on this Mac with the token file can connect. Page scripts are never run unless you start Dive with DIVE_MCP_ALLOW_EVAL=1.
          </p>
        </div>
      </Group>
    </>
  );
}

const EFFORTS = [
  { value: "default", label: "Auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
] as const;

const STEP_LIMITS = ["10", "25", "50", "100", "200"] as const;

function Agent() {
  const [prefs, set] = usePref();
  const providers = useAgent((s) => s.providers);
  const keyed = useAgent((s) => s.keyed);
  const models = useAgent((s) => s.models);
  const loading = useAgent((s) => s.modelsLoading);
  const modelsError = useAgent((s) => s.modelsError);
  const loadModels = useAgent((s) => s.loadModels);
  const init = useAgent((s) => s.init);
  useEffect(() => void init(), [init]);
  const provider = providers.find((p) => p.id === prefs.agent_provider);
  const ready = isReady(provider, keyed);
  useEffect(() => {
    if (provider?.lists_models && ready) void loadModels(provider.id);
  }, [provider, ready, loadModels]);
  const list = models[prefs.agent_provider] ?? [];
  const known = list.some((m) => m.id === prefs.agent_model);
  const modelOptions = [...(known ? [] : [{ value: prefs.agent_model, label: prefs.agent_model }]), ...list.map((m) => ({ value: m.id, label: m.name }))];

  const switchProvider = (id: string) => {
    const next = providers.find((p) => p.id === id);
    if (!next) return;
    const keep = (models[id] ?? []).some((m) => m.id === prefs.agent_model);
    set({ agent_provider: id, agent_model: keep ? prefs.agent_model : next.default_model });
  };

  return (
    <>
      <Group title="Provider and model" description="Bring your own key. Two protocols cover every provider here, so switching is a matter of picking one.">
        <Row
          label="Provider"
          htmlFor="pref-provider"
          hint={provider ? (ready ? provider.note : `${provider.note} No key yet: add one below.`) : undefined}
          control={
            <Select
              id="pref-provider"
              label="Provider"
              value={prefs.agent_provider}
              onChange={switchProvider}
              options={providers.map((p) => ({ value: p.id, label: `${p.name}${keyed.includes(p.id) ? " · key saved" : !p.needs_key ? " · local" : ""}` }))}
            />
          }
        />
        {provider?.id === "custom" && (
          <Row
            label="Base URL"
            htmlFor="pref-agent-base"
            hint="Any OpenAI-compatible server. Most end in /v1."
            control={<TextInput id="pref-agent-base" mono label="Base URL" value={prefs.agent_custom_base_url} placeholder="https://host/v1" onCommit={(agent_custom_base_url) => set({ agent_custom_base_url })} />}
          />
        )}
        <Row
          label="Model"
          htmlFor="pref-model"
          hint={
            modelsError
              ? modelsError
              : list.length
                ? `${list.length} models listed by ${provider?.name ?? "the provider"}${loading ? ", refreshing…" : "."}`
                : provider && !ready
                  ? "Models are listed once a key is saved."
                  : "Type the id exactly as the provider names it."
          }
          control={
            list.length ? (
              <span className="flex items-center gap-2">
                <Select id="pref-model" label="Model" value={prefs.agent_model} onChange={(agent_model) => set({ agent_model })} options={modelOptions} />
                <Button variant="quiet" disabled={loading !== null} onClick={() => provider && void loadModels(provider.id, true)}>
                  Refresh
                </Button>
              </span>
            ) : (
              <TextInput id="pref-model" mono label="Model" value={prefs.agent_model} placeholder={provider?.default_model || "model id"} onCommit={(agent_model) => set({ agent_model })} />
            )
          }
        />
        <Row
          label="Thinking"
          hint="How hard the model reasons before it acts. Auto leaves it to the provider; higher settings are slower and cost more, and not every model supports them."
          control={<Segmented label="Thinking" value={prefs.agent_reasoning} onChange={(agent_reasoning) => set({ agent_reasoning })} options={EFFORTS} />}
        />
      </Group>

      <Group title="Behaviour">
        <Row
          label="Act without asking"
          hint="Off, every click, keystroke or navigation the agent wants waits for you. A page can steer the model, so leave this off unless you are watching."
          control={<Switch label="Act without asking" checked={prefs.agent_auto_approve} onChange={(agent_auto_approve) => set({ agent_auto_approve })} />}
        />
        <Row
          label="Send page context"
          hint="The tab's title, URL, recent console, failed requests and visible text go with each message. Off saves tokens; the agent can still read the page with its tools."
          control={<Switch label="Send page context" checked={prefs.agent_include_page} onChange={(agent_include_page) => set({ agent_include_page })} />}
        />
        <Row
          label="Step limit"
          htmlFor="pref-agent-steps"
          hint="Most tool calls one message may make before the run is stopped."
          control={<Select id="pref-agent-steps" label="Step limit" value={String(prefs.agent_max_steps)} onChange={(v) => set({ agent_max_steps: Number(v) })} options={STEP_LIMITS.map((v) => ({ value: v, label: v }))} />}
        />
      </Group>

      <Group title="API keys" description="One key per provider, in your OS keychain. A key leaves this Mac only in calls to its own provider. The Agent panel (⌘J) can add these too.">
        {providers
          .filter((p) => p.needs_key)
          .map((p) => (
            <KeyRow key={p.id} provider={p} saved={keyed.includes(p.id)} />
          ))}
      </Group>
    </>
  );
}

function KeyRow({ provider, saved }: { provider: ProviderInfo; saved: boolean }) {
  const saveKey = useAgent((s) => s.saveKey);
  const verifyKey = useAgent((s) => s.verifyKey);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const submit = async () => {
    setBusy(true);
    try {
      const verdict = await verifyKey(provider.id, key.trim());
      setStatus(verdict);
      if (verdict.ok) {
        await saveKey(provider.id, key.trim());
        setKey("");
        setEditing(false);
      }
    } catch (e) {
      setStatus({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const hint = status ? <span className={status.ok ? "text-highlight" : "text-danger"}>{status.message}</span> : saved ? "Saved in your keychain." : provider.note;
  return (
    <Row
      label={provider.name}
      hint={hint}
      control={
        saved && !editing ? (
          <span className="flex items-center gap-2">
            <Button variant="quiet" onClick={() => setEditing(true)}>
              Replace
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setStatus(null);
                void saveKey(provider.id, "");
              }}
            >
              Remove
            </Button>
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <span className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface-2 pl-2.5 pr-1 focus-within:border-line-2">
              <Icon icon={KeyRound} size={12} className="shrink-0 text-ink-3" />
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && key.trim() && void submit()}
                placeholder={provider.key_hint || "API key"}
                autoComplete="off"
                spellCheck={false}
                aria-label={`${provider.name} API key`}
                className="w-[170px] bg-transparent font-mono text-xs text-ink outline-none placeholder:text-ink-3"
              />
            </span>
            <Button variant="primary" disabled={!key.trim() || busy} onClick={() => void submit()}>
              {busy ? "Checking…" : "Save"}
            </Button>
            {editing && (
              <Button
                variant="quiet"
                onClick={() => {
                  setEditing(false);
                  setKey("");
                  setStatus(null);
                }}
              >
                Cancel
              </Button>
            )}
          </span>
        )
      }
    />
  );
}

function Shortcuts() {
  const [cmds, setCmds] = useState<Command[]>([]);
  useEffect(() => {
    void ipc.commandsList().then(setCmds);
  }, []);
  const bound = cmds.filter((c) => c.keybinding);
  return (
    <Group title="Keyboard" description="Every command is also in the palette (⌘K), which searches tabs, history, bookmarks and local servers.">
      {bound.map((c) => (
        <div key={c.id} className="flex items-center gap-4 border-b border-line py-2.5 last:border-b-0">
          <span className="min-w-0 flex-1 truncate text-xs text-ink">{c.title}</span>
          <kbd className="rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-ink-2">{chord(c.keybinding ?? "")}</kbd>
        </div>
      ))}
      {bound.length === 0 && <p className="py-3 text-xs text-ink-3">No commands registered.</p>}
      {/* Chords the chrome owns outright: they never reach the host, so the
          command registry does not know about them. */}
      {CHROME_CHORDS.map((c) => (
        <div key={c.title} className="flex items-center gap-4 border-b border-line py-2.5 last:border-b-0">
          <span className="min-w-0 flex-1 truncate text-xs text-ink">{c.title}</span>
          <kbd className="rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-ink-2">{c.keys}</kbd>
        </div>
      ))}
    </Group>
  );
}

const CHROME_CHORDS = [
  { title: "Switch to workspace 1–9", keys: "⌘1 … ⌘9" },
  { title: "New workspace", keys: "⌘⇧N" },
  { title: "Edit current workspace", keys: "⌘⇧E" },
];

/** "mod+shift+s" as the glyphs the menus show. */
const chord = (k: string) => formatChord(k);

function About({ info }: { info: AppInfo | null }) {
  return (
    <>
      <Group title="This build">
        <Row label="Version" control={<span className="font-mono text-[11px] text-ink-2 select-text">{info?.version ?? "…"}</span>} />
        <Row label="Engine" hint="Chromium through CEF, one process tree per container." control={<span className="font-mono text-[11px] text-ink-2">CEF</span>} />
        <Row
          stacked
          label="Data folder"
          hint="Profiles, history, bookmarks, captures and preferences."
          control={<code className="block font-mono text-[11px] break-all text-ink-2 select-text">{info?.data_dir ?? "…"}</code>}
        />
        <Row
          stacked
          label="MCP endpoint"
          hint={info?.mcp_url ? "Coding agents on this Mac connect here; the Developer section has the full command." : "Disabled in this build."}
          control={info?.mcp_url ? <CopyBlock text={info.mcp_url} label="Copy MCP URL" /> : <code className="block font-mono text-[11px] text-ink-2">disabled</code>}
        />
      </Group>
      <Updates />
    </>
  );
}

/** Check for a newer build and install it. */
function Updates() {
  const status = useUpdates((s) => s.status);
  const update = useUpdates((s) => s.update);
  const error = useUpdates((s) => s.error);
  const installing = useUpdates((s) => s.installing);
  const check = useUpdates((s) => s.check);
  const install = useUpdates((s) => s.install);
  return (
    <Group title="Updates">
      <Row
        label={status === "available" && update ? `Dive ${update.version} is available` : "Check for updates"}
        hint={
          status === "available" ? (
            update?.notes ? <span className="block whitespace-pre-wrap">{update.notes}</span> : "Installing restarts Dive."
          ) : status === "none" ? (
            "You're up to date, or this build has no updater."
          ) : status === "error" ? (
            <span className="text-danger">{error}</span>
          ) : (
            "Dive checks once shortly after launch."
          )
        }
        control={
          status === "available" ? (
            <Button variant="primary" disabled={installing} onClick={() => void install()}>
              {installing ? "Installing…" : "Install and restart"}
            </Button>
          ) : (
            <Button variant="quiet" disabled={status === "checking"} onClick={() => void check()}>
              {status === "checking" ? "Checking…" : status === "none" ? "Check again" : "Check for updates"}
            </Button>
          )
        }
      />
      {status === "none" && (
        <p role="status" className="flex items-center gap-1.5 py-2.5 text-[11px] text-ink-2">
          <Icon icon={CheckIcon} size={12} className="text-highlight" /> You're up to date
        </p>
      )}
      {status === "available" && (
        <p role="status" className="flex items-center gap-1.5 py-2.5 text-[11px] text-ink-2">
          <Icon icon={ArrowDownToLine} size={12} className="text-highlight" /> Update available: {update?.version}
        </p>
      )}
    </Group>
  );
}

function CopyBlock({ text, label = "Copy command" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line bg-surface-2 p-2">
      <code className="min-w-0 flex-1 font-mono text-[11px] break-all text-ink select-text">{text || "…"}</code>
      <button
        type="button"
        aria-label={label}
        disabled={!text}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="grid size-6 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-surface-3 hover:text-ink"
      >
        <Icon icon={copied ? CheckIcon : Copy} size={12} />
      </button>
    </div>
  );
}
