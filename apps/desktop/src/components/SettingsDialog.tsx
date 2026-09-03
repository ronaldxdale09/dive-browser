import {
  Check as CheckIcon,
  Copy,
  Download,
  Info,
  KeyRound,
  Keyboard,
  Palette as PaletteIcon,
  Plug,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { ipc } from "../lib/ipc";
import type { AppInfo, Command, ProviderInfo } from "../lib/ipc";
import { isReady, useAgent } from "../store/agent";
import { useBrowser } from "../store/browser";
import { DEFAULT_PREFS, usePrefs } from "../store/prefs";
import type { Prefs } from "../store/prefs";
import { Icon, IconButton } from "./Icon";
import { Button, Check, Group, Row, Segmented, Select, Switch, TextArea, TextInput } from "./SettingsFields";
import { useCoversContent } from "../lib/overlay";
import { AgentIcon } from "./agent/AgentIcon";

type SectionId = "general" | "appearance" | "privacy" | "downloads" | "developer" | "agent" | "shortcuts" | "about";

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "privacy", label: "Privacy", icon: ShieldCheck },
  { id: "downloads", label: "Downloads", icon: Download },
  { id: "developer", label: "Developer", icon: Plug },
  { id: "agent", label: "Agent", icon: AgentIcon as LucideIcon },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
  { id: "about", label: "About", icon: Info },
];

/** Settings: a section list on the left, one panel of settings on the right. */
export function SettingsDialog() {
  useCoversContent(true);
  const toggle = useBrowser((s) => s.toggle);
  const [section, setSection] = useState<SectionId>("general");
  const [info, setInfo] = useState<AppInfo | null>(null);
  const load = usePrefs((s) => s.load);
  useEffect(() => {
    void ipc.appInfo().then(setInfo);
    void load();
  }, [load]);
  const close = () => toggle("settings", false);

  // Up and down move through the sections, as in any preferences window.
  const onNavKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const at = SECTIONS.findIndex((s) => s.id === section);
    const next = SECTIONS[(at + (e.key === "ArrowDown" ? 1 : SECTIONS.length - 1)) % SECTIONS.length];
    if (next) setSection(next.id);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur-[2px]" onMouseDown={close}>
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
      </Group>
    </>
  );
}

const ACCENTS = ["#7FD8C8", "#8FB8F0", "#B79CF0", "#F0B35E", "#E58C8C", "#9ED67B", "#E9E9E9"];

function Appearance() {
  const [prefs, set] = usePref();
  return (
    <>
      <Group title="Theme">
        <Row
          label="Appearance"
          control={
            <Segmented
              label="Appearance"
              value={prefs.theme}
              onChange={(theme) => set({ theme })}
              options={[
                { value: "system", label: "System" },
                { value: "dark", label: "Dark" },
                { value: "light", label: "Light" },
              ]}
            />
          }
        />
        <Row
          label="Accent"
          hint="Highlights, focus rings and the active state. The first swatch keeps each theme's own accent."
          control={
            <div className="flex gap-2" role="radiogroup" aria-label="Accent">
              {ACCENTS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={c.toUpperCase() === prefs.accent.toUpperCase()}
                  aria-label={c === DEFAULT_PREFS.accent ? "Theme accent" : c}
                  onClick={() => set({ accent: c })}
                  className="size-5 rounded-full ring-offset-2 ring-offset-surface aria-checked:ring-2 aria-checked:ring-ink"
                  style={{ background: c }}
                />
              ))}
            </div>
          }
        />
        <Row
          label="Tell pages the theme"
          hint={
            prefs.theme === "system"
              ? "Available once the theme is set to Dark or Light; Dive cannot read the system setting on the page's behalf."
              : "Pages see prefers-color-scheme: " + prefs.theme + ". The device menu's per-tab override still wins."
          }
          control={
            <Switch
              label="Tell pages the theme"
              disabled={prefs.theme === "system"}
              checked={prefs.tell_pages_theme && prefs.theme !== "system"}
              onChange={(tell_pages_theme) => set({ tell_pages_theme })}
            />
          }
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
  return (
    <>
      <Group title="Requests">
        <Row
          label="Send “Do Not Track”"
          hint="Adds DNT: 1 and Sec-GPC: 1 to every request. Most sites ignore both."
          control={<Switch label="Send Do Not Track" checked={prefs.do_not_track} onChange={(do_not_track) => set({ do_not_track })} />}
        />
        <Row
          label="Block trackers"
          hint="Refuses requests to a short list of analytics and ad hosts. Blocked requests still appear in the Network panel."
          control={<Switch label="Block trackers" checked={prefs.block_trackers} onChange={(block_trackers) => set({ block_trackers })} />}
        />
        <Row
          stacked
          label="Blocked hosts"
          hint="One host or URL pattern per line. A bare host matches anywhere in the URL; * is a wildcard."
          control={
            <TextArea
              label="Blocked hosts"
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
        <Row
          label="Run page JavaScript"
          hint="Off loads every page with scripting disabled — useful for checking what a page does without it."
          control={<Switch label="Run page JavaScript" checked={prefs.javascript} onChange={(javascript) => set({ javascript })} />}
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
    </>
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
    <Group title="Clear browsing data" description="Cookies, cache and site data are cleared through open tabs, so a workspace with nothing open keeps its data.">
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
            <span role="status" className="text-[11px] text-ink-2">
              {result}
            </span>
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
function chord(k: string): string {
  return k.replace("mod", "⌘").replace("shift", "⇧").replace("alt", "⌥").replaceAll("+", "").toUpperCase();
}

function About({ info }: { info: AppInfo | null }) {
  return (
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
        control={<code className="block font-mono text-[11px] break-all text-ink-2 select-text">{info?.mcp_url || "disabled"}</code>}
      />
    </Group>
  );
}

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line bg-surface-2 p-2">
      <code className="min-w-0 flex-1 font-mono text-[11px] break-all text-ink select-text">{text || "…"}</code>
      <button
        type="button"
        aria-label="Copy command"
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
