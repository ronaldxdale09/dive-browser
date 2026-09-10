import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useBrowser } from "../store/browser";
import { usePrefs } from "../store/prefs";
import { ipc } from "../lib/ipc";
import type { QuickLink } from "../lib/ipc";
import { useFocusTrap } from "../lib/useFocusTrap";
import { Favicon } from "./Favicon";
import { BrandLogo } from "./BrandLogo";
import { Icon } from "./Icon";

/** The most a rail can pin before it stops being quick; mirrors the host. */
export const MAX_QUICK_LINKS = 12;

/**
 * Sites pinned at the top of the expanded rail. A click brings the site's
 * tab to the front when one is open in this workspace, and otherwise opens
 * one beside the work it is for. The list is the person's own: hover a link
 * for its remove control, use the plus to add one.
 *
 * Icons are the sites' own favicons, held in grey so the rail stays quiet
 * and only the one under the pointer shows its colour.
 */
export function QuickLinks() {
  const links = usePrefs((s) => s.prefs.quick_links);
  const update = usePrefs((s) => s.update);
  const openOrSwitch = useBrowser((s) => s.openOrSwitch);
  const tabs = useBrowser((s) => s.tabs);
  const [adding, setAdding] = useState(false);
  const remove = (url: string) => void update({ quick_links: links.filter((l) => l.url !== url) });
  const add = (link: QuickLink) => {
    setAdding(false);
    void update({ quick_links: [...links.filter((l) => l.url !== link.url), link].slice(-MAX_QUICK_LINKS) });
  };
  // A pinned site's icon comes from its open tab when there is one, so a list
  // that has just been added to looks right immediately. Otherwise it comes
  // from the store, which has kept the icon of every site the person has
  // visited -- without that, pinning a site you are not currently looking at
  // left a globe sitting in the rail until you happened to open it.
  const [cached, setCached] = useState<Readonly<Record<string, string>>>({});
  const addresses = links.map((l) => l.url).join(" ");
  useEffect(() => {
    let alive = true;
    const urls = addresses.split(" ").filter(Boolean);
    if (urls.length === 0) return;
    ipc
      .faviconsFor(urls)
      .then((rows) => alive && setCached(Object.fromEntries(rows)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [addresses]);
  const iconFor = (url: string) => {
    const host = hostOf(url);
    return tabs.find((t) => hostOf(t.url) === host)?.favicon ?? cached[url] ?? null;
  };

  return (
    <div role="group" aria-label="Quick links" className="shrink-0 pb-1">
      <div className="flex h-6 items-center gap-1 pr-0.5 pl-2">
        <span className="text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">Quick links</span>
        <span className="flex-1" />
        {links.length < MAX_QUICK_LINKS && (
          <button
            type="button"
            aria-label="Add a quick link"
            title="Add a quick link"
            aria-expanded={adding}
            onClick={() => setAdding((v) => !v)}
            className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"
          >
            <Icon icon={Plus} size={14} />
          </button>
        )}
      </div>
      {adding && <AddLink onAdd={add} onCancel={() => setAdding(false)} />}
      {links.length > 0 && (
        <ul className="grid grid-cols-3 gap-1">
          {links.map((link) => (
            <li key={link.url} className="group/link relative">
              <button
                type="button"
                aria-label={`Open ${link.name}`}
                title={`${link.name} — switches to its tab, or opens one`}
                onClick={() => void openOrSwitch(link.url)}
                className="pressable flex h-11 w-full flex-col items-center justify-center gap-1 rounded-lg text-ink-3 transition-[color,background-color,transform] hover:bg-surface-2 hover:text-ink focus-visible:bg-surface-2 focus-visible:text-ink"
              >
                <LinkMark url={link.url} favicon={iconFor(link.url)} />
                <span className="max-w-full truncate px-1 text-[10px] leading-none">{link.name}</span>
              </button>
              <button
                type="button"
                aria-label={`Remove ${link.name} from quick links`}
                title="Remove"
                onClick={() => remove(link.url)}
                className="absolute -top-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-surface-3 text-ink-3 opacity-0 transition-opacity group-hover/link:opacity-100 hover:text-ink focus-visible:opacity-100"
              >
                <Icon icon={X} size={9} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The brand marks Dive ships for the assistants it pins by default. */
const BRANDS: Record<string, string> = { "chatgpt.com": "chatgpt", "claude.ai": "claude", "gemini.google.com": "gemini" };

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Grey at rest, its own colours under the pointer, so the rail stays quiet. */
function LinkMark({ url, favicon }: { url: string; favicon: string | null }) {
  const quiet = "opacity-70 grayscale transition-[filter,opacity] group-hover/link:opacity-100 group-hover/link:grayscale-0 group-focus-within/link:opacity-100 group-focus-within/link:grayscale-0";
  const brand = BRANDS[hostOf(url)];
  if (!favicon && brand) return <BrandLogo id={brand} size={15} className={quiet} />;
  return <Favicon src={favicon} size={15} className={quiet} />;
}

/** Two fields and an Add: the address decides, the name is what shows under the icon. */
function AddLink({ onAdd, onCancel }: { onAdd: (link: QuickLink) => void; onCancel: () => void }) {
  const form = useRef<HTMLFormElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  useFocusTrap(form, { initialFocus: first, onEscape: onCancel });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseQuickLink(url, name);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    onAdd(parsed);
  };
  return (
    <form ref={form} onSubmit={submit} aria-label="New quick link" className="mb-1 flex flex-col gap-1 rounded-lg border border-line-2 bg-surface p-1.5">
      <input
        ref={first}
        aria-label="Address"
        placeholder="https://linear.app"
        value={url}
        onChange={(e) => {
          setUrl(e.target.value);
          setError(null);
        }}
        className="h-7 rounded-md bg-surface-2 px-2 text-[11px] text-ink outline-none placeholder:text-ink-3 focus:ring-1 focus:ring-accent"
      />
      <input
        aria-label="Name"
        placeholder="Name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="h-7 rounded-md bg-surface-2 px-2 text-[11px] text-ink outline-none placeholder:text-ink-3 focus:ring-1 focus:ring-accent"
      />
      {error && (
        <p role="alert" className="px-0.5 text-[10.5px] text-warn">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-1">
        <button type="button" onClick={onCancel} className="h-6 rounded-md px-2 text-[11px] text-ink-3 hover:bg-surface-2 hover:text-ink">
          Cancel
        </button>
        <button type="submit" className="h-6 rounded-md bg-accent px-2 text-[11px] font-medium text-accent-ink hover:opacity-90">
          Add
        </button>
      </div>
    </form>
  );
}

/**
 * Turn what was typed into a link: a bare host gets `https://`, a missing
 * name becomes the host without `www.`. Non-web schemes are refused.
 */
export function parseQuickLink(rawUrl: string, rawName: string): QuickLink | { error: string } {
  const typed = rawUrl.trim();
  if (!typed) return { error: "Enter a web address." };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { error: "That is not a web address." };
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || !parsed.hostname) return { error: "Quick links open http or https addresses." };
  const name = rawName.trim() || parsed.hostname.replace(/^www\./, "");
  return { name: name.slice(0, 24), url: parsed.toString() };
}
