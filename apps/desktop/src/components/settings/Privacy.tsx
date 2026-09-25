import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ipc } from "../../lib/ipc";
import type { Decision, PermissionList, SitePermission } from "../../lib/ipc";
import { errorMessage } from "../../lib/errors";
import { systemProxyHint } from "../../lib/navError";
import { useBrowser } from "../../store/browser";
import { usePrivacy } from "../../store/privacy";
import { Icon } from "../Icon";
import { Button, Check, Group, Row, Select, Switch, TextArea, TextInput } from "../SettingsFields";
import { usePref } from "./usePref";

const RETENTION = [
  { value: "0", label: "Forever" },
  { value: "90", label: "90 days" },
  { value: "30", label: "30 days" },
  { value: "7", label: "7 days" },
];

/** Settings › Privacy: DivePrivacy, request policy, history, clearing and site permissions. */
/** "Personal · Client work", or just "Personal" when the container carries the profile's own name. */
export function scopeLabel(profile: string, container: string): string {
  return container && container !== profile ? `${profile} · ${container}` : profile;
}

export function Privacy() {
  const [prefs, set] = usePref();
  const privacyInfo = usePrivacy((s) => s.info);
  return (
    <>
      <Group
        title="DivePrivacy"
        description="Dive's curated ad, tracker, cosmetic, and YouTube protections. Rules ship inside the app and work offline."
      >
        <Row
          label="DivePrivacy protection"
          hint="Blocks listed advertising and tracker hosts in the request pipeline."
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
          hint="Adds DNT: 1 and Sec-GPC: 1 to page requests. Most sites ignore both."
          control={<Switch label="Send Do Not Track" checked={prefs.do_not_track} onChange={(do_not_track) => set({ do_not_track })} />}
        />
        <Row
          label="Run page JavaScript"
          hint="Off loads pages with scripting disabled — useful for checking what a page does without it."
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

      <Group title="Connections">
        <Row
          label="Secure connections"
          hint="Asks for every page over https, and stops rather than quietly loading it in the clear. Your own machine is never upgraded — localhost, private addresses and .local, .test and .internal keep working as they are."
          control={<Switch label="Secure connections" checked={prefs.https_only} onChange={(https_only) => set({ https_only })} />}
        />
        {prefs.https_only_allowed.length > 0 && (
          <Row
            stacked
            label="Allowed in the clear"
            hint="Sites you chose to keep loading over http. Remove one to ask for https again."
            control={
              <div className="flex flex-wrap gap-1.5">
                {prefs.https_only_allowed.map((host) => (
                  <button
                    key={host}
                    type="button"
                    onClick={() => set({ https_only_allowed: prefs.https_only_allowed.filter((h) => h !== host) })}
                    className="flex h-7 items-center gap-1.5 rounded-full border border-line px-2.5 font-mono text-[11px] text-ink-2 hover:border-line-2 hover:text-ink"
                    title={`Ask for ${host} over https again`}
                  >
                    {host}
                    <Icon icon={X} size={11} />
                  </button>
                ))}
              </div>
            }
          />
        )}
      </Group>

      <Group
        title="Network"
        description="Chromium reads these once when it starts, so a change takes effect the next time Dive opens."
      >
        <Row
          label="Secure DNS"
          htmlFor="pref-dns-mode"
          hint="Encrypts the lookups that turn an address into a server, so the network you are on cannot read or rewrite them. Automatic falls back to the system resolver when encryption is unavailable; Secure refuses to, which is the point of choosing it."
          control={
            <Select
              id="pref-dns-mode"
              label="Secure DNS"
              value={prefs.dns_mode}
              onChange={(dns_mode) => set({ dns_mode })}
              options={[
                { value: "system", label: "Use the system resolver" },
                { value: "automatic", label: "Automatic" },
                { value: "secure", label: "Secure" },
              ]}
            />
          }
        />
        {prefs.dns_mode !== "system" && (
          <Row
            label="Resolver"
            htmlFor="pref-dns-provider"
            hint="Where lookups are sent."
            control={
              <Select
                id="pref-dns-provider"
                label="Resolver"
                value={prefs.dns_provider}
                onChange={(dns_provider) => set({ dns_provider })}
                options={[
                  { value: "cloudflare", label: "Cloudflare" },
                  { value: "google", label: "Google" },
                  { value: "quad9", label: "Quad9" },
                  { value: "custom", label: "Custom…" },
                ]}
              />
            }
          />
        )}
        {prefs.dns_mode !== "system" && prefs.dns_provider === "custom" && (
          <Row
            stacked
            label="Resolver address"
            htmlFor="pref-dns-template"
            hint="The DoH template, over https. An address that is not encrypted is ignored rather than used — that would be the opposite of this setting."
            control={
              <TextInput
                id="pref-dns-template"
                mono
                label="Resolver address"
                value={prefs.dns_template}
                placeholder="https://dns.example.com/dns-query"
                onCommit={(dns_template) => set({ dns_template })}
              />
            }
          />
        )}

        <Row
          label="Proxy"
          htmlFor="pref-proxy-mode"
          hint={systemProxyHint()}
          control={
            <Select
              id="pref-proxy-mode"
              label="Proxy"
              value={prefs.proxy_mode}
              onChange={(proxy_mode) => set({ proxy_mode })}
              options={[
                { value: "system", label: "Use system settings" },
                { value: "direct", label: "No proxy" },
                { value: "manual", label: "Manual" },
                { value: "pac", label: "Automatic (PAC script)" },
              ]}
            />
          }
        />
        {prefs.proxy_mode === "manual" && (
          <Row
            stacked
            label="Proxy address"
            htmlFor="pref-proxy-server"
            hint="host:port, or a scheme and address such as socks5://10.0.0.2:1080."
            control={
              <TextInput
                id="pref-proxy-server"
                mono
                label="Proxy address"
                value={prefs.proxy_server}
                placeholder="10.0.0.2:8080"
                onCommit={(proxy_server) => set({ proxy_server })}
              />
            }
          />
        )}
        {prefs.proxy_mode === "manual" && (
          <Row
            stacked
            label="Skip the proxy for"
            htmlFor="pref-proxy-bypass"
            hint="Comma separated. Your local servers belong here."
            control={
              <TextInput
                id="pref-proxy-bypass"
                mono
                label="Skip the proxy for"
                value={prefs.proxy_bypass}
                placeholder="localhost, 127.0.0.1, *.internal"
                onCommit={(proxy_bypass) => set({ proxy_bypass })}
              />
            }
          />
        )}
        {prefs.proxy_mode === "pac" && (
          <Row
            stacked
            label="PAC script"
            htmlFor="pref-proxy-pac"
            hint="The address of the script that decides which proxy to use."
            control={
              <TextInput
                id="pref-proxy-pac"
                mono
                label="PAC script"
                value={prefs.proxy_pac_url}
                placeholder="http://wpad/proxy.pac"
                onCommit={(proxy_pac_url) => set({ proxy_pac_url })}
              />
            }
          />
        )}
      </Group>

      <Group title="History">
        <Row
          label="Keep history for"
          htmlFor="pref-history"
          hint="Older visits are dropped from history, the address bar and the palette."
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
  const rows = useRef<HTMLDivElement>(null);
  // Which row keyboard focus should land on once a forgotten row is gone.
  const refocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = refocus.current;
    if (at === null || !rows.current) return;
    refocus.current = null;
    const forget = rows.current.querySelectorAll<HTMLButtonElement>("[data-forget-permission]");
    (forget[Math.min(at, forget.length - 1)] ?? rows.current).focus();
  }, [list]);
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
    // One write per row at a time. The row's controls stay enabled while it
    // saves -- disabling the focused dropdown dropped focus to the body, and
    // Escape then no longer closed Settings -- so a change made meanwhile is
    // ignored here instead.
    if (saving[key]) return;
    // "Ask" removes the row, and focus in it would fall to the body, where
    // Escape no longer closes Settings. Hand it to the next row instead.
    if (decision === "ask" && rows.current?.contains(document.activeElement)) {
      const forget = Array.from(rows.current.querySelectorAll("[data-forget-permission]"));
      const row = document.activeElement?.closest("[data-permission-row]");
      refocus.current = Math.max(0, forget.findIndex((b) => row?.contains(b)));
    }
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
    <Group title="Site permissions" description={context ? `Remembered for ${scopeLabel(context.profile_name, context.container_name)}. Ask removes the remembered decision; page-only choices end when the requesting page navigates or closes.` : "Permissions for the selected profile and container."}>
      {context?.legacy_ignored && <p className="py-2 text-xs text-ink-3">Permissions from earlier versions must be approved again. Choices are now kept in this profile and container.</p>}
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
      <div ref={rows} tabIndex={-1} className="outline-none">
      {groups.map((g) => (
        <div key={g.origin} className="border-b border-line py-3 last:border-b-0">
          <p className="mb-1.5 truncate font-mono text-xs text-ink">{g.origin}</p>
          <div className="flex flex-col gap-1.5">
            {g.kinds.map((p) => (
              <div key={p.kind} data-permission-row className="flex items-center gap-3">
                <span className="min-w-0 flex-1 text-[11px] text-ink-2">{PERMISSION_KINDS[p.kind] ?? p.kind}</span>
                <Select label={`${g.origin} ${PERMISSION_KINDS[p.kind] ?? p.kind}`} value={p.decision} onChange={(d) => decide(p, d)} options={DECISIONS} />
                <button
                  type="button"
                  disabled={Boolean(saving[`${p.origin}\n${p.kind}`])}
                  data-forget-permission
                  aria-label={`Forget ${g.origin} ${PERMISSION_KINDS[p.kind] ?? p.kind}`}
                  title="Forget"
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
      </div>
    </Group>
  );
}

function ClearData() {
  const [what, setWhat] = useState({ history: true, cookies: false, cache: false, site_data: false, forms: false });
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nothing = !what.history && !what.cookies && !what.cache && !what.site_data && !what.forms;
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
    <Group id="clear-browsing-data" title="Clear browsing data" description="Open profiles clear immediately. Restart Dive after clearing cookies, cache, or site data to finish closed profiles and every stored origin.">
      <div className="flex flex-col gap-2 py-3">
        <Check label="Browsing history in this profile" checked={what.history} onChange={(history) => setWhat({ ...what, history })} />
        <Check label="Cookies and signed-in sessions" checked={what.cookies} onChange={(cookies) => setWhat({ ...what, cookies })} />
        <Check label="Cached files" checked={what.cache} onChange={(cache) => setWhat({ ...what, cache })} />
        <Check label="Site data (local storage, IndexedDB)" checked={what.site_data} onChange={(site_data) => setWhat({ ...what, site_data })} />
        <Check label="Form entries in this profile" checked={what.forms} onChange={(forms) => setWhat({ ...what, forms })} />
        <p className="text-[10.5px] text-ink-3">Saved passwords are not touched here; manage them under Passwords &amp; forms.</p>
        <div className="mt-1 flex items-center gap-3">
          <Button variant="danger" onClick={clear} disabled={busy || nothing}>
            {busy ? "Clearing…" : "Clear now"}
          </Button>
          {result && (
            <><span role="status" className="text-[11px] text-ink-2">{result}</span>{/restart dive/i.test(result) && <Button onClick={() => ipc.appRestart()}>Restart now</Button>}</>
          )}
        </div>
      </div>
    </Group>
  );
}
