import { beforeEach, describe, expect, it } from "vitest";
import { buildInjected } from "./injected";

/** Run the glow script with `on` true or false, as the host does. */
function run(on: boolean): { overlay: boolean } {
  return eval(buildInjected("agent_glow.js", { __ON__: String(on) })) as { overlay: boolean };
}

const host = () => document.getElementById("__dive-agent-glow");

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  host()?.remove();
});

describe("the agent overlay in the page", () => {
  it("paints one glow and leaves the page's own DOM alone", () => {
    expect(run(true)).toEqual({ overlay: true });
    const el = host();
    expect(el).toBeTruthy();
    // On documentElement, not in the body: a page reading its own body
    // children never sees it.
    expect(el?.parentElement).toBe(document.documentElement);
    expect(document.body.children).toHaveLength(0);
  });

  it("is invisible to everything that reads the page for an agent", () => {
    run(true);
    const el = host();
    // No text, so page_text and page_markdown cannot pick it up; no pointer
    // events and no role, so it is not an interactive element either.
    expect(el?.textContent).toBe("");
    expect(el?.getAttribute("aria-hidden")).toBe("true");
    expect((el as HTMLElement | null)?.style.pointerEvents).toBe("none");
  });

  it("is painted once however many times it is asked for", () => {
    run(true);
    const first = host();
    expect(run(true)).toEqual({ overlay: true });
    expect(host()).toBe(first);
    expect(document.querySelectorAll("#__dive-agent-glow")).toHaveLength(1);
  });

  it("takes itself away again", () => {
    run(true);
    expect(run(false)).toEqual({ overlay: false });
    expect(host()).toBeNull();
  });

  it("clearing a glow that was never painted is not an error", () => {
    expect(run(false)).toEqual({ overlay: false });
    expect(host()).toBeNull();
  });

  it("keeps its styles in a shadow root, out of reach of the page", () => {
    run(true);
    const el = host();
    expect(el?.shadowRoot).toBeTruthy();
    expect(el?.shadowRoot?.querySelector("style")?.textContent).toContain("dive-agent-breathe");
    // The keyframes are inside the shadow root, so a page animation of the
    // same name cannot be redefined out from under it.
    expect(document.head.textContent).not.toContain("dive-agent-breathe");
  });
});

describe("the virtual cursor", () => {
  it("installs a controller so each action is a small call, not a re-injection", () => {
    run(true);
    const overlay = (window as Window & { __diveAgentOverlay?: { cursor: unknown } }).__diveAgentOverlay;
    expect(typeof overlay?.cursor).toBe("function");
  });

  it("takes the controller away with the overlay, so a stale one cannot be called", () => {
    run(true);
    run(false);
    expect((window as Window & { __diveAgentOverlay?: unknown }).__diveAgentOverlay).toBeUndefined();
  });

  it("shows the cursor and what it is acting on", () => {
    run(true);
    const overlay = (window as Window & { __diveAgentOverlay?: { cursor: (x: number, y: number, p: string, t?: string) => void } }).__diveAgentOverlay;
    overlay?.cursor(40, 60, "move", 'link "Learn more"');
    const root = host()?.shadowRoot;
    expect(root?.querySelector(".cursor")?.className).toContain("on");
    expect(root?.querySelector(".label")?.textContent).toBe('link "Learn more"');
  });

  it("keeps a long label from running off the end of the line", () => {
    run(true);
    const overlay = (window as Window & { __diveAgentOverlay?: { cursor: (x: number, y: number, p: string, t?: string) => void } }).__diveAgentOverlay;
    overlay?.cursor(10, 10, "move", "x".repeat(500));
    expect(host()?.shadowRoot?.querySelector(".label")?.textContent).toHaveLength(120);
  });

  it("hides the label when there is nothing to say", () => {
    run(true);
    const overlay = (window as Window & { __diveAgentOverlay?: { cursor: (x: number, y: number, p: string, t?: string) => void } }).__diveAgentOverlay;
    overlay?.cursor(10, 10, "move", 'link "a"');
    overlay?.cursor(20, 20, "move");
    expect(host()?.shadowRoot?.querySelector(".label")?.className).not.toContain("on");
  });
});
