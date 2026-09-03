import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { IconButton } from "./Icon";

/** Cmd+F bar: live count, Enter / Shift+Enter to step, Esc to close. */
export function FindBar() {
  const activeTab = useBrowser((s) => s.activeTab);
  const toggle = useBrowser((s) => s.toggle);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(1);
  const [result, setResult] = useState({ total: 0, current: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!activeTab) return;
    let alive = true;
    const t = setTimeout(() => {
      ipc
        .tabFind(activeTab, query, index)
        .then((r) => alive && setResult(r))
        .catch(() => alive && setResult({ total: 0, current: 0 }));
    }, 80);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [activeTab, query, index]);

  const close = () => {
    if (activeTab) void ipc.tabFind(activeTab, "", 1).catch(() => undefined);
    toggle("find", false);
  };

  return (
    <div className="absolute top-2 right-3 z-30 flex h-9 items-center gap-1 rounded-full border border-line-2 bg-surface px-2 shadow-xl">
      <input
        ref={inputRef}
        aria-label="Find in page"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(1);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          if (e.key === "Enter") setIndex((i) => (e.shiftKey ? i - 1 : i + 1));
        }}
        placeholder="Find in page"
        className="h-7 w-52 bg-transparent px-2 text-xs outline-none placeholder:text-ink-3"
      />
      <span className="w-14 text-center font-mono text-[11px] text-ink-3 tabular-nums">{query ? `${result.current}/${result.total}` : ""}</span>
      <IconButton icon={ChevronUp} label="Previous match" size={13} disabled={!result.total} onClick={() => setIndex((i) => i - 1)} />
      <IconButton icon={ChevronDown} label="Next match" size={13} disabled={!result.total} onClick={() => setIndex((i) => i + 1)} />
      <IconButton icon={X} label="Close find" size={13} onClick={close} />
    </div>
  );
}
