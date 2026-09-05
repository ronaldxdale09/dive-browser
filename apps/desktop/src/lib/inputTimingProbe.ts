/** Opt-in chrome timing only. The gated native UI probe enables this after a requested sample. */
type Source = "keyboard" | "native-menu" | "command";
type Target = { tag: string; role: string | null } | null;
type Kind = "command" | "palette-mounted" | "palette-unmounted" | "keydown" | "beforeinput" | "input" | "paste" | "focusin" | "focusout";
interface TimingEvent {
  sequence: number;
  at: number;
  kind: Kind;
  target: Target;
  active: Target;
  command?: string;
  source?: Source;
}
interface Snapshot {
  timeOrigin: number;
  events: TimingEvent[];
  dropped: number;
}
interface Probe {
  start(): boolean;
  snapshot(): Snapshot;
  stop(): void;
}
declare global {
  interface Window {
    __diveUiInputTimingEnabled?: boolean;
    __diveInputTimingProbe?: Probe;
  }
}

const LIMIT = 256;
const COMMANDS = new Set(["tab.new", "palette.open", "tabs.search", "settings.open"]);
const ROLES = new Set(["button", "checkbox", "combobox", "dialog", "link", "listbox", "menu", "menuitem", "option", "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "tabpanel", "textbox"]);
const INPUT_EVENTS = ["keydown", "beforeinput", "input", "paste", "focusin", "focusout"] as const;
let running = false;
let sequence = 0;
let dropped = 0;
const events: TimingEvent[] = [];

function identify(target: EventTarget | null): Target {
  if (!(target instanceof Element)) return null;
  const role = target.getAttribute("role");
  return { tag: target.tagName, role: role && ROLES.has(role) ? role : null };
}

function record(kind: Kind, target: EventTarget | null, command?: string, source?: Source) {
  if (!running || window.__diveUiInputTimingEnabled !== true) return;
  if (events.length === LIMIT) {
    events.shift();
    dropped += 1;
  }
  events.push({ sequence: ++sequence, at: performance.now(), kind, target: identify(target), active: identify(document.activeElement),
    ...(command && source ? { command, source } : {}) });
}

function onInput(event: Event) {
  // Deliberately do not read key, data, inputType, clipboard, values or labels.
  record(event.type as Kind, event.target);
}

function start(): boolean {
  if (window.__diveUiInputTimingEnabled !== true) return false;
  if (!running) {
    running = true;
    for (const type of INPUT_EVENTS) window.addEventListener(type, onInput, { capture: true, passive: true });
  }
  return true;
}

function stop() {
  for (const type of INPUT_EVENTS) window.removeEventListener(type, onInput, true);
  running = false;
  sequence = 0;
  dropped = 0;
  events.length = 0;
}

export function traceInputCommand(command: string, source: Source) {
  if (COMMANDS.has(command)) record("command", document.activeElement, command, source);
}

export function tracePaletteLifecycle(kind: "palette-mounted" | "palette-unmounted", input: HTMLElement | null) {
  record(kind, input);
}

// Register an inert control API; listeners and collection require the native probe's flag.
if (typeof window !== "undefined") {
  window.__diveInputTimingProbe?.stop();
  window.__diveInputTimingProbe = {
    start,
    stop,
    snapshot: () => ({ timeOrigin: performance.timeOrigin, dropped, events: events.map((event) => ({ ...event,
      target: event.target && { ...event.target }, active: event.active && { ...event.active } })) }),
  };
  if (window.__diveUiInputTimingEnabled === true) start();
}
