import { Check, FolderLock, History, KeyRound, Loader2, Star } from "lucide-react";
import { useEffect } from "react";
import type { ImportSource } from "../../lib/ipc";
import { useBrowserImport } from "../../store/browserImport";
import { Icon } from "../Icon";
import { Switch } from "../SettingsFields";
import { BrandLogo } from "../BrandLogo";
import { brandLogo } from "../../lib/brandLogos";

/** Marks come from svgl.app, then the installed app's own icon; these letter tiles are the last resort. */
const MARKS: Record<string, { text: string; color: string }> = {
  chrome: { text: "C", color: "#4285F4" },
  brave: { text: "B", color: "#FB542B" },
  edge: { text: "E", color: "#0F8DD8" },
  arc: { text: "A", color: "#FF536A" },
  vivaldi: { text: "V", color: "#EF3939" },
  opera: { text: "O", color: "#FF1B2D" },
  chromium: { text: "Cr", color: "#5B8BD9" },
  firefox: { text: "F", color: "#FF7139" },
  safari: { text: "S", color: "#0A84FF" },
};

/** "1,240 bookmarks and 38,120 pages", or what was asked for. */
export function describeOutcome(bookmarks: number, history: number, askedBookmarks: boolean, askedHistory: boolean, passwords = 0, askedPasswords = false): string {
  const parts: string[] = [];
  if (askedBookmarks) parts.push(`${bookmarks.toLocaleString()} ${bookmarks === 1 ? "bookmark" : "bookmarks"}`);
  if (askedHistory) parts.push(`${history.toLocaleString()} ${history === 1 ? "page of history" : "pages of history"}`);
  if (askedPasswords) parts.push(`${passwords.toLocaleString()} ${passwords === 1 ? "password" : "passwords"}`);
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Pick a browser profile, choose bookmarks and history, import. Shared by
 * the onboarding step and the dialog, so both say the same things. It
 * loads the list on mount; `prefer` chooses the row to start on.
 */
export function ImportPanel({ prefer, compact = false }: { prefer?: string | null | undefined; compact?: boolean }) {
  const sources = useBrowserImport((s) => s.sources);
  const loading = useBrowserImport((s) => s.loading);
  const selected = useBrowserImport((s) => s.selected);
  const bookmarks = useBrowserImport((s) => s.bookmarks);
  const history = useBrowserImport((s) => s.history);
  const passwords = useBrowserImport((s) => s.passwords);
  const setPasswords = useBrowserImport((s) => s.setPasswords);
  const importing = useBrowserImport((s) => s.importing);
  const outcome = useBrowserImport((s) => s.outcome);
  const error = useBrowserImport((s) => s.error);
  const load = useBrowserImport((s) => s.load);
  const select = useBrowserImport((s) => s.select);
  const setBookmarks = useBrowserImport((s) => s.setBookmarks);
  const setHistory = useBrowserImport((s) => s.setHistory);
  const openPrivacySettings = useBrowserImport((s) => s.openPrivacySettings);
  const run = useBrowserImport((s) => s.run);

  useEffect(() => {
    void load(prefer ?? undefined);
  }, [load, prefer]);

  // Full Disk Access is granted in System Settings; when the person comes
  // back, look again so the row unlocks without a click.
  useEffect(() => {
    const again = () => void load(prefer ?? undefined);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [load, prefer]);

  const current = sources?.find((s) => s.id === selected) ?? null;
  const canPasswords = current?.passwords === true;
  const ready = current?.access === "ok" && (bookmarks || history || (passwords && canPasswords)) && !importing;

  if (sources === null || (loading && sources.length === 0)) {
    return (
      <p role="status" className="flex items-center gap-2 py-6 text-xs text-ink-3">
        <Icon icon={Loader2} size={13} className="animate-spin" /> Looking for browsers on this Mac…
      </p>
    );
  }
  if (sources.length === 0) {
    return (
      <div className="rounded-2xl border border-line bg-surface-2/60 px-4 py-5 text-center">
        <p className="text-xs font-medium text-ink">No other browsers with data were found</p>
        <p className="mt-1 text-[11px] text-ink-3">Chrome, Brave, Edge, Arc, Vivaldi, Opera, Firefox and Safari are looked for.</p>
      </div>
    );
  }

  return (
    <div>
      <ul role="radiogroup" aria-label="Browsers" className={`grid gap-1.5 ${compact || sources.length < 3 ? "grid-cols-1" : "grid-cols-2"}`}>
        {sources.map((s) => (
          <li key={s.id}>
            <SourceRow source={s} checked={s.id === selected} onPick={() => select(s.id)} />
          </li>
        ))}
      </ul>

      {current?.access === "denied" && (
        <div className="mt-3 rounded-xl border border-line bg-surface-2/70 px-3 py-2.5">
          <p className="flex items-start gap-2 text-[11px] leading-snug text-ink-2">
            <Icon icon={FolderLock} size={13} className="mt-0.5 shrink-0 text-ink-3" />
            <span>
              macOS keeps {current.name}&rsquo;s files private. Switch Dive on under System Settings › Privacy &amp; Security › Full Disk Access, then come back here.
            </span>
          </p>
          <div className="mt-2 flex flex-wrap gap-2 pl-5">
            <button type="button" onClick={() => void openPrivacySettings()} className="pressable h-7 rounded-full bg-accent px-3 text-[11px] font-medium text-accent-ink hover:brightness-110">
              Allow access in System Settings…
            </button>
            <button type="button" disabled={loading} onClick={() => void load(prefer ?? undefined)} className="pressable h-7 rounded-full border border-line-2 px-3 text-[11px] text-ink-2 hover:bg-surface-3 hover:text-ink disabled:opacity-40">
              {loading ? "Checking…" : "Check again"}
            </button>
          </div>
          <p className="mt-2 pl-5 text-[10.5px] text-ink-3">If it still says so after switching Dive on, quit and reopen Dive once.</p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-xs text-ink">
          <Switch label="Bookmarks" checked={bookmarks} onChange={setBookmarks} />
          <Icon icon={Star} size={12} className="text-ink-3" /> Bookmarks
        </label>
        <label className="flex items-center gap-2 text-xs text-ink">
          <Switch label="History" checked={history} onChange={setHistory} />
          <Icon icon={History} size={12} className="text-ink-3" /> History
        </label>
        {canPasswords && (
          <label className="flex items-center gap-2 text-xs text-ink">
            <Switch label="Passwords" checked={passwords} onChange={setPasswords} />
            <Icon icon={KeyRound} size={12} className="text-ink-3" /> Passwords
          </label>
        )}
        <span className="flex-1" />
        <button type="button" disabled={!ready} onClick={() => void run()} className="pressable h-8 shrink-0 rounded-full bg-accent px-4 text-xs font-medium whitespace-nowrap text-accent-ink hover:brightness-110 disabled:opacity-40">
          {importing ? (
            <span className="inline-flex items-center gap-1.5">
              <Icon icon={Loader2} size={12} className="animate-spin" /> Importing…
            </span>
          ) : (
            `Import from ${current?.name ?? "browser"}`
          )}
        </button>
      </div>

      {outcome && (
        <p role="status" className="mt-3 flex items-center gap-1.5 text-[11px] text-ink-2">
          <Icon icon={Check} size={12} className="text-highlight" />
          {outcome.summary.bookmarks + outcome.summary.history + outcome.summary.passwords === 0
            ? `Nothing new from ${outcome.source.name}: everything there was already here.`
            : `Brought in ${describeOutcome(outcome.summary.bookmarks, outcome.summary.history, bookmarks, history, outcome.summary.passwords, passwords && outcome.source.passwords)} from ${outcome.source.name}. Anything already here was kept.`}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-[11px] text-danger">
          {error}
        </p>
      )}
      <p className="mt-3 text-[10.5px] text-ink-3">
        {canPasswords && passwords
          ? current?.family === "firefox"
            ? "Passwords go into this profile's Keychain. Firefox logins guarded by a primary password cannot be read; export them as a CSV from about:logins instead. Cookies and extensions stay behind."
            : `Passwords go into this profile's Keychain; macOS will ask once to let Dive read ${current?.name ?? "the browser"}'s password key. Cookies and extensions stay behind.`
          : "Cookies and extensions stay in the other browser."}
      </p>
    </div>
  );
}

function SourceRow({ source, checked, onPick }: { source: ImportSource; checked: boolean; onPick: () => void }) {
  const mark = MARKS[source.browser] ?? { text: source.name.slice(0, 1), color: "#888" };
  const label = source.profile ? `${source.name} · ${source.profile}` : source.name;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={label}
      onClick={onPick}
      className={`flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-colors ${checked ? "border-highlight bg-highlight-soft/40" : "border-line bg-surface-2/50 hover:bg-surface-2"}`}
    >
      {brandLogo(source.browser) ? (
        <BrandLogo id={source.browser} size={26} className="mx-px" />
      ) : source.icon ? (
        <img src={source.icon} alt="" width={28} height={28} className="size-7 shrink-0" />
      ) : (
        <span className="grid size-7 shrink-0 place-items-center rounded-lg text-[11px] font-semibold text-white" style={{ background: mark.color }} aria-hidden>
          {mark.text}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-ink">{label}</span>
        <span className="block truncate text-[10.5px] text-ink-3">
          {source.access === "ok" ? "Bookmarks and history" : source.access === "denied" ? "Needs your permission" : "Nothing to import"}
        </span>
      </span>
      {source.access === "denied" && <Icon icon={FolderLock} size={13} className="shrink-0 text-ink-3" />}
      {checked && <Icon icon={Check} size={13} className="shrink-0 text-highlight" />}
    </button>
  );
}
