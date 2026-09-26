import { X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ipc } from "../../lib/ipc";
import type { ClearOutcome, Decision, PermissionList, SitePermission } from "../../lib/ipc";
import { dnsTemplateProblem, ignoredBypass, pacProblem, proxyServerProblem } from "../../lib/netconfig";
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

/**
 * The retention choices, with the one in force added when it is not a
 * listed one (set in an older build or by a restored backup): without it the
 * control read "Choose…" as if nothing were set.
 */
export function retentionOptions(days: number): { value: string; label: string }[] {
  if (RETENTION.some((o) => o.value === String(days))) return RETENTION;
  return [...RETENTION, { value: String(days), label: `Custom (${days} ${days === 1 ? "day" : "days"})` }];
}

/** "Delete 1,204 visits older than 30 days?" */
export function pruneQuestion(count: number, days: number): string {
  return `Delete ${count.toLocaleString()} ${count === 1 ? "visit" : "visits"} older than ${days} ${days === 1 ? "day" : "days"}?`;
}

/** Whether moving the window from `from` to `to` days drops anything kept now. */
export function shortensRetention(from: number, to: number): boolean {
  return to > 0 && (from <= 0 || to < from);
}

/** Settings › Privacy: DivePrivacy, request policy, history, clearing and site permissions. */
/** "Personal · Client work", or just "Personal" when the container carries the profile's own name. */
export function scopeLabel(profile: string, container: string): string {
  return container && container !== profile ? `${profile} · ${container}` : profile;
}

export function Privacy() {
  const [prefs, set] = usePref();
  const privacyInfo = usePrivacy((s) => s.info);
  // Whether the network settings on screen are the ones the engine runs
  // with. Asked after each save lands, since only then does the host have
  // the new ones to compare.
  const [restartNeeded, setRestartNeeded] = useState(false);
  const checkNetwork = useCallback(() => {
    void ipc.networkRestartNeeded().then(setRestartNeeded, () => undefined);
  }, []);
  useEffect(checkNetwork, [checkNetwork]);
  const setNetwork = (patch: Parameters<typeof set>[0]) => set(patch).finally(checkNetwork);
  const dnsProblem = prefs.dns_mode !== "system" && prefs.dns_provider === "custom" ? dnsTemplateProblem(prefs.dns_template) : null;
  const proxyProblem = prefs.proxy_mode === "manual" ? proxyServerProblem(prefs.proxy_server) : null;
  const bypassDropped = prefs.proxy_mode === "manual" ? ignoredBypass(prefs.proxy_bypass) : [];
  const pacIssue = prefs.proxy_mode === "pac" ? pacProblem(prefs.proxy_pac_url) : null;
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
        {restartNeeded && (
          <div role="status" className="flex items-center gap-3 border-b border-line py-3 text-xs text-warn">
            <span className="min-w-0 flex-1">These settings are saved but not in force yet. Dive is still using the ones it started with.</span>
            <Button onClick={() => void ipc.appRestart()}>Restart now</Button>
          </div>
        )}
        <Row
          label="Secure DNS"
          htmlFor="pref-dns-mode"
          hint="Encrypts the lookups that turn an address into a server, so the network you are on cannot read or rewrite them. Automatic falls back to the system resolver when encryption is unavailable; Secure refuses to, which is the point of choosing it."
          control={
            <Select
              id="pref-dns-mode"
              label="Secure DNS"
              value={prefs.dns_mode}
              onChange={(dns_mode) => setNetwork({ dns_mode })}
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
                onChange={(dns_provider) => setNetwork({ dns_provider })}
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
            hint={
              dnsProblem ? (
                <span id="pref-dns-template-problem" className="text-warn">{dnsProblem}</span>
              ) : (
                "The DoH template, over https. An address that is not encrypted is ignored rather than used — that would be the opposite of this setting."
              )
            }
            control={
              <TextInput
                id="pref-dns-template"
                mono
                label="Resolver address"
                value={prefs.dns_template}
                placeholder="https://dns.example.com/dns-query"
                invalid={dnsProblem !== null}
                {...(dnsProblem ? { describedBy: "pref-dns-template-problem" } : {})}
                onCommit={(dns_template) => setNetwork({ dns_template })}
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
              onChange={(proxy_mode) => setNetwork({ proxy_mode })}
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
            hint={
              proxyProblem ? (
                <span id="pref-proxy-server-problem" className="text-warn">{proxyProblem}</span>
              ) : (
                "host:port, or a scheme and address such as socks5://10.0.0.2:1080."
              )
            }
            control={
              <TextInput
                id="pref-proxy-server"
                mono
                label="Proxy address"
                value={prefs.proxy_server}
                placeholder="10.0.0.2:8080"
                invalid={proxyProblem !== null}
                {...(proxyProblem ? { describedBy: "pref-proxy-server-problem" } : {})}
                onCommit={(proxy_server) => setNetwork({ proxy_server })}
              />
            }
          />
        )}
        {prefs.proxy_mode === "manual" && (
          <Row
            stacked
            label="Skip the proxy for"
            htmlFor="pref-proxy-bypass"
            hint={
              bypassDropped.length > 0 ? (
                <span id="pref-proxy-bypass-problem" className="text-warn">
                  Ignored, since they are not host names or addresses: {bypassDropped.join(", ")}
                </span>
              ) : (
                "Comma separated. Your local servers belong here."
              )
            }
            control={
              <TextInput
                id="pref-proxy-bypass"
                mono
                label="Skip the proxy for"
                value={prefs.proxy_bypass}
                placeholder="localhost, 127.0.0.1, *.internal"
                invalid={bypassDropped.length > 0}
                {...(bypassDropped.length > 0 ? { describedBy: "pref-proxy-bypass-problem" } : {})}
                onCommit={(proxy_bypass) => setNetwork({ proxy_bypass })}
              />
            }
          />
        )}
        {prefs.proxy_mode === "pac" && (
          <Row
            stacked
            label="PAC script"
            htmlFor="pref-proxy-pac"
            hint={
              pacIssue ? (
                <span id="pref-proxy-pac-problem" className="text-warn">{pacIssue}</span>
              ) : (
                "The address of the script that decides which proxy to use."
              )
            }
            control={
              <TextInput
                id="pref-proxy-pac"
                mono
                label="PAC script"
                value={prefs.proxy_pac_url}
                placeholder="http://wpad/proxy.pac"
                invalid={pacIssue !== null}
                {...(pacIssue ? { describedBy: "pref-proxy-pac-problem" } : {})}
                onCommit={(proxy_pac_url) => setNetwork({ proxy_pac_url })}
              />
            }
          />
        )}
      </Group>

      <HistoryRetention days={prefs.history_days} onChange={(history_days) => void set({ history_days })} />

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

/**
 * How long history is kept. Shortening the window deletes what falls outside
 * it the moment it is saved, so a shorter choice first says how many visits
 * that is and waits for a yes.
 */
function HistoryRetention({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  const [pending, setPending] = useState<{ days: number; count: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choose = async (next: number) => {
    setError(null);
    setPending(null);
    if (!shortensRetention(days, next)) {
      onChange(next);
      return;
    }
    try {
      const count = await ipc.historyPruneCount(next);
      if (count === 0) onChange(next);
      else setPending({ days: next, count });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Group title="History">
      <Row
        label="Keep history for"
        htmlFor="pref-history"
        hint="Older visits are dropped from history, the address bar and the palette."
        control={
          <Select
            id="pref-history"
            label="Keep history for"
            value={String(pending?.days ?? days)}
            onChange={(next) => void choose(Number(next))}
            options={retentionOptions(pending?.days ?? days)}
          />
        }
      />
      {pending && (
        <div role="alert" className="flex flex-wrap items-center gap-3 border-t border-line py-3 text-xs">
          <span className="min-w-0 flex-1 text-ink">{pruneQuestion(pending.count, pending.days)} This cannot be undone.</span>
          <Button onClick={() => setPending(null)}>Keep them</Button>
          <Button
            variant="danger"
            onClick={() => {
              onChange(pending.days);
              setPending(null);
            }}
          >
            Delete
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="border-t border-line py-3 text-xs text-danger">
          {error}
        </p>
      )}
    </Group>
  );
}

/** The time ranges Clear browsing data offers, in hours; "all" is everything. */
export const CLEAR_RANGES = [
  { value: "1", label: "The last hour" },
  { value: "24", label: "The last day" },
  { value: "168", label: "The last week" },
  { value: "672", label: "The last four weeks" },
  { value: "all", label: "All time" },
] as const;

type ClearWhat = { history: boolean; cookies: boolean; cache: boolean; site_data: boolean; forms: boolean };

/** "history, cookies and cache" -- what is about to go, for the confirmation. */
export function clearList(what: ClearWhat): string {
  const names = [
    what.history && "browsing and download history",
    what.cookies && "cookies",
    what.cache && "cached files",
    what.site_data && "site data",
    what.forms && "form entries",
  ].filter((n): n is string => Boolean(n));
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function ClearData() {
  const [what, setWhat] = useState<ClearWhat>({ history: true, cookies: false, cache: false, site_data: false, forms: false });
  const [range, setRange] = useState<(typeof CLEAR_RANGES)[number]["value"]>("all");
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ClearOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nothing = !what.history && !what.cookies && !what.cache && !what.site_data && !what.forms;
  const ranged = what.history || what.forms;
  const whole = what.cookies || what.cache || what.site_data;
  const rangeLabel = CLEAR_RANGES.find((r) => r.value === range)?.label.toLowerCase() ?? "all time";
  const pick = (patch: Partial<ClearWhat>) => {
    setWhat({ ...what, ...patch });
    setConfirming(false);
  };
  const clear = () => {
    setBusy(true);
    setResult(null);
    setError(null);
    setConfirming(false);
    void ipc
      .browsingDataClear({ ...what, since_hours: range === "all" ? null : Number(range) })
      .then(setResult)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Group
      id="clear-browsing-data"
      title="Clear browsing data"
      description="Open profiles clear immediately. Cookies, cache and site data in profiles that are not open go when Dive next starts."
    >
      <div className="flex flex-col gap-2 py-3">
        <label className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
          Time range
          <Select
            label="Time range"
            value={range}
            onChange={(next) => {
              setRange(next);
              setConfirming(false);
            }}
            options={CLEAR_RANGES}
          />
        </label>
        <Check label="Browsing and download history in this profile" checked={what.history} onChange={(history) => pick({ history })} />
        <Check label="Cookies and signed-in sessions" checked={what.cookies} onChange={(cookies) => pick({ cookies })} />
        <Check label="Cached files" checked={what.cache} onChange={(cache) => pick({ cache })} />
        <Check label="Site data (local storage, IndexedDB) — sites open now at once, the rest when Dive restarts" checked={what.site_data} onChange={(site_data) => pick({ site_data })} />
        <Check label="Form entries in this profile" checked={what.forms} onChange={(forms) => pick({ forms })} />
        <p className="text-[10.5px] text-ink-3">
          The time range applies to history, downloads and form entries. Cookies, cached files and site data have no dates Chromium can clear by, so they are always cleared in full. Saved passwords are not touched here; manage them under Passwords &amp; forms.
        </p>
        {confirming ? (
          <div role="alert" className="mt-1 flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1 text-xs text-ink">
              Clear {clearList(what)}
              {ranged ? ` from ${rangeLabel}` : ""}
              {ranged && whole && range !== "all" ? " (cookies, cache and site data: all time)" : ""}? This cannot be undone.
            </span>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="danger" onClick={clear}>
              Clear
            </Button>
          </div>
        ) : (
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <Button variant="danger" onClick={() => setConfirming(true)} disabled={busy || nothing}>
              {busy ? "Clearing…" : "Clear now…"}
            </Button>
            {result && (
              <>
                <span role="status" className="text-[11px] text-ink-2">
                  {result.summary}
                </span>
                {result.restart_needed && <Button onClick={() => void ipc.appRestart()}>Restart now</Button>}
              </>
            )}
          </div>
        )}
        {result && result.failures.length > 0 && (
          <ul role="alert" className="flex flex-col gap-0.5 text-[11px] text-danger">
            {result.failures.map((failure) => (
              <li key={failure}>Not cleared — {failure}</li>
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="text-[11px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Group>
  );
}
