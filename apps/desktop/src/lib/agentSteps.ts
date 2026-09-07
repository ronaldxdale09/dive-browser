import type { LucideIcon } from "lucide-react";
import {
  Bug,
  Camera,
  Eye,
  FileSearch,
  Gauge,
  Keyboard,
  Layers,
  ListTree,
  MonitorSmartphone,
  MousePointerClick,
  Navigation,
  Network,
  Palette,
  Radar,
  ScrollText,
  Search,
  Server,
  Terminal,
  Timer,
  Wrench,
} from "lucide-react";
import type { Step } from "../store/agent";

/** What a step looks like in the thread: a verb phrase and a glyph. */
export interface StepView {
  label: string;
  icon: LucideIcon;
}

function parse(input: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(input);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function quote(s: string, max = 40): string {
  const one = s.replace(/\s+/g, " ").trim();
  return `“${one.length > max ? `${one.slice(0, max - 1)}…` : one}”`;
}

function host(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * The element a step aimed at, in the words the model used. Locators are
 * already readable (`role=button[name="Save"]`); a ref gets the Playwright
 * locator the host resolved for it; coordinates are the last resort.
 */
function target(step: Step, input: Record<string, unknown>): string {
  return str(input.locator) ?? step.locator ?? (str(input.ref) ? `ref ${String(input.ref)}` : undefined) ?? (typeof input.x === "number" && typeof input.y === "number" ? `(${Math.round(input.x)}, ${Math.round(input.y)})` : "the page");
}

/** Describe a tool call the way a person would say it. */
export function describeStep(step: Step): StepView {
  const input = parse(step.input);
  switch (step.name) {
    case "page_inspect":
      return { label: "Inspected the page", icon: Eye };
    case "page_text":
      return { label: "Read the page text", icon: FileSearch };
    case "page_state":
      return { label: "Read the accessibility tree", icon: ListTree };
    case "page_screenshot":
      return { label: "Took a screenshot", icon: Camera };
    case "page_click":
      return { label: `Clicked ${target(step, input)}`, icon: MousePointerClick };
    case "page_type": {
      const text = str(input.text);
      return { label: text ? `Typed ${quote(text)} into ${target(step, input)}` : `Cleared ${target(step, input)}`, icon: Keyboard };
    }
    case "page_press": {
      const mods = Array.isArray(input.modifiers) ? (input.modifiers as unknown[]).filter((m) => typeof m === "string") : [];
      return { label: `Pressed ${[...mods, str(input.key) ?? "a key"].join("+")}`, icon: Keyboard };
    }
    case "page_scroll": {
      const dy = typeof input.delta_y === "number" ? input.delta_y : 0;
      return { label: dy < 0 ? "Scrolled up" : "Scrolled down", icon: ScrollText };
    }
    case "page_wait_for": {
      const what = str(input.text) ? `text ${quote(str(input.text) ?? "")}` : str(input.locator) ?? (str(input.url_includes) ? `URL to include ${quote(str(input.url_includes) ?? "")}` : input.load ? "the page to load" : "the page to settle");
      return { label: `Waited for ${what}`, icon: Timer };
    }
    case "page_locate":
      return { label: `Looked for ${str(input.locator) ?? "an element"}`, icon: Search };
    case "tab_navigate":
      return { label: `Opened ${str(input.url) ? host(str(input.url) ?? "") : "a URL"}`, icon: Navigation };
    case "tabs_list":
      return { label: "Listed open tabs", icon: Layers };
    case "console_tail":
      return { label: "Read the console", icon: Terminal };
    case "network_list":
      return { label: "Listed network requests", icon: Network };
    case "network_body":
      return { label: "Read a response body", icon: Network };
    case "page_report":
      return { label: "Built a bug report", icon: Bug };
    case "page_resize": {
      const size = str(input.preset) ?? (typeof input.width === "number" && typeof input.height === "number" ? `${input.width}×${input.height}` : input.reset ? "the window size" : "a new size");
      return { label: `Resized the viewport to ${size}`, icon: MonitorSmartphone };
    }
    case "page_appearance": {
      const parts = [str(input.color_scheme) && `${str(input.color_scheme)} mode`, str(input.reduced_motion) && "reduced motion", str(input.media_type) && `${str(input.media_type)} media`].filter(Boolean);
      return { label: parts.length ? `Emulated ${parts.join(", ")}` : "Changed appearance emulation", icon: Palette };
    }
    case "page_throttle":
      return { label: str(input.profile) === "none" ? "Cleared network throttling" : `Throttled the network to ${str(input.profile) ?? "a profile"}`, icon: Gauge };
    case "page_component":
      return { label: `Found the component behind ${target(step, input)}`, icon: Wrench };
    case "rules_list":
      return { label: "Read the mock rules", icon: Radar };
    case "rules_set":
      return { label: "Changed the mock rules", icon: Radar };
    case "page_snapshot":
      return { label: "Snapshotted the page", icon: Camera };
    case "page_diff":
      return { label: "Compared the page with the snapshot", icon: FileSearch };
    case "dev_servers":
      return { label: "Looked for dev servers", icon: Server };
    case "page_devices":
      return { label: "Listed device presets", icon: MonitorSmartphone };
    default:
      return { label: step.name.replace(/_/g, " "), icon: Wrench };
  }
}

const PRESENT: Record<string, string> = {
  Inspected: "Inspect",
  Read: "Read",
  Took: "Take",
  Clicked: "Click",
  Typed: "Type",
  Cleared: "Clear",
  Pressed: "Press",
  Scrolled: "Scroll",
  Waited: "Wait",
  Looked: "Look",
  Opened: "Open",
  Listed: "List",
  Built: "Build",
  Resized: "Resize",
  Emulated: "Emulate",
  Changed: "Change",
  Throttled: "Throttle",
  Found: "Find",
  Snapshotted: "Snapshot",
  Compared: "Compare",
};

/**
 * A step that has not happened yet, worded so: "Click the link", not
 * "Clicked the link", while it waits for approval or is still running.
 */
export function pendingLabel(label: string): string {
  const space = label.indexOf(" ");
  const verb = space < 0 ? label : label.slice(0, space);
  const now = PRESENT[verb];
  return now ? now + label.slice(verb.length) : label;
}

/** `3.2k` for 3200, `812` for 812, `1.1M` for 1_100_000. */
export function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
}

/** `$0.0042`, or `<$0.0001` for a rounding-error amount. */
export function formatCost(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.0001) return "<$0.0001";
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(usd < 1 ? 3 : 2)}`;
}

/** `claude-opus-5` for `anthropic/claude-opus-5`; a chip has no room for both. */
export function shortModel(id: string): string {
  return id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
}
