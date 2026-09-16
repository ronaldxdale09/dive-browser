import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "./ipc";
import { contentCoverDepth, resetContentCover, resetOverlayElements, useCoversContent, visibleOverlayRegions} from "./overlay";

/** A component whose only job is to hold the cover while `active`. */
function Cover({ active }: { active: boolean }) {
  useCoversContent(active);
  return null;
}

beforeEach(() => {
  resetContentCover();
  resetOverlayElements();
  vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useCoversContent", () => {
  it("hides the page while mounted active and shows it again on unmount", async () => {
    const view = render(createElement(Cover, { active: true }));
    expect(contentCoverDepth()).toBe(1);
    await waitFor(() => expect(ipc.setContentCovered).toHaveBeenLastCalledWith(true));

    act(() => view.unmount());
    expect(contentCoverDepth()).toBe(0);
    expect(ipc.setContentCovered).toHaveBeenLastCalledWith(false);
  });

  it("never touches the page for an inactive overlay", () => {
    render(createElement(Cover, { active: false }));
    expect(contentCoverDepth()).toBe(0);
    expect(ipc.setContentCovered).not.toHaveBeenCalled();
  });

  it("tells the engine once for a stack of overlays, not once each", async () => {
    const view = render(createElement("div", null, createElement(Cover, { active: true, key: "a" }), createElement(Cover, { active: true, key: "b" })));
    expect(contentCoverDepth()).toBe(2);
    await waitFor(() => expect(ipc.setContentCovered).toHaveBeenCalledTimes(1));

    // The page stays hidden until the last overlay lets go.
    act(() => view.unmount());
    expect(contentCoverDepth()).toBe(0);
    expect(ipc.setContentCovered).toHaveBeenCalledTimes(2);
    expect(ipc.setContentCovered).toHaveBeenLastCalledWith(false);
  });

  it("releases the page when an overlay goes inactive without unmounting", async () => {
    const view = render(createElement(Cover, { active: true }));
    expect(contentCoverDepth()).toBe(1);
    await waitFor(() => expect(ipc.setContentCovered).toHaveBeenCalledWith(true));

    act(() => view.rerender(createElement(Cover, { active: false })));
    expect(contentCoverDepth()).toBe(0);
    expect(ipc.setContentCovered).toHaveBeenLastCalledWith(false);
  });
});

describe("live overlays versus a modal", () => {
  /** A dialog that declares itself modal, as every real one does. */
  function Modal() {
    useCoversContent(true);
    return createElement("div", { role: "dialog", "aria-modal": "true" }, "modal");
  }
  /** A menu: an overlay that is not modal. */
  function Menu() {
    useCoversContent(true);
    return createElement("div", { role: "menu" }, "menu");
  }

  beforeEach(() => {
    (window as Window & { __DIVE_LIVE_OVERLAYS__?: boolean }).__DIVE_LIVE_OVERLAYS__ = true;
    vi.spyOn(ipc, "setOverlayRegions").mockResolvedValue(null);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 10, y: 10, width: 20, height: 20 } as DOMRect);
    // A real capture, so the freeze path has something to show. An empty one
    // is the failed-capture case, covered by its own test below.
    vi.mocked(ipc.prepareContentCover).mockResolvedValue([{ tab_id: "t", data_url: "data:image/jpeg;base64,AA==" }]);
  });
  afterEach(() => {
    delete (window as Window & { __DIVE_LIVE_OVERLAYS__?: boolean }).__DIVE_LIVE_OVERLAYS__;
  });

  it("keeps Windows modals live and updates native input ownership through nested transitions", async () => {
    const view = render(createElement("div", null, createElement(Menu, { key: "m" })));
    await waitFor(() => expect(ipc.setOverlayRegions).toHaveBeenLastCalledWith(expect.any(Array), true, false));
    for (let attempt = 0; attempt < 2; attempt++) {
      view.rerender(createElement("div", null, createElement(Menu, { key: "m" }), createElement(Modal, { key: "d" })));
      await waitFor(() => expect(ipc.setOverlayRegions).toHaveBeenLastCalledWith(expect.any(Array), true, true));
      view.rerender(createElement("div", null, createElement(Menu, { key: "m" })));
      await waitFor(() => expect(ipc.setOverlayRegions).toHaveBeenLastCalledWith(expect.any(Array), true, false));
    }
    expect(ipc.prepareContentCover).not.toHaveBeenCalled();
    expect(ipc.setContentCovered).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(ipc.setOverlayRegions).toHaveBeenLastCalledWith([], false, false));
  });

  it("retains modal ownership until the last visible modal closes", async () => {
    const view = render(createElement("div", null, createElement(Modal, { key: "a" }), createElement(Modal, { key: "b" })));
    await waitFor(() => expect(ipc.setOverlayRegions).toHaveBeenLastCalledWith(expect.any(Array), true, true));
    view.rerender(createElement("div", null, createElement(Modal, { key: "b" })));
    await waitFor(() => expect(ipc.setOverlayRegions).toHaveBeenLastCalledWith([{ x: 10, y: 10, width: 20, height: 20 }], true, true));
    view.unmount();
    await waitFor(() => expect(ipc.setOverlayRegions).toHaveBeenLastCalledWith([], false, false));
    expect(ipc.prepareContentCover).not.toHaveBeenCalled();
    expect(ipc.setContentCovered).not.toHaveBeenCalled();
  });

  it("does not retain modal input ownership for a hidden or removed modal", async () => {
    const view = render(createElement(Menu));
    const stale = document.createElement("div");
    stale.setAttribute("aria-modal", "true");
    stale.style.visibility = "hidden";
    document.body.append(stale);
    await waitFor(() => expect(ipc.setOverlayRegions).toHaveBeenLastCalledWith(expect.any(Array), true, false));
    stale.style.visibility = "visible";
    await waitFor(() => expect(ipc.setOverlayRegions).toHaveBeenLastCalledWith(expect.any(Array), true, true));
    stale.setAttribute("aria-modal", "false");
    await waitFor(() => expect(ipc.setOverlayRegions).toHaveBeenLastCalledWith(expect.any(Array), true, false));
    stale.remove();
    view.unmount();
  });

  it("leaves the page live under a menu, so it keeps playing", async () => {
    render(createElement(Menu));
    await waitFor(() => expect(ipc.setOverlayRegions).toHaveBeenCalled());
    expect(ipc.prepareContentCover).not.toHaveBeenCalled();
    expect(ipc.setContentCovered).not.toHaveBeenCalled();
  });

  it("opens a modal over the live page without waiting on its renderer", async () => {
    vi.mocked(ipc.prepareContentCover).mockImplementation(() => new Promise(() => undefined));
    const view = render(createElement(Modal));
    await waitFor(() => expect(ipc.setOverlayRegions).toHaveBeenCalledWith(expect.any(Array), true, true));
    expect(ipc.prepareContentCover).not.toHaveBeenCalled();
    expect(ipc.setContentCovered).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(ipc.setOverlayRegions).toHaveBeenLastCalledWith([], false, false));
  });

  it("keeps nested modal reopenings live and releases the final native mask", async () => {
    const view = render(createElement("div", null, createElement(Menu, { key: "m" })));
    await waitFor(() => expect(ipc.setOverlayRegions).toHaveBeenCalledWith(expect.any(Array), true, false));
    for (let attempt = 0; attempt < 3; attempt++) {
      view.rerender(createElement("div", null, createElement(Menu, { key: "m" }), createElement(Modal, { key: "d" })));
      expect(contentCoverDepth()).toBe(2);
      view.rerender(createElement("div", null, createElement(Menu, { key: "m" })));
      expect(contentCoverDepth()).toBe(1);
    }
    expect(ipc.prepareContentCover).not.toHaveBeenCalled();
    expect(ipc.setContentCovered).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(ipc.setOverlayRegions).toHaveBeenLastCalledWith([], false, false));
  });
});

describe("what the native mask covers", () => {
  /** Give each element the rectangle the test names on it. */
  function withRects() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const [x, y, width, height] = (this.dataset.rect ?? "0,0,0,0").split(",").map(Number);
      return { x, y, width, height, left: x, top: y, right: x! + width!, bottom: y! + height!, toJSON: () => ({}) } as DOMRect;
    });
  }

  beforeEach(() => {
    resetOverlayElements();
    withRects();
  });
  afterEach(() => resetOverlayElements());

  it("covers a surface that escapes the card it lives in", () => {
    // The agent's composer is a marked card; the model panel opens upward,
    // out of it. Pruning by ancestry left the panel out of the mask, so the
    // page was painted where it should have been.
    document.body.innerHTML = `
      <div data-native-overlay data-rect="100,700,600,120">
        <div role="dialog" data-rect="110,500,300,180">panel</div>
      </div>`;
    const regions = visibleOverlayRegions();
    expect(regions).toContainEqual(expect.objectContaining({ x: 110, y: 500, width: 300, height: 180 }));
    expect(regions).toContainEqual(expect.objectContaining({ x: 100, y: 700, width: 600, height: 120 }));
  });

  it("says nothing twice about a surface wholly inside another", () => {
    document.body.innerHTML = `
      <div role="dialog" data-rect="0,0,400,400">
        <div role="menu" data-rect="10,10,100,100">inside</div>
      </div>`;
    expect(visibleOverlayRegions()).toEqual([expect.objectContaining({ x: 0, y: 0, width: 400, height: 400 })]);
  });

  it("leaves out what has no box to paint", () => {
    document.body.innerHTML = `<div role="dialog" data-rect="0,0,0,0">collapsed</div>`;
    expect(visibleOverlayRegions()).toEqual([]);
  });
});
