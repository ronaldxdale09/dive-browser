import { useEffect, useState } from "react";
import { ipc } from "../../lib/ipc";
import { useBrowser } from "../../store/browser";
import { Button, Group } from "../SettingsFields";
import { errorMessage } from "../../lib/errors";

/**
 * What was typed, as the site address the host expects. A bare host
 * ("example.com", "localhost:3000") gets https:// in front, which is what a
 * person means by it; anything already carrying a scheme is left for the
 * host to judge, so an ftp:// address is refused there with its reason.
 */
export function siteAddress(typed: string): string {
  const site = typed.trim();
  if (!site) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(site) ? site : `https://${site}`;
}

/** Keyed by profile so late loads and writes cannot leak into another profile. */
export function KeepSitesActive() {
  const profile = useBrowser((s) => s.activeProfile);
  return profile ? <Sites key={profile} profile={profile} /> : null;
}
function Sites({ profile }: { profile: string }) {
  const [sites, setSites] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let current = true;
    ipc.keepSitesList(profile).then((value) => { if (current) setSites(value); })
      .catch((cause: unknown) => { if (current) setError(errorMessage(cause)); })
      .finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [profile]);
  async function save(site: string, keep: boolean) {
    setBusy(true); setError(null);
    try {
      setSites(await ipc.keepSiteSet(profile, site, keep));
      if (keep) setUrl("");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  const add = () => {
    const site = siteAddress(url);
    if (!busy && site) void save(site, true);
  };
  return <Group title="Keep sites active" description="Inactive Today tabs may unload after one hour and restore when opened. Pinned tabs and pages with ongoing activity stay active. These site exceptions apply to this profile, including every page at the same origin.">
    <div className="flex gap-2 py-3">
      {/* Text, not url: a url field refuses "example.com" before the host
          ever sees it, and the browser's own bubble says so in words that
          do not match the rest of Settings. */}
      <input
        aria-label="Site to keep active"
        type="text"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        placeholder="example.com"
        value={url}
        onChange={(event) => { setUrl(event.target.value); setError(null); }}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); add(); }
          // A half-typed site is cleared by Escape before Escape closes Settings.
          if (event.key === "Escape" && url) { event.stopPropagation(); setUrl(""); }
        }}
        className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2.5 text-xs text-ink outline-none select-text placeholder:text-ink-3 hover:border-line-2 focus:border-highlight/60"
      />
      <Button variant="primary" onClick={add} disabled={busy || !url.trim()}>Add site</Button>
    </div>
    {error && <p role="alert" className="pb-3 text-xs text-danger">{error}</p>}
    {sites.map((site) => <div key={site} className="flex items-center justify-between gap-3 border-t border-line py-2 text-xs">
      <span className="truncate font-mono text-[11px] text-ink-2">{site}</span>
      <Button onClick={() => void save(site, false)} disabled={busy} ariaLabel={`Remove ${site}`}>Remove</Button>
    </div>)}
  </Group>;
}
