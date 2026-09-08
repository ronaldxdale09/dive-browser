import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ipc } from "../../lib/ipc";
import type { FormEntry } from "../../lib/ipc";
import { errorMessage } from "../../lib/errors";
import { useBrowser } from "../../store/browser";
import { IconButton } from "../Icon";
import { Button, Group } from "../SettingsFields";

/** A field name as the list shows it: `billing_email` → "billing email". */
export function fieldLabel(field: string): string {
  return field.replace(/[_\-.]+/g, " ").trim() || "field";
}

/** Entries grouped by field, in the order the host returns them. */
export function groupByField(entries: FormEntry[]): { field: string; entries: FormEntry[] }[] {
  const groups: { field: string; entries: FormEntry[] }[] = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (last && last.field === e.field) last.entries.push(e);
    else groups.push({ field: e.field, entries: [e] });
  }
  return groups;
}

/**
 * Settings › Passwords › Form entries: what Dive remembers from forms in
 * this profile (names, emails, addresses), imported or typed here, each
 * removable, all clearable.
 */
export function FormEntries() {
  const [items, setItems] = useState<FormEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const notify = (text: string) => useBrowser.getState().notify(text, 3000);
  useEffect(() => {
    ipc
      .formsList()
      .then((list) => {
        setItems(list);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const remove = async (e: FormEntry) => {
    try {
      await ipc.formsDelete(e.id);
      setItems((list) => (list ?? []).filter((x) => x.id !== e.id));
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const clear = async () => {
    try {
      const n = await ipc.formsClear();
      setItems([]);
      setConfirming(false);
      notify(n === 1 ? "Forgot 1 form entry" : `Forgot ${n.toLocaleString()} form entries`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const groups = groupByField(items ?? []);
  return (
    <Group title="Form entries" description="Names, emails and addresses Dive offers while you type, kept in this profile. They come from forms you submit here and from Import from another browser.">
      {error && (
        <p role="alert" className="mb-2 text-[11px] text-danger">
          {error}
        </p>
      )}
      {items === null && !error && <p className="py-2 text-[11px] text-ink-3">Loading…</p>}
      {items?.length === 0 && <p className="py-2 text-[11px] text-ink-3">Nothing remembered yet.</p>}
      {groups.length > 0 && (
        <ul className="divide-y divide-line/60">
          {groups.map((g) => (
            <li key={g.field} className="py-2">
              <p className="text-[10.5px] tracking-[0.06em] text-ink-3 uppercase">{fieldLabel(g.field)}</p>
              <ul>
                {g.entries.map((e) => (
                  <li key={e.id} className="flex items-center gap-2 py-0.5">
                    <span className="min-w-0 flex-1 truncate text-xs text-ink">{e.value}</span>
                    <span className="text-[10.5px] text-ink-3">{e.uses === 1 ? "used once" : `used ${e.uses.toLocaleString()} times`}</span>
                    <IconButton icon={Trash2} label={`Forget ${e.value}`} size={12} onClick={() => void remove(e)} />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {items && items.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 py-2">
          {confirming ? (
            <>
              <span className="text-[11px] text-ink-2">Forget all {items.length.toLocaleString()} entries?</span>
              <Button variant="danger" onClick={() => void clear()}>
                Forget all
              </Button>
              <Button onClick={() => setConfirming(false)}>Keep them</Button>
            </>
          ) : (
            <Button onClick={() => setConfirming(true)}>Forget all…</Button>
          )}
        </div>
      )}
    </Group>
  );
}
