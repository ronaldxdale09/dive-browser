import { Group, Row, Segmented, Select, Switch, TextInput } from "../SettingsFields";
import { KeepSitesActive } from "./KeepSitesActive";
import { usePref } from "./usePref";

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

/** Settings › General: startup, search and page defaults. */
export function General() {
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

      <KeepSitesActive />

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
