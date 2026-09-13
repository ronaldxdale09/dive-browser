import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useCoversContent } from "../lib/overlay";
import { Icon } from "./Icon";

export interface SelectProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
  label: string;
  id?: string | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}

/** App-owned choices must stay in the DOM: native select menus enter a nested
 * macOS menu loop that can stall CEF protocol work until the menu closes. */
export function Select<T extends string>({ value, onChange, options, label, id, disabled = false, className }: SelectProps<T>) {
  const listId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [highlight, setHighlight] = useState<T>(value);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 160, maxHeight: 280 });
  const search = useRef({ text: "", time: 0 });
  const dismissedTarget = useRef<EventTarget | null>(null);
  const open = expanded && !disabled && options.length > 0;
  const selected = options.find((option) => option.value === value);
  const highlightedIndex = options.findIndex((option) => option.value === highlight);
  const active = highlightedIndex >= 0 ? highlightedIndex : Math.max(0, options.findIndex((option) => option.value === value));
  // Drop the open request when availability changes, so re-enabling cannot
  // resurrect a dismissed popup. React retries this component before commit.
  if (expanded && (disabled || options.length === 0)) setExpanded(false);
  useCoversContent(open);

  useEffect(() => {
    // Consume the click following an outside pointerdown even after the list
    // has closed. Otherwise it can activate a destructive control beneath it.
    const onClick = (event: MouseEvent) => {
      if (dismissedTarget.current === event.target) { event.preventDefault(); event.stopPropagation(); }
      dismissedTarget.current = null;
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      dismissedTarget.current = null;
      if (trigger.current?.contains(event.target as Node) || list.current?.contains(event.target as Node)) return;
      event.preventDefault(); event.stopPropagation();
      dismissedTarget.current = event.target;
      setExpanded(false);
    };
    const blur = () => setExpanded(false);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", blur);
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("blur", blur); };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 8, gap = 4;
      const width = Math.min(Math.max(rect.width, 160), Math.max(0, window.innerWidth - margin * 2));
      const below = window.innerHeight - rect.bottom - gap - margin;
      const above = rect.top - gap - margin;
      const upwards = below < Math.min(280, list.current?.scrollHeight || 280) && above > below;
      const maxHeight = Math.max(0, Math.min(280, upwards ? above : below));
      const height = Math.min(list.current?.scrollHeight || 280, maxHeight);
      const next = { left: Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin)), top: Math.max(margin, upwards ? rect.top - gap - height : rect.bottom + gap), width, maxHeight };
      setPosition((previous) => Object.keys(next).every((key) => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next);
    };
    place();
    const observer = new ResizeObserver(place);
    if (trigger.current) observer.observe(trigger.current);
    if (list.current) observer.observe(list.current);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); document.removeEventListener("scroll", place, true); };
  }, [open, options]);

  useLayoutEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, listId]);

  const show = () => {
    if (disabled || options.length === 0) return;
    setHighlight(selected?.value ?? options[0]!.value);
    search.current = { text: "", time: 0 };
    setExpanded(true);
    trigger.current?.focus({ preventScroll: true });
  };
  const commit = (next: T) => {
    setExpanded(false);
    trigger.current?.focus({ preventScroll: true });
    if (next !== value) onChange(next);
  };
  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || options.length === 0) return;
    if (event.key === "Tab") { setExpanded(false); return; }
    if (event.key === "Escape") {
      if (open) { event.preventDefault(); event.stopPropagation(); setExpanded(false); }
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (!open) { show(); if (event.key === "Home" || event.key === "End") setHighlight(options[event.key === "Home" ? 0 : options.length - 1]!.value); return; }
      if (event.key === "Enter" || event.key === " ") { commit(options[active]!.value); return; }
      const index = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (active + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length;
      setHighlight(options[index]!.value);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); event.stopPropagation();
      if (!open) show();
      const now = Date.now();
      const text = (now - search.current.time < 700 ? search.current.text : "") + event.key.toLocaleLowerCase();
      search.current = { text, time: now };
      const query = [...text].every((letter) => letter === text[0]) ? text[0]! : text;
      const start = text.length === 1 || query.length === 1 ? active + 1 : active;
      for (let offset = 0; offset < options.length; offset++) {
        const option = options[(start + offset) % options.length]!;
        if (option.label.toLocaleLowerCase().startsWith(query)) { setHighlight(option.value); break; }
      }
    }
  };

  return <>
    <button ref={trigger} id={id} type="button" role="combobox" aria-label={label} aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? listId : undefined} aria-activedescendant={open ? `${listId}-${active}` : undefined} disabled={disabled || options.length === 0}
      onClick={() => open ? setExpanded(false) : show()} onKeyDownCapture={onKey} onBlur={() => setExpanded(false)}
      className={`inline-flex min-w-0 items-center justify-between gap-2 text-left ${className ?? "h-8 rounded-lg border border-line bg-surface-2 py-0 pr-2 pl-2.5 text-xs text-ink outline-none hover:border-line-2 focus:border-highlight/60 disabled:opacity-40"}`}>
      <span className="truncate">{selected?.label ?? (options.length ? "Choose…" : "No options")}</span><Icon icon={ChevronDown} size={13} className="shrink-0 text-ink-3" />
    </button>
    {open && createPortal(<div ref={list} id={listId} role="listbox" aria-label={label} data-native-input-owner="true"
      className="fixed z-[1000] overflow-y-auto overscroll-contain rounded-xl border border-line-2 bg-surface p-1 text-xs text-ink shadow-2xl"
      style={{ ...position, borderRadius: 12 }} onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      {options.map((option, index) => <div key={option.value} id={`${listId}-${index}`} role="option" aria-selected={option.value === value}
        className={`flex cursor-default items-center gap-2 rounded-lg px-2 py-2 ${index === active ? "bg-surface-3 text-ink" : "text-ink-2"}`}
        onPointerMove={() => setHighlight(option.value)} onClick={() => commit(option.value)}>
        <span className="min-w-0 flex-1 break-words">{option.label}</span>{option.value === value && <Icon icon={Check} size={13} className="shrink-0 text-highlight" />}
      </div>)}
    </div>, document.body)}
  </>;
}
