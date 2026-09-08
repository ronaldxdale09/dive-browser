import { Copy, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ipc } from "../../lib/ipc";
import type { Credential } from "../../lib/ipc";
import { errorMessage } from "../../lib/errors";
import { useBrowser } from "../../store/browser";
import { Icon, IconButton } from "../Icon";
import { Button, Group } from "../SettingsFields";

/** The site as the list shows it: the host, without the scheme. */
export function siteLabel(origin: string): string {
  return origin.replace(/^https?:\/\//, "");
}

/**
 * Settings › Passwords: every login saved in this profile, with the
 * password hidden until asked for. Adding one here is for logins Dive has
 * not seen submitted yet; the save prompt on a page is the usual way in.
 */
export function Passwords() {
  const [items, setItems] = useState<Credential[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const notify = (text: string) => useBrowser.getState().notify(text, 3000);
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

  return (
    <>
      <Group title="Saved logins" description="Kept in this profile. Passwords live in the macOS Keychain; Dive never writes them to its own files.">
        {error && (
          <p role="alert" className="mb-2 text-[11px] text-danger">
            {error}
          </p>
        )}
        {items === null && !error && <p className="text-[11px] text-ink-3">Loading…</p>}
        {items?.length === 0 && !adding && (
          <p className="text-[11px] text-ink-3">No logins saved yet. Dive offers to save one when you sign in to a site, or add one below.</p>
        )}
        {items && items.length > 0 && (
          <ul className="divide-y divide-line/60">
            {items.map((c) => (
              <LoginRow key={c.id} credential={c} onRemove={() => void remove(c)} onError={setError} />
            ))}
          </ul>
        )}
        <div className="mt-3">
          {adding ? (
            <AddLogin
              onSaved={(c) => {
                setItems((list) => [...(list ?? []).filter((x) => x.id !== c.id), c].sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username)));
                setAdding(false);
                notify(`Saved the login for ${siteLabel(c.origin)}`);
              }}
              onCancel={() => setAdding(false)}
              onError={setError}
            />
          ) : (
            <Button onClick={() => setAdding(true)}>
              <span className="inline-flex items-center gap-1.5">
                <Icon icon={Plus} size={12} /> Add login
              </span>
            </Button>
          )}
        </div>
      </Group>
    </>
  );
}

function LoginRow({ credential: c, onRemove, onError }: { credential: Credential; onRemove: () => void; onError: (message: string) => void }) {
  const [shown, setShown] = useState<string | null>(null);
  const reveal = async () => {
    if (shown !== null) {
      setShown(null);
      return;
    }
    try {
      setShown(await ipc.passwordsReveal(c.id));
    } catch (e) {
      onError(errorMessage(e));
    }
  };
  const copy = async () => {
    try {
      const secret = shown ?? (await ipc.passwordsReveal(c.id));
      await navigator.clipboard.writeText(secret);
      useBrowser.getState().notify("Password copied", 2000);
    } catch (e) {
      onError(errorMessage(e));
    }
  };
  return (
    <li className="flex items-center gap-3 py-2">
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
      <IconButton icon={shown === null ? Eye : EyeOff} label={shown === null ? `Show password for ${c.username}` : `Hide password for ${c.username}`} size={13} onClick={() => void reveal()} />
      <IconButton icon={Copy} label={`Copy password for ${c.username}`} size={13} onClick={() => void copy()} />
      <IconButton icon={Trash2} label={`Forget login for ${c.username} on ${siteLabel(c.origin)}`} size={13} onClick={onRemove} />
    </li>
  );
}

function AddLogin({ onSaved, onCancel, onError }: { onSaved: (c: Credential) => void; onCancel: () => void; onError: (message: string) => void }) {
  const [site, setSite] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const field = "h-8 w-full rounded-lg border border-line bg-surface-2 px-2.5 text-xs text-ink outline-none placeholder:text-ink-3 focus:border-highlight/60";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      onSaved(await ipc.passwordsSave(site.trim(), username, password));
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-2 rounded-xl border border-line bg-surface-2/50 p-3" aria-label="Add login">
      <input aria-label="Site" value={site} onChange={(e) => setSite(e.target.value)} placeholder="Site, like github.com" spellCheck={false} autoComplete="off" className={field} />
      <input aria-label="Username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username or email" spellCheck={false} autoComplete="off" className={field} />
      <input aria-label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoComplete="new-password" className={field} />
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <button type="submit" disabled={busy || !site.trim() || !username.trim() || !password} className="h-8 shrink-0 rounded-full bg-accent px-3.5 text-xs text-accent-ink hover:opacity-90 disabled:opacity-40">
          Save login
        </button>
      </div>
    </form>
  );
}
