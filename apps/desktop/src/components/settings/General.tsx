import { Button, Group, Row, Segmented, Select, Switch, TextInput } from "../SettingsFields";
import { useBrowser } from "../../store/browser";
import { useDefaultBrowser } from "../../store/defaultBrowser";
import { prettyBundleId } from "../DefaultBrowserDialog";
import { isPrivateWindow } from "../../lib/privateMode";
import { KeepSitesActive } from "./KeepSitesActive";
import { usePref } from "./usePref";
import { ipc } from "../../lib/ipc";
import { errorMessage } from "../../lib/errors";
import { credentialStoreName, defaultDownloadsHint, defaultDownloadsPlaceholder } from "../../lib/commands";

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
  const notify = useBrowser((s) => s.notify);
  const saveBackup = async () => {
    try {
      const path = await ipc.backupExport();
      if (path) notify(`Backup saved to ${path}`, 5000);
    } catch (error) {
      useBrowser.setState({ error: errorMessage(error) });
    }
  };
  const restoreBackup = async () => {
    try {
      const summary = await ipc.backupRestore(false);
      // No summary means the dialog was dismissed, which needs no notice.
      if (summary) {
        const parts = [
          summary.bookmarks && `${summary.bookmarks} bookmarks`,
          summary.history && `${summary.history} pages of history`,
          summary.form_entries && `${summary.form_entries} form entries`,
          summary.workspaces && `${summary.workspaces} workspaces`,
          summary.tabs && `${summary.tabs} tabs`,
        ].filter(Boolean);
        notify(parts.length ? `Restored ${parts.join(", ")}.` : "That backup held nothing this profile did not have already.", 6000);
      }
    } catch (error) {
      useBrowser.setState({ error: errorMessage(error) });
    }
  };
  const toggle = useBrowser((s) => s.toggle);
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
                { value: "none", label: "Start screen" },
              ]}
            />
          }
        />
        <Row
          label="Home page"
          htmlFor="pref-homepage"
          hint="Opened at launch when “Home page” is chosen above. Leave it empty and the start screen opens instead."
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
        <Row
          label="Suggestions from the search engine"
          hint="Completes what you type in the address bar. While this is on, what you type there is sent to your search engine as you type it — never in a private window, and never when it looks like an address."
          control={<Switch checked={prefs.search_suggestions} onChange={(search_suggestions) => set({ search_suggestions })} label="Suggestions from the search engine" />}
        />
        {prefs.search_engine === "custom" && (
          <Row
            label="Search URL"
            htmlFor="pref-template"
            hint={
              prefs.search_template.trim() && !prefs.search_template.includes("{query}") ? (
                <span className="text-warn">Put {"{query}"} where the search words go. Until then DuckDuckGo is used.</span>
              ) : (
                "Must contain {query}; without it Dive falls back to DuckDuckGo."
              )
            }
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

      {!isPrivateWindow() && <DefaultBrowserRow onOpen={() => toggle("defaultBrowser", true)} />}
      {!isPrivateWindow() && (
      <Group title="Import">
        <Row
          label="From another browser"
          hint="Bookmarks, history, passwords and form entries from Chrome, Brave, Edge, Arc, Vivaldi, Opera or Firefox; bookmarks and history from Safari. Cookies and extensions stay behind."
          control={<Button onClick={() => toggle("import", true)}>Import…</Button>}
        />
      </Group>
      )}
      {!isPrivateWindow() && (
      <Group title="Backup">
        <Row
          label="Save a backup"
          hint={`Bookmarks, history, form entries, preferences and every workspace's tabs, in one file. Saved passwords are not included — they stay in ${credentialStoreName()}; export those from Settings › Passwords if you need them.`}
          control={<Button onClick={() => void saveBackup()}>Save…</Button>}
        />
        <Row
          label="Restore from a backup"
          hint="Merged into this profile: nothing here is removed, and anything already saved is left alone, so restoring the same file twice changes nothing the second time. Restored tabs arrive asleep."
          control={<Button onClick={() => void restoreBackup()}>Restore…</Button>}
        />
      </Group>
      )}
      <Group title="Downloads">
        <Row
          label="Save files to"
          htmlFor="pref-downloads"
          hint={defaultDownloadsHint()}
          control={
            <TextInput
              id="pref-downloads"
              label="Save files to"
              mono
              width="w-[300px]"
              value={prefs.download_dir}
              placeholder={defaultDownloadsPlaceholder()}
              onCommit={(download_dir) => set({ download_dir })}
            />
          }
        />
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

/** Where links from other apps open, and the way to change it once the rail's offer has been rested. */
function DefaultBrowserRow({ onOpen }: { onOpen: () => void }) {
  const status = useDefaultBrowser((s) => s.status);
  if (!status?.supported) return null;
  return (
    <Group title="Default browser">
      <Row
        label="Links from other apps"
        hint={status.is_default ? "They open in Dive." : status.current ? `They open in ${prettyBundleId(status.current)}.` : "Dive is not the default browser."}
        control={status.is_default ? null : <Button onClick={onOpen}>Make default…</Button>}
      />
    </Group>
  );
}
