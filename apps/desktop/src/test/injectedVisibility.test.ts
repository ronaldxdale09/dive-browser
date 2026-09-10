import { beforeEach, describe, expect, it } from "vitest";
import { buildInjected } from "./injected";

/**
 * `isVisible` decides both what a locator matches with `visible=true` and
 * whether a click is worth dispatching, so it is worth testing on its own.
 * The engine is installed and asked directly.
 */
function visible(selector: string): boolean {
  const script = buildInjected("locator.js", { __MAX_CANDIDATES__: "10" });
  return eval(`${script}; window.__diveLocator.matches(${JSON.stringify(`${selector} >> visible=true`)}).count > 0`) as boolean;
}

/** jsdom reports no geometry, so boxes are given one the way the page would. */
function withBox(el: Element, box: { x?: number; y?: number; width: number; height: number }) {
  const { x = 0, y = 0, width, height } = box;
  el.getBoundingClientRect = () =>
    ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) }) as DOMRect;
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("what counts as visible", () => {
  it("sees an ordinary element", () => {
    document.body.innerHTML = `<button id="b">Go</button>`;
    withBox(document.getElementById("b")!, { width: 60, height: 20 });
    expect(visible("css=#b")).toBe(true);
  });

  it("does not see one an ancestor has clipped away to nothing", () => {
    // A collapsed accordion, a closed drawer, a carousel panel off to the
    // side: the element keeps a box of its own, so its own rectangle says
    // nothing. Clicking it dispatches an event that changes nothing anyone
    // can see and reads back as success, which is the worse failure.
    document.body.innerHTML = `<div id="wrap" style="overflow:hidden"><button id="b">Ghost</button></div>`;
    withBox(document.getElementById("wrap")!, { width: 200, height: 0 });
    withBox(document.getElementById("b")!, { width: 60, height: 20 });
    expect(visible("css=#b")).toBe(false);
  });

  it("does not see one scrolled outside its clipping ancestor", () => {
    document.body.innerHTML = `<div id="wrap" style="overflow:hidden"><button id="b">Away</button></div>`;
    withBox(document.getElementById("wrap")!, { x: 0, y: 0, width: 200, height: 100 });
    withBox(document.getElementById("b")!, { x: 0, y: 400, width: 60, height: 20 });
    expect(visible("css=#b")).toBe(false);
  });

  it("still sees one inside a clipping ancestor it overlaps", () => {
    // Overflow hidden is ordinary layout, not a hiding mechanism; a control
    // inside a scroll area is as clickable as any other.
    document.body.innerHTML = `<div id="wrap" style="overflow:hidden"><button id="b">Here</button></div>`;
    withBox(document.getElementById("wrap")!, { x: 0, y: 0, width: 200, height: 100 });
    withBox(document.getElementById("b")!, { x: 10, y: 10, width: 60, height: 20 });
    expect(visible("css=#b")).toBe(true);
  });

  it("does not see display none, visibility hidden, zero opacity or [hidden]", () => {
    for (const markup of [
      `<button id="b" style="display:none">a</button>`,
      `<button id="b" style="visibility:hidden">a</button>`,
      `<button id="b" style="opacity:0">a</button>`,
      `<div hidden><button id="b">a</button></div>`,
    ]) {
      document.body.innerHTML = markup;
      withBox(document.getElementById("b")!, { width: 60, height: 20 });
      expect(visible("css=#b"), markup).toBe(false);
    }
  });
});
