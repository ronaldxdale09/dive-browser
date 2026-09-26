import { Copy, Eye, EyeOff, FileDown, FileUp, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "../../lib/ipc";
import type { Credential, CsvImportSummary, PasswordExport } from "../../lib/ipc";
import { errorMessage } from "../../lib/errors";
import { useBrowser } from "../../store/browser";
import { Icon, IconButton } from "../Icon";
import { Button, Group } from "../SettingsFields";
import { FormEntries } from "./FormEntries";
import { credentialStoreName, importPasswordsHint } from "../../lib/commands";

/** How long a shown password stays on screen before it hides itself. */
export const REVEAL_MS = 30_000;

/** Above this many logins the list renders only the rows in view. */
export const VIRTUAL_ABOVE = 100;

/** The site as the list shows it: the host, without the scheme. */
export function siteLabel(origin: string): string {
  return origin.replace(/^https?:\/\//, "");
}

/** Logins in the order the list shows them: by the host shown, then username. */
export function sortLogins(list: Credential[]): Credential[] {
  return [...list].sort(
    (a, b) =>
      siteLabel(a.origin).localeCompare(siteLabel(b.origin)) ||
      a.origin.localeCompare(b.origin) ||
      a.username.localeCompare(b.username, undefined, { sensitivity: "base" }),
  );
}

/** Logins whose shown site or username contains `query`, ignoring case. */
export function filterLogins(list: Credential[], query: string): Credential[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((c) => siteLabel(c.origin).toLowerCase().includes(q) || c.username.toLowerCase().includes(q));
}

/** "Imported 12 logins, 3 already here, 1 unreadable" for the notice. */
export function describeCsvImport(s: CsvImportSummary): string {
  const parts = [`Imported ${s.added} ${s.added === 1 ? "login" : "logins"}`];
  if (s.skipped) parts.push(`${s.skipped} already here`);
  if (s.unreadable) parts.push(`${s.unreadable} unreadable`);
  if (s.failed) parts.push(`${s.failed} not saved`);
  return parts.join(", ");
}

/** "Exported 12 logins to …" for the notice, with any the OS kept back. */
export function describeExport(e: PasswordExport): string {
  const text = `Exported ${e.exported} ${e.exported === 1 ? "login" : "logins"} to ${e.path}`;
  return e.failed ? `${text}. ${e.failed} could not be read from ${credentialStoreName()} and were left out.` : text;
}

/**
 * Settings › Passwords: every login saved in this profile, with the
 * password hidden until asked for. Adding one here is for logins Dive has
 * not seen submitted yet; the save prompt on a page is the usual way in.
 *
 * Showing, copying or exporting a password asks the OS to confirm the owner
 * is at the keyboard first (Touch ID or the login password on a Mac), so an
 * unlocked, unattended machine does not hand every saved password over.
 */
export function Passwords() {
  const [items, setItems] = useState<Credential[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState("");
  const notify = (text: string, ms = 3000) => useBrowser.getState().notify(text, ms);
  const importCsv = async () => {
    setImporting(true);
    try {
      const path = await ipc.passwordsPickCsv();
      if (!path) return;
      const summary = await ipc.passwordsImportCsv(path);
      notify(describeCsvImport(summary));
      if (summary.failed && summary.failure) setError(`Some logins were not saved: ${summary.failure}`);
      load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setImporting(false);
    }
  };
  const load = () => {
    ipc
      .passwordsList()
      .then((list) => {
        setItems(list);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  };
  useEffect(load, []);

  const remove = async (c: Credential) => {
    try {
      await ipc.passwordsDelete(c.id);
      setItems((list) => (list ?? []).filter((x) => x.id !== c.id));
      notify(`Forgot the login for ${siteLabel(c.origin)}`);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const replaceRow = (c: Credential) => setItems((list) => sortLogins([...(list ?? []).filter((x) => x.id !== c.id), c]));
  const shown = useMemo(() => filterLogins(items ?? [], query), [items, query]);

  return (
    <>
      <Group title="Saved logins" description={`Kept in this profile. Passwords live in ${credentialStoreName()}; Dive never writes them to its own files. Showing or copying one asks your computer to confirm it is you.`}>
        {error && (
          <p role="alert" className="mt-2 mb-2 text-[11px] text-danger">
            {error}
          </p>
        )}
        {items === null && !error && <p className="py-2 text-[11px] text-ink-3">Loading…</p>}
        {items?.length === 0 && !adding && (
          <p className="py-2 text-[11px] text-ink-3">No logins saved yet. Dive offers to save one when you sign in to a site, or add one below.</p>
        )}
        {items && items.length > 0 && (
          <>
            <label className="mt-2.5 flex h-8 items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 focus-within:border-highlight/60">
              <Icon icon={Search} size={12} className="shrink-0 text-ink-3" />
              <input
                type="search"
                aria-label="Filter saved logins"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // Escape with a filter typed clears it rather than closing
                  // Settings, the way a field with an edit takes it back.
                  if (e.key === "Escape" && query) {
                    e.stopPropagation();
                    setQuery("");
                  }
                }}
                placeholder="Filter by site or username"
                spellCheck={false}
                autoComplete="off"
                className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-3"
              />
            </label>
            {shown.length === 0 ? (
              <p className="py-2.5 text-[11px] text-ink-3">No saved login matches “{query.trim()}”.</p>
            ) : (
              <LoginList logins={shown} onRemove={(c) => void remove(c)} onEdited={replaceRow} onError={setError} />
            )}
          </>
        )}
        <div className="my-3">
          {adding ? (
            <AddLogin
              onSaved={(c, replaced) => {
                replaceRow(c);
                setAdding(false);
                notify(replaced ? `Replaced the saved password for ${siteLabel(c.origin)}` : `Saved the login for ${siteLabel(c.origin)}`);
              }}
              onCancel={() => setAdding(false)}
              onError={setError}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => setAdding(true)}>
                <span className="inline-flex items-center gap-1.5">
                  <Icon icon={Plus} size={12} /> Add login
                </span>
              </Button>
            </div>
          )}
        </div>
      </Group>
      <NeverSaved />
      <FormEntries />
      <Group title="Bringing passwords over" description={importPasswordsHint()}>
        <div className="flex flex-wrap items-center gap-2 py-2.5">
          <Button onClick={() => void importCsv()} disabled={importing}>
            <span className="inline-flex items-center gap-1.5">
              <Icon icon={FileUp} size={12} /> {importing ? "Importing…" : "Import a CSV export…"}
            </span>
          </Button>
        </div>
        {items && items.length > 0 && <ExportPasswords onError={setError} />}
      </Group>
    </>
  );
}

/**
 * Export every login to a CSV in Chrome's columns. The file holds the
 * passwords in plain text, so the button first says so and asks again;
 * the host then asks the OS to confirm the owner before the save dialog.
 */
function ExportPasswords({ onError }: { onError: (message: string) => void }) {
  const [warning, setWarning] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const done = await ipc.passwordsExport();
      setWarning(false);
      if (done) useBrowser.getState().notify(describeExport(done), 6000);
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (!warning) {
    return (
      <div className="border-t border-line/60 py-2.5">
        <Button onClick={() => setWarning(true)}>
          <span className="inline-flex items-center gap-1.5">
            <Icon icon={FileDown} size={12} /> Export passwords…
          </span>
        </Button>
      </div>
    );
  }
  return (
    <div role="group" aria-label="Export passwords" className="border-t border-line/60 py-2.5">
      <p className="mb-2 text-[11px] text-warn">
        The file will hold every saved password in plain text, readable by anyone and any app that can open it. Import it where you need it, then delete it.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setWarning(false)}>Cancel</Button>
        <Button variant="danger" onClick={() => void run()} disabled={busy}>
          {busy ? "Exporting…" : "Export as CSV…"}
        </Button>
      </div>
    </div>
  );
}

/** The saved logins, windowed once there are enough to slow the page down. */
function LoginList({ logins, onRemove, onEdited, onError }: { logins: Credential[]; onRemove: (c: Credential) => void; onEdited: (c: Credential) => void; onError: (message: string) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: logins.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 48,
    overscan: 8,
    getItemKey: (i) => logins[i]?.id ?? i,
  });
  const many = logins.length > VIRTUAL_ABOVE;
  const virtualItems = many ? virtualizer.getVirtualItems() : [];
  const row = (c: Credential, place?: RowPlacement) => <LoginRow key={c.id} credential={c} place={place} onRemove={() => onRemove(c)} onEdited={onEdited} onError={onError} />;

  // Without layout (and so with nothing measured) the window is empty; the
  // plain list is right then, and for any list short enough not to need it.
  if (!many || virtualItems.length === 0) {
    return (
      <div ref={scrollRef} className={many ? "max-h-[28rem] overflow-y-auto" : undefined}>
        <ul className="divide-y divide-line/60">{logins.map((c) => row(c))}</ul>
      </div>
    );
  }
  return (
    <div ref={scrollRef} className="max-h-[28rem] overflow-y-auto">
      <ul className="relative" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualItems.map((item) => {
          const c = logins[item.index];
          return c ? row(c, { index: item.index, start: item.start, measure: virtualizer.measureElement }) : null;
        })}
      </ul>
    </div>
  );
}

/** Where a row sits in a windowed list; rows of a plain list flow instead. */
interface RowPlacement {
  index: number;
  start: number;
  measure: (el: Element | null) => void;
}

/** Sites this profile refused a save for, each one undoable. */
function NeverSaved() {
  const [sites, setSites] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    ipc
      .passwordsNeverList()
      .then(setSites)
      .catch((e) => setError(errorMessage(e)));
  }, []);
  const allow = async (origin: string) => {
    try {
      await ipc.passwordsNeverRemove(origin);
      setSites((list) => (list ?? []).filter((o) => o !== origin));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  if (!sites?.length && !error) return null;
  return (
    <Group title="Never saved" description="Sites where you chose Never for this site. Dive fills what it already knows there but does not offer to save.">
      {error && (
        <p role="alert" className="py-2 text-[11px] text-danger">
          {error}
        </p>
      )}
      <ul className="divide-y divide-line/60">
        {(sites ?? []).map((origin) => (
          <li key={origin} className="flex items-center gap-2 py-2">
            <span className="min-w-0 flex-1 truncate text-xs text-ink">{siteLabel(origin)}</span>
            <Button onClick={() => void allow(origin)}>Ask again</Button>
          </li>
        ))}
      </ul>
    </Group>
  );
}

/**
 * A password on screen, until it hides itself: after {@link REVEAL_MS}, or
 * as soon as the window loses focus, so one left showing does not stay
 * readable to whoever walks up to the screen next.
 */
function useRevealed(): [string | null, (secret: string | null) => void] {
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (shown === null) return;
    const hide = () => setShown(null);
    const timer = window.setTimeout(hide, REVEAL_MS);
    const hidden = () => document.visibilityState === "hidden" && hide();
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [shown]);
  return [shown, setShown];
}

function LoginRow({ credential: c, place, onRemove, onEdited, onError }: { credential: Credential; place?: RowPlacement | undefined; onRemove: () => void; onEdited: (c: Credential) => void; onError: (message: string) => void }) {
  const [shown, setShown] = useRevealed();
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const reveal = async () => {
    if (shown !== null) {
      setShown(null);
      return;
    }
    try {
      // Null is the person cancelling the OS check: nothing to say.
      const secret = await ipc.passwordsReveal(c.id);
      if (secret !== null) setShown(secret);
    } catch (e) {
      onError(errorMessage(e));
    }
  };
  const copy = async () => {
    try {
      if (await ipc.passwordsCopy(c.id)) useBrowser.getState().notify("Password copied. It clears from the clipboard in 30 seconds.", 3000);
    } catch (e) {
      onError(errorMessage(e));
    }
  };
  const placed = place
    ? { "data-index": place.index, ref: place.measure, style: { transform: `translateY(${place.start}px)` } }
    : {};
  const positioned = place ? "absolute top-0 left-0 w-full border-b border-line/60" : "";
  if (editing) {
    return (
      <li {...placed} className={`py-2 ${positioned}`}>
        <EditLogin
          credential={c}
          onSaved={(updated) => {
            setEditing(false);
            setShown(null);
            onEdited(updated);
            useBrowser.getState().notify(`Updated the login for ${siteLabel(c.origin)}`, 3000);
          }}
          onCancel={() => setEditing(false)}
          onError={onError}
        />
      </li>
    );
  }
  return (
    <li {...placed} className={`flex items-center gap-3 py-2 ${positioned}`}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-ink">{siteLabel(c.origin)}</div>
        <div className="truncate text-[11px] text-ink-3">
          {c.username}
          <span className="mx-1.5">·</span>
          <span className="font-mono" aria-label={shown === null ? "Password hidden" : "Password"}>
            {shown ?? "••••••••"}
          </span>
        </div>
      </div>
      {confirming ? (
        <>
          <span className="shrink-0 text-[11px] text-ink-2">Forget this login?</span>
          <button type="button" onClick={() => setConfirming(false)} className="h-7 shrink-0 rounded-full px-2.5 text-[11px] text-ink-2 hover:bg-surface-3 hover:text-ink">
            Keep
          </button>
          <button type="button" aria-label={`Forget login for ${c.username} on ${siteLabel(c.origin)} for good`} onClick={onRemove} className="h-7 shrink-0 rounded-full bg-danger px-2.5 text-[11px] font-medium text-danger-ink hover:brightness-110">
            Forget
          </button>
        </>
      ) : (
        <>
          <IconButton icon={shown === null ? Eye : EyeOff} label={shown === null ? `Show password for ${c.username}` : `Hide password for ${c.username}`} size={13} onClick={() => void reveal()} />
          <IconButton icon={Copy} label={`Copy password for ${c.username}`} size={13} onClick={() => void copy()} />
          <IconButton icon={Pencil} label={`Edit login for ${c.username} on ${siteLabel(c.origin)}`} size={13} onClick={() => setEditing(true)} />
          <IconButton icon={Trash2} label={`Forget login for ${c.username} on ${siteLabel(c.origin)}`} size={13} onClick={() => setConfirming(true)} />
        </>
      )}
    </li>
  );
}

const field = "h-8 w-full rounded-lg border border-line bg-surface-2 px-2.5 text-xs text-ink outline-none placeholder:text-ink-3 focus:border-highlight/60";

/**
 * Escape inside a small inline form: a field with something typed in it is
 * cleared first, and an empty one closes the form. Either way the key stops
 * here -- Settings closes on an Escape that reaches it, which used to throw
 * away the whole form along with Settings. `fields` maps each input's name
 * to its value and setter.
 */
function escapeClears(onCancel: () => void, fields: Record<string, readonly [string, (value: string) => void]>) {
  return (e: React.KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    const name = e.target instanceof HTMLInputElement ? e.target.name : "";
    const typed = fields[name];
    if (typed && typed[0]) typed[1]("");
    else onCancel();
  };
}

function EditLogin({ credential: c, onSaved, onCancel, onError }: { credential: Credential; onSaved: (c: Credential) => void; onCancel: () => void; onError: (message: string) => void }) {
  const [username, setUsername] = useState(c.username);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      onSaved(await ipc.passwordsEdit(c.id, username.trim(), password));
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const unchanged = username.trim() === c.username && !password;
  return (
    <form onSubmit={(e) => void submit(e)} onKeyDown={escapeClears(onCancel, { username: [username, setUsername], password: [password, setPassword] })} className="grid gap-2 rounded-xl border border-line bg-surface-2/50 p-3" aria-label={`Edit login for ${siteLabel(c.origin)}`}>
      <div className="truncate text-xs text-ink">{siteLabel(c.origin)}</div>
      <input name="username" aria-label="Username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username or email" spellCheck={false} autoComplete="off" className={field} />
      <input name="password" aria-label="New password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password (leave empty to keep the saved one)" autoComplete="new-password" className={field} />
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <button type="submit" disabled={busy || !username.trim() || unchanged} className="h-8 shrink-0 rounded-full bg-accent px-3.5 text-xs text-accent-ink hover:opacity-90 disabled:opacity-40">
          Save changes
        </button>
      </div>
    </form>
  );
}

function AddLogin({ onSaved, onCancel, onError }: { onSaved: (c: Credential, replaced: boolean) => void; onCancel: () => void; onError: (message: string) => void }) {
  const [site, setSite] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // The site already has a password for this username: asked before it is
  // written over, since saving here used to replace it without a word.
  const [existing, setExisting] = useState<string | null>(null);
  const save = async (replace: boolean) => {
    setBusy(true);
    try {
      const result = await ipc.passwordsSave(site.trim(), username, password, replace);
      if (result.kind === "exists") setExisting(result.origin);
      else onSaved(result.credential, result.replaced);
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void save(existing !== null);
  };
  const change = (set: (value: string) => void) => (value: string) => {
    set(value);
    setExisting(null);
  };
  const edit = (set: (value: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => change(set)(e.target.value);
  const fields = { site: [site, change(setSite)], username: [username, change(setUsername)], password: [password, change(setPassword)] } as const;
  return (
    <form onSubmit={submit} onKeyDown={escapeClears(onCancel, fields)} className="grid gap-2 rounded-xl border border-line bg-surface-2/50 p-3" aria-label="Add login">
      <input name="site" aria-label="Site" value={site} onChange={edit(setSite)} placeholder="Site, like github.com or localhost:3000" spellCheck={false} autoComplete="off" className={field} />
      <input name="username" aria-label="Username" value={username} onChange={edit(setUsername)} placeholder="Username or email" spellCheck={false} autoComplete="off" className={field} />
      <input name="password" aria-label="Password" type="password" value={password} onChange={edit(setPassword)} placeholder="Password" autoComplete="new-password" className={field} />
      {existing !== null && (
        <p role="alert" className="text-[11px] text-warn">
          {siteLabel(existing)} already has a saved password for {username.trim()}. Replace the saved password?
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <button type="submit" disabled={busy || !site.trim() || !username.trim() || !password} className="h-8 shrink-0 rounded-full bg-accent px-3.5 text-xs text-accent-ink hover:opacity-90 disabled:opacity-40">
          {existing !== null ? "Replace password" : "Save login"}
        </button>
      </div>
    </form>
  );
}
