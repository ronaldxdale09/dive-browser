import { Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { Icon } from "./Icon";
import { Tooltip } from "./Tooltip";
import { errorMessage } from "../lib/errors";
import { renameBookmark } from "../lib/bookmarks";
import { hostOf } from "../lib/omnibox";
import { useCoversContent } from "../lib/overlay";
import { useFocusTrap } from "../lib/useFocusTrap";

/**
 * Star saves the active tab's current URL and opens a small popover to name
 * it or take it back. Clicking a lit star opens the same popover rather than
 * silently removing the bookmark.
 */
export function BookmarkButton() {
  const current = useBrowser((s) => s.tabs.find((t) => t.id === s.activeTab));
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const url = current?.url;
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  useCoversContent(open);
  useFocusTrap(panel, { active: open, initialFocus: titleInput, onEscape: () => setOpen(false) });

  useEffect(() => {
    if (!url) return;
    let alive = true;
    ipc
      .bookmarkStatus(url)
      .then((v) => alive && setSaved(v))
      .catch(() => alive && setSaved(false));
    return () => {
      alive = false;
      // The popover names one page; leaving it closes the popover.
      setOpen(false);
    };
  }, [url]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const fail = (e: unknown) => useBrowser.setState({ error: errorMessage(e) });
  const show = (name: string) => {
    setTitle(name);
    setOpen(true);
  };
  const onStar = () => {
    if (!current) return;
    if (saved) {
      show(current.title || current.url);
      return;
    }
    ipc
      .bookmarkToggle(current.id)
      .then((v) => {
        setSaved(v);
        if (v) show(current.title || current.url);
        else useBrowser.getState().notify("Bookmark removed", 2000);
      })
      .catch(fail);
  };
  const remove = () => {
    if (!current) return;
    ipc
      .bookmarkRemove(current.url)
      .then(() => {
        setSaved(false);
        setOpen(false);
        useBrowser.getState().notify("Bookmark removed", 2000);
      })
      .catch(fail);
  };
  const done = () => {
    if (!current) return;
    const next = title.trim();
    setOpen(false);
    if (!next || next === (current.title || current.url)) return;
    renameBookmark(current.url, next).catch(fail);
  };

  const label = saved ? "Edit bookmark" : "Bookmark this page";
  return (
    <div ref={root} className="relative">
      <Tooltip label={label}>
        <button
          type="button"
          aria-label={label}
          aria-pressed={saved}
          aria-expanded={open}
          disabled={!current}
          onClick={onStar}
          className="grid size-7 place-items-center rounded-full text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-35 aria-pressed:text-highlight"
        >
          <Icon icon={Star} fill={saved ? "currentColor" : "none"} />
        </button>
      </Tooltip>
      {open && current && (
        <div ref={panel} role="dialog" aria-label="Bookmark added" className="surface-enter absolute right-0 z-50 mt-1 w-72 rounded-xl border border-line-2 bg-surface p-3 text-xs shadow-2xl">
          <div className="mb-2 flex items-center gap-1.5 text-[10px] font-medium tracking-[0.08em] text-ink-3 uppercase">
            <Icon icon={Star} size={11} fill="currentColor" className="text-highlight" />
            Bookmark added
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              done();
            }}
          >
            <input
              ref={titleInput}
              aria-label="Bookmark title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              spellCheck={false}
              className="h-7 w-full rounded-lg border border-line bg-surface-2 px-2 text-[12px] text-ink outline-none focus:border-line-2"
            />
            <div className="mt-1 truncate px-0.5 font-mono text-[11px] text-ink-3" title={current.url}>
              {hostOf(current.url) || current.url}
            </div>
            <div className="mt-3 flex items-center gap-1">
              <button type="button" onClick={remove} className="h-7 rounded-lg px-2 text-[11px] text-ink-2 hover:bg-surface-2 hover:text-danger">
                Remove
              </button>
              <span className="flex-1" />
              <button type="submit" className="h-7 rounded-lg bg-highlight px-3 text-[11px] font-medium text-highlight-ink hover:opacity-90">
                Done
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
