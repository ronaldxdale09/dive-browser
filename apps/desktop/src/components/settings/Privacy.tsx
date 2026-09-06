import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { ipc } from "../../lib/ipc";
import type { Decision, PermissionList, SitePermission } from "../../lib/ipc";
import { errorMessage } from "../../lib/errors";
import { useBrowser } from "../../store/browser";
import { usePrivacy } from "../../store/privacy";
import { Icon } from "../Icon";
import { Button, Check, Group, Row, Select, Switch, TextArea } from "../SettingsFields";
import { usePref } from "./usePref";

const RETENTION = [
  { value: "0", label: "Forever" },
  { value: "90", label: "90 days" },
  { value: "30", label: "30 days" },
  { value: "7", label: "7 days" },
];

/** Settings › Privacy: DivePrivacy, request policy, history, clearing and site permissions. */
export function Privacy() {
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
  const workspace = useBrowser((s) => s.activeWorkspace);
  const profile = useBrowser((s) => s.activeProfile);
  return <ScopedSitePermissions key={`${profile}-${workspace}`} />;
}

function ScopedSitePermissions() {
  const [context, setContext] = useState<PermissionList | null>(null);
  const [list, setList] = useState<SitePermission[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState<Record<string, true>>({});
  useEffect(() => {
    let alive = true;
    ipc
      .permissionsList()
      .then((l) => { if (alive) {setContext(l); setList(l.permissions);} })
      .catch((e: unknown) => alive && setError(errorMessage(e)));
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
      .permissionSet(p.scope, p.origin, p.kind, decision)
      .catch((e: unknown) => {
        setList((l) => {
          const current = l ?? [];
          const without = current.filter((x) => !(x.origin === p.origin && x.kind === p.kind));
          return [...without, p];
        });
        setError(errorMessage(e));
      })
      .finally(() => setSaving((s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== key))));
  };
  const groups = groupPermissions(list ?? []);
  return (
    <Group title="Site permissions" description={context ? `Remembered for ${context.profile_name} · ${context.container_name}. Ask removes the remembered decision; page-only choices end when the requesting page navigates or closes.` : "Permissions for the selected profile and container."}>
      {context && <p className="py-2 text-xs text-ink-3">Permissions from earlier versions must be approved again. Choices are now kept in this profile and container.</p>}
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
      .catch((e: unknown) => setResult(errorMessage(e)))
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
