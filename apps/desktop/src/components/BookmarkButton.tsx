import { Star } from "lucide-react";
import { useEffect, useState } from "react";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { Icon } from "./Icon";
import { Tooltip } from "./Tooltip";

/** Star toggles a bookmark for the active tab's current URL. */
export function BookmarkButton() {
  const current = useBrowser((s) => s.tabs.find((t) => t.id === s.activeTab));
  const [saved, setSaved] = useState(false);
  const url = current?.url;
  useEffect(() => {
    if (!url) return;
    let alive = true;
    ipc
      .bookmarkStatus(url)
      .then((v) => alive && setSaved(v))
      .catch(() => alive && setSaved(false));
    return () => {
      alive = false;
    };
  }, [url]);
  const toggle = () => {
    if (!current) return;
    ipc
      .bookmarkToggle(current.id)
      .then((v) => {
        setSaved(v);
        useBrowser.setState({ notice: v ? "Bookmarked" : "Bookmark removed" });
        setTimeout(() => useBrowser.setState({ notice: null }), 2000);
      })
      .catch((e: unknown) => useBrowser.setState({ error: e instanceof Error ? e.message : String(e) }));
  };
  const label = saved ? "Remove bookmark" : "Bookmark this page";
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={saved}
        disabled={!current}
        onClick={toggle}
        className="grid size-7 place-items-center rounded-full text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-35 aria-pressed:text-highlight"
      >
        <Icon icon={Star} fill={saved ? "currentColor" : "none"} />
      </button>
    </Tooltip>
  );
}
