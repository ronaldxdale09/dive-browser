import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "./ipc";
import { contentCoverDepth, resetContentCover, useCoversContent } from "./overlay";

/** A component whose only job is to hold the cover while `active`. */
function Cover({ active }: { active: boolean }) {
  useCoversContent(active);
  return null;
}

beforeEach(() => {
  resetContentCover();
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
    // A real capture, so the freeze path has something to show. An empty one
    // is the failed-capture case, covered by its own test below.
    vi.mocked(ipc.prepareContentCover).mockResolvedValue([{ tab_id: "t", data_url: "data:image/jpeg;base64,AA==" }]);
  });
  afterEach(() => {
    delete (window as Window & { __DIVE_LIVE_OVERLAYS__?: boolean }).__DIVE_LIVE_OVERLAYS__;
  });

  it("leaves the page live under a menu, so it keeps playing", async () => {
    render(createElement(Menu));
    await waitFor(() => expect(ipc.setOverlayRegions).toHaveBeenCalled());
    expect(ipc.prepareContentCover).not.toHaveBeenCalled();
    expect(ipc.setContentCovered).not.toHaveBeenCalled();
  });

  it("freezes the page under a modal, so the backdrop has something to blur", async () => {
    // The native mask is a rectangle over a view CSS cannot reach: no blur is
    // possible against it, and a rounded panel sits in a square of chrome.
    // A capture inside the chrome is a real surface, so both work.
    render(createElement(Modal));
    await waitFor(() => expect(ipc.setContentCovered).toHaveBeenLastCalledWith(true));
    expect(ipc.prepareContentCover).toHaveBeenCalledTimes(1);
  });

  it("switches a live page to frozen when a modal opens over a menu", async () => {
    const view = render(createElement("div", null, createElement(Menu, { key: "m" })));
    await waitFor(() => expect(ipc.setOverlayRegions).toHaveBeenCalled());

    view.rerender(createElement("div", null, createElement(Menu, { key: "m" }), createElement(Modal, { key: "d" })));
    await waitFor(() => expect(ipc.setContentCovered).toHaveBeenLastCalledWith(true));
    expect(ipc.prepareContentCover).toHaveBeenCalledTimes(1);
  });

  it("keeps the page live under a modal when the capture comes back empty", async () => {
    // A capture that fails or times out -- a busy renderer, a playing video.
    // The page must not be hidden with nothing to replace it (a black screen
    // behind the blur that only closing the dialog clears). It stays live
    // under the mask instead.
    vi.mocked(ipc.prepareContentCover).mockResolvedValue([]);
    render(createElement(Modal));
    await waitFor(() => expect(ipc.prepareContentCover).toHaveBeenCalled());
    await waitFor(() => expect(ipc.setOverlayRegions).toHaveBeenCalled());
    expect(ipc.setContentCovered).not.toHaveBeenCalledWith(true);
  });
});
