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
  const [position, setPosition] = useState({ left: 8, top: 8, minWidth: 160, maxWidth: 360, maxHeight: 280 });
  const search = useRef({ text: "", time: 0 });
  const dismissal = useRef<{ pointerId: number } | null>(null);
  const open = expanded && !disabled && options.length > 0;
  const selected = options.find((option) => option.value === value);
  const highlightedIndex = options.findIndex((option) => option.value === highlight);
  const active = highlightedIndex >= 0 ? highlightedIndex : Math.max(0, options.findIndex((option) => option.value === value));
  // Drop the open request when availability changes, so re-enabling cannot
  // resurrect a dismissed popup. React retries this component before commit.
  if (expanded && (disabled || options.length === 0)) setExpanded(false);
  useCoversContent(open);

  useEffect(() => {
    // Keep gesture cleanup alive after the popup closes. A click can retarget
    // to an ancestor of the pressed icon, or never arrive after cancellation.
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    const reset = () => { dismissal.current = null; clearTimeout(releaseTimer); };
    const onActivate = (event: MouseEvent) => {
      if (dismissal.current) { event.preventDefault(); event.stopPropagation(); }
      reset();
    };
    const onCancel = (event: PointerEvent) => {
      if (dismissal.current && dismissal.current.pointerId === event.pointerId) reset();
    };
    const onUp = (event: PointerEvent) => {
      if (dismissal.current && dismissal.current.pointerId === event.pointerId) {
        // The browser dispatches the associated click after pointerup. If it
        // does not produce one, do not retain suppression for a later action.
        releaseTimer = setTimeout(reset, 0);
      }
    };
    document.addEventListener("pointerdown", reset, true);
    document.addEventListener("pointercancel", onCancel, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("dragstart", reset, true);
    document.addEventListener("keydown", reset, true);
    for (const type of ["click", "auxclick", "contextmenu"] as const) document.addEventListener(type, onActivate, true);
    window.addEventListener("blur", reset);
    return () => {
      reset();
      document.removeEventListener("pointerdown", reset, true);
      document.removeEventListener("pointercancel", onCancel, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("dragstart", reset, true);
      document.removeEventListener("keydown", reset, true);
      for (const type of ["click", "auxclick", "contextmenu"] as const) document.removeEventListener(type, onActivate, true);
      window.removeEventListener("blur", reset);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (trigger.current?.contains(event.target as Node) || list.current?.contains(event.target as Node)) return;
      event.preventDefault(); event.stopPropagation();
      dismissal.current = { pointerId: event.pointerId };
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
      // Once its anchor scrolls entirely out of view, the choice list no
      // longer has a visible owner. Dismiss instead of following it offscreen.
      if (rect.top >= window.innerHeight || rect.bottom < 0 || rect.left >= window.innerWidth || rect.right < 0) {
        setExpanded(false);
        return;
      }
      const margin = 8, gap = 4;
      // The list is at least 160px wide, so under a short trigger it would
      // hang past whatever panel holds the trigger (a Settings row ends at
      // the dialog's edge). Keep it inside that panel where it can.
      const panel = trigger.current?.closest('[role="dialog"], [role="alertdialog"]')?.getBoundingClientRect();
      const lo = panel ? panel.left + margin : margin;
      const hi = Math.min(window.innerWidth, panel ? panel.right : window.innerWidth) - margin;
      // At least as wide as its trigger, and as wide as its longest option up
      // to a cap, so an option never wraps where the trigger showed it on
      // one line.
      const maxWidth = Math.max(0, Math.min(360, window.innerWidth - margin * 2));
      const minWidth = Math.min(Math.max(rect.width, 160), maxWidth);
      const width = Math.min(maxWidth, Math.max(minWidth, list.current?.offsetWidth ?? 0));
      // Past the panel's right edge, line the list's right edge up with the
      // trigger's instead of its left: a right-aligned control opens leftward.
      const start = rect.left + width > hi ? rect.right - width : rect.left;
      const left = Math.max(margin, Math.min(Math.max(start, lo), window.innerWidth - width - margin));
      const below = window.innerHeight - rect.bottom - gap - margin;
      const above = rect.top - gap - margin;
      // The full height includes the list's border. Comparing against the
      // scroll height alone left a list 2px short of fitting, so it opened
      // downward and scrolled over its last option instead of flipping up.
      const frame = list.current ? list.current.offsetHeight - list.current.clientHeight : 0;
      const natural = list.current?.scrollHeight ? list.current.scrollHeight + frame : 280;
      const upwards = below < Math.min(280, natural) && above > below;
      const maxHeight = Math.max(0, Math.min(280, upwards ? above : below));
      const height = Math.min(natural, maxHeight);
      const next = { left, top: Math.max(margin, upwards ? rect.top - gap - height : rect.bottom + gap), minWidth, maxWidth, maxHeight };
      setPosition((previous) => Object.keys(next).every((key) => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next);
    };
    const onScroll = (event: Event) => {
      const target = event.target;
      // The portal's own scrolling (including keyboard scrollIntoView) keeps
      // its anchor intact. Scrolling an ancestor can hide the trigger under
      // a clipped or sticky panel even when its viewport coordinates remain
      // on screen, so dismiss that detached list instead of repositioning it.
      if (!(target instanceof Node) || list.current?.contains(target)) return;
      if (trigger.current && target.contains(trigger.current)) setExpanded(false);
    };
    place();
    const observer = new ResizeObserver(place);
    if (trigger.current) observer.observe(trigger.current);
    if (list.current) observer.observe(list.current);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", onScroll, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); document.removeEventListener("scroll", onScroll, true); };
  }, [open, options]);

  // Again once the list has its real height: the first pass runs at the
  // provisional 280px and could leave the chosen option below the fold.
  useLayoutEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, listId, position.maxHeight]);

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
      {/* Every label sits in the same grid cell, only the chosen one visible,
          so the trigger is as wide as its longest option and does not jump
          when the choice changes. */}
      <span className="grid min-w-0 [grid-template-areas:'label'] *:[grid-area:label]" title={selected?.label}>
        {options.map((option) => <span key={option.value} aria-hidden={option.value !== value} className={`truncate ${option.value === value ? "" : "invisible"}`}>{option.label}</span>)}
        {!selected && <span className="truncate">{options.length ? "Choose…" : "No options"}</span>}
      </span>
      <Icon icon={ChevronDown} size={13} className={`shrink-0 text-ink-3 transition-transform ${open ? "rotate-180" : ""}`} />
    </button>
    {open && createPortal(<div ref={list} id={listId} role="listbox" aria-label={label} data-native-input-owner="true"
      className="fixed z-[1000] w-max overflow-y-auto overscroll-contain rounded-xl border border-line-2 bg-surface p-1 text-xs text-ink shadow-2xl"
      style={{ ...position, borderRadius: 12 }} onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      {options.map((option, index) => <div key={option.value} id={`${listId}-${index}`} role="option" aria-selected={option.value === value}
        className={`flex cursor-default items-center gap-2 rounded-lg px-2 py-2 ${index === active ? "bg-surface-3 text-ink" : "text-ink-2"}`}
        onPointerMove={() => setHighlight(option.value)} onClick={() => commit(option.value)}>
        <span className="min-w-0 flex-1 truncate" title={option.label}>{option.label}</span>
        {/* The check's slot is kept on every row, so rows line up and the
            chosen one is no narrower than the rest. */}
        <Icon icon={Check} size={13} className={`shrink-0 text-highlight ${option.value === value ? "" : "invisible"}`} />
      </div>)}
    </div>, document.body)}
  </>;
}
