import { beforeEach, describe, expect, it } from "vitest";
import { buildInjected } from "./injected";

/** Run the glow script with `on` true or false, as the host does. */
function run(on: boolean): { glow: boolean } {
  return eval(buildInjected("agent_glow.js", { __ON__: String(on) })) as { glow: boolean };
}

const host = () => document.getElementById("__dive-agent-glow");

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  host()?.remove();
});

describe("the agent glow in the page", () => {
  it("paints one glow and leaves the page's own DOM alone", () => {
    expect(run(true)).toEqual({ glow: true });
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
    expect(run(true)).toEqual({ glow: true });
    expect(host()).toBe(first);
    expect(document.querySelectorAll("#__dive-agent-glow")).toHaveLength(1);
  });

  it("takes itself away again", () => {
    run(true);
    expect(run(false)).toEqual({ glow: false });
    expect(host()).toBeNull();
  });

  it("clearing a glow that was never painted is not an error", () => {
    expect(run(false)).toEqual({ glow: false });
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
