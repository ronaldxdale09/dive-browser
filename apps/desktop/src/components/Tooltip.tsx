import { cloneElement, useEffect, useId, useRef, useState } from "react";
import type { FocusEvent, ReactElement, ReactNode } from "react";
import { displayChord, isMac } from "../lib/commands";
import { useCoversContent } from "../lib/overlay";

/**
 * How much room a tip above its trigger needs: its own 11px line, padding
 * and border, and the 4px gap. A trigger nearer the top of the window than
 * this would have its tip cut off by the window's edge.
 */
const ROOM_ABOVE = 28;

/**
 * How long a tip stays after the pointer leaves its trigger. The tip sits a
 * few pixels away, and without the grace it vanished while the pointer was
 * crossing the gap to read it or to select its text.
 */
const LEAVE_GRACE_MS = 150;

/** The hover delay before a tip fades in; the class `delay-500` below is the same wait. */
const SHOW_DELAY_MS = 500;

interface TriggerProps {
  "aria-describedby"?: string | undefined;
  "aria-keyshortcuts"?: string | undefined;
  "aria-label"?: string;
  title?: string | undefined;
  children?: ReactNode;
}

const ARIA_MODIFIERS: Record<string, string> = { "⌃": "Control", "⌥": "Alt", "⇧": "Shift" };
const ARIA_KEYS: Record<string, string> = { "←": "ArrowLeft", "→": "ArrowRight", "↑": "ArrowUp", "↓": "ArrowDown", "↵": "Enter", "⌫": "Backspace", "⌦": "Delete", "⎋": "Escape", Esc: "Escape", Space: "Space" };

/**
 * A chord the way `aria-keyshortcuts` spells it: "⌘⇧R" is "Meta+Shift+R" on
 * a Mac and "Control+Shift+R" elsewhere, where the chrome's ⌘ is Ctrl. A
 * chord already in the notation ("mod+k") is read the same way.
 */
export function ariaKeyShortcut(chord: string, mac: boolean = isMac()): string {
  const command = mac ? "Meta" : "Control";
  if (chord.includes("+") && chord.length > 1 && !/^[⌘⌃⌥⇧]/.test(chord)) {
    const names: Record<string, string> = { mod: command, meta: "Meta", ctrl: "Control", alt: "Alt", shift: "Shift" };
    return chord
      .split("+")
      .map((part, i, all) => (i < all.length - 1 ? (names[part] ?? part) : (ARIA_KEYS[part] ?? (part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1)))))
      .join("+");
  }
  const parts: string[] = [];
  let rest = chord;
  while (rest && /^[⌘⌃⌥⇧]/.test(rest)) {
    const glyph = rest[0]!;
    parts.push(glyph === "⌘" ? command : ARIA_MODIFIERS[glyph]!);
    rest = rest.slice(1);
  }
  if (rest) parts.push(ARIA_KEYS[rest] ?? (rest.length === 1 ? rest.toUpperCase() : rest));
  return parts.join("+");
}

/** The words a trigger is named by: its aria-label, else its text. */
function nameOf(trigger: ReactElement<TriggerProps>): string {
  const label = trigger.props["aria-label"];
  if (label) return label;
  const text = (node: ReactNode): string => {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(text).join("");
    return "";
  };
  return text(trigger.props.children);
}

const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

/** Whether focus arrived from the keyboard, the way `:focus-visible` decides. */
function focusVisible(target: EventTarget): boolean {
  try {
    return target instanceof Element && target.matches(":focus-visible");
  } catch {
    // An engine without the selector: treat focus as the keyboard's.
    return true;
  }
}

/** A chrome-native tooltip that also remains associated with its trigger for assistive tech. */
export function Tooltip({
  label,
  shortcut,
  align = "center",
  side = "top",
  children,
}: {
  label: string;
  shortcut?: string | undefined;
  align?: "start" | "center" | "end" | undefined;
  side?: "top" | "bottom" | "left" | "right" | undefined;
  children: ReactNode;
}) {
  const id = useId();
  // Whether the pointer is on the trigger or the tip, and whether focus came
  // from the keyboard. The tip shows for either, and while it shows it raises
  // the chrome over the page: a tip under a toolbar button sits on the page's
  // rectangle and is otherwise painted behind it.
  //
  // Keyboard focus only, not any focus. A click also focuses its button, and
  // the button keeps that focus while the person works; covering the page
  // for all of it would mask the page behind every button once clicked.
  const [hovered, setHovered] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  // Escape puts the tip away without moving the pointer or the focus; it
  // comes back the next time either arrives.
  const [dismissed, setDismissed] = useState(false);
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shown = (hovered || keyboard) && !dismissed;
  useCoversContent(shown);
  // The tip takes the pointer only once it can be seen. During the hover
  // delay it is there but transparent, and a pointer passing on to the next
  // row of buttons would otherwise land on a tip nobody can see.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setVisible(true), keyboard ? 0 : SHOW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      setVisible(false);
    };
  }, [shown, keyboard]);
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDismissed(true);
    };
    // Capture, and never stopped: Escape still closes whatever the tip's
    // button belongs to. The tip just goes with it.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shown]);
  useEffect(() => () => {
    if (leaving.current) clearTimeout(leaving.current);
  }, []);
  // A tip that would open above a control in the title-bar row has nowhere
  // to go: the chrome is clipped at the window's edge, so it was cut off or
  // missing. Such a tip opens below instead. Measured as the tip is about to
  // show (pointer or focus arriving), so it is right in whichever row the
  // control sits in -- the one-bar layout moves the toolbar into the top row.
  const [flipped, setFlipped] = useState(false);
  const place = (target: HTMLElement) => {
    if (side === "top") setFlipped(target.getBoundingClientRect().top < ROOM_ABOVE);
  };
  const shownSide = side === "top" && flipped ? "bottom" : side;
  const trigger = children as ReactElement<TriggerProps>;
  // A tip that only says the button's name again is read twice: once as the
  // name and again as the description. It describes the trigger only when it
  // says something more; the shortcut goes in `aria-keyshortcuts` either way.
  const describes = !same(label, nameOf(trigger));
  const describedBy = [trigger.props["aria-describedby"], describes ? id : undefined].filter(Boolean).join(" ") || undefined;
  const keyShortcuts = trigger.props["aria-keyshortcuts"] ?? (shortcut ? ariaKeyShortcut(shortcut) : undefined);
  const horizontal = align === "start" ? "left-0" : align === "end" ? "right-0" : "left-1/2 -translate-x-1/2";
  const position =
    shownSide === "bottom"
      ? `top-full mt-1 ${horizontal}`
      : shownSide === "left"
        ? "top-1/2 right-full mr-1 -translate-y-1/2"
        : shownSide === "right"
          ? "top-1/2 left-full ml-1 -translate-y-1/2"
          : `bottom-full mb-1 ${horizontal}`;

  return (
    <span
      className="group/tooltip relative inline-flex shrink-0"
      onMouseEnter={(e) => {
        if (leaving.current) clearTimeout(leaving.current);
        leaving.current = null;
        if (!hovered) {
          place(e.currentTarget);
          setDismissed(false);
        }
        setHovered(true);
      }}
      onMouseLeave={() => {
        if (leaving.current) clearTimeout(leaving.current);
        leaving.current = setTimeout(() => {
          leaving.current = null;
          setHovered(false);
        }, LEAVE_GRACE_MS);
      }}
      onFocus={(e: FocusEvent<HTMLSpanElement>) => {
        place(e.currentTarget);
        setDismissed(false);
        setKeyboard(focusVisible(e.target));
      }}
      onBlur={(e: FocusEvent<HTMLSpanElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setKeyboard(false);
      }}
    >
      {cloneElement(trigger, { "aria-describedby": describedBy, "aria-keyshortcuts": keyShortcuts, title: undefined })}
      <span
        id={id}
        role="tooltip"
        data-shown={shown || undefined}
        // Hidden rather than invisible: a positioned element that is merely
        // invisible still counts as scrollable overflow, and a tooltip near the
        // edge of a scrolling panel gave the panel a scrollbar. It fades in
        // from its starting style after the usual delay, at once for the
        // keyboard. Once visible it takes the pointer, so it can be moved
        // onto and read without going away.
        // A long label wraps, balanced so the last line is not a lone word,
        // instead of running out of its box: a cap with no wrapping let
        // "Connect an agent: drive Dive from…" spill past the border.
        className={`absolute z-50 w-max max-w-64 items-center gap-2 rounded-md border border-line-2 bg-surface-2 px-2 py-1 text-11 leading-tight text-ink shadow-lg transition-opacity duration-100 starting:opacity-0 ${shown ? "flex" : "hidden"} ${visible ? "pointer-events-auto" : "pointer-events-none"} ${keyboard ? "delay-0" : "delay-500"} ${position}`}
      >
        <span className="min-w-0 text-balance">{label}</span>
        {shortcut && <kbd className="shrink-0 font-mono text-9 whitespace-nowrap text-ink-3">{displayChord(shortcut)}</kbd>}
      </span>
    </span>
  );
}
