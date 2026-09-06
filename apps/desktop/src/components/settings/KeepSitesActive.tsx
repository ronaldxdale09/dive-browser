import { useEffect, useState } from "react";
import { ipc } from "../../lib/ipc";
import { useBrowser } from "../../store/browser";
import { Group } from "../SettingsFields";
import { errorMessage } from "../../lib/errors";

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
      .catch((cause: unknown) => { if (current) setError(String(cause)); })
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
  return <Group title="Keep sites active" description="Inactive Today tabs may unload after one hour and restore when opened. Pinned tabs and pages with ongoing activity stay active. These site exceptions apply to this profile, including every page at the same address and port.">
    <form className="flex gap-2 py-3" onSubmit={(event) => { event.preventDefault(); if (!busy && url.trim()) void save(url.trim(), true); }}>
      <input aria-label="Site to keep active" type="url" placeholder="https://example.com" value={url} onChange={(event) => setUrl(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-line-2 bg-ground px-2 py-1.5 text-xs" />
      <button type="submit" disabled={busy || !url.trim()} className="rounded-lg border border-line-2 px-3 text-xs disabled:opacity-40">Add site</button>
    </form>
    {error && <p role="alert" className="pb-3 text-xs text-danger">{error}</p>}
    {sites.map((site) => <div key={site} className="flex items-center justify-between gap-3 border-t border-line py-2 text-xs">
      <span className="truncate">{site}</span>
      <button type="button" disabled={busy} onClick={() => void save(site, false)} aria-label={`Remove ${site}`} className="rounded-full border border-line px-3 py-1.5 text-xs disabled:opacity-40">Remove</button>
    </div>)}
  </Group>;
}
