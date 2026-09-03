import { act, cleanup, render } from "@testing-library/react";
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
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useCoversContent", () => {
  it("hides the page while mounted active and shows it again on unmount", () => {
    const view = render(createElement(Cover, { active: true }));
    expect(contentCoverDepth()).toBe(1);
    expect(ipc.setContentCovered).toHaveBeenLastCalledWith(true);

    act(() => view.unmount());
    expect(contentCoverDepth()).toBe(0);
    expect(ipc.setContentCovered).toHaveBeenLastCalledWith(false);
  });

  it("never touches the page for an inactive overlay", () => {
    render(createElement(Cover, { active: false }));
    expect(contentCoverDepth()).toBe(0);
    expect(ipc.setContentCovered).not.toHaveBeenCalled();
  });

  it("tells the engine once for a stack of overlays, not once each", () => {
    const view = render(createElement("div", null, createElement(Cover, { active: true, key: "a" }), createElement(Cover, { active: true, key: "b" })));
    expect(contentCoverDepth()).toBe(2);
    expect(ipc.setContentCovered).toHaveBeenCalledTimes(1);

    // The page stays hidden until the last overlay lets go.
    act(() => view.unmount());
    expect(contentCoverDepth()).toBe(0);
    expect(ipc.setContentCovered).toHaveBeenCalledTimes(2);
    expect(ipc.setContentCovered).toHaveBeenLastCalledWith(false);
  });

  it("releases the page when an overlay goes inactive without unmounting", () => {
    const view = render(createElement(Cover, { active: true }));
    expect(contentCoverDepth()).toBe(1);

    act(() => view.rerender(createElement(Cover, { active: false })));
    expect(contentCoverDepth()).toBe(0);
    expect(ipc.setContentCovered).toHaveBeenLastCalledWith(false);
  });
});
