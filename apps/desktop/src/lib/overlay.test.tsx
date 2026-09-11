import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "./ipc";
import { contentCoverDepth, resetContentCover, resetOverlayElements, useContentPreview, useCoversContent, visibleOverlayRegions } from "./overlay";

function Overlay({ active = true }: { active?: boolean }) {
  useCoversContent(active);
  return null;
}

function Preview() {
  const preview = useContentPreview("tab");
  return <output data-testid="preview">{preview ?? "none"}</output>;
}

afterEach(() => {
  cleanup();
  resetContentCover();
  resetOverlayElements();
  Reflect.deleteProperty(window, "__DIVE_LIVE_OVERLAYS__");
  vi.restoreAllMocks();
});

describe("useCoversContent", () => {
  it.each(["resolve", "reject"])("preserves the current preview when a previous uncover settles by %s", async (outcome) => {
    const uncovers: { resolve: (value: null) => void; reject: (error: Error) => void }[] = [];
    const covered = vi.spyOn(ipc, "setContentCovered").mockImplementation((value) => {
      if (value) return Promise.resolve(null);
      return new Promise<null>((resolve, reject) => uncovers.push({ resolve, reject }));
    });
    vi.spyOn(ipc, "prepareContentCover")
      .mockResolvedValueOnce([{ tab_id: "tab", data_url: "preview-a" }])
      .mockResolvedValueOnce([{ tab_id: "tab", data_url: "preview-b" }]);
    render(<Preview />);
    const first = render(<Overlay />);
    await waitFor(() => expect(covered.mock.calls).toEqual([[true]]));
    expect(screen.getByTestId("preview").textContent).toBe("preview-a");

    first.unmount();
    expect(uncovers).toHaveLength(1);
    const second = render(<Overlay />);
    await waitFor(() => expect(covered.mock.calls).toEqual([[true], [false], [true]]));
    expect(contentCoverDepth()).toBe(1);
    expect(screen.getByTestId("preview").textContent).toBe("preview-b");

    await act(async () => {
      if (outcome === "resolve") uncovers[0]!.resolve(null);
      else uncovers[0]!.reject(new Error("previous uncover failed"));
    });
    expect.soft(screen.getByTestId("preview").textContent).toBe("preview-b");

    // The current generation's final release still clears its preview even
    // when the engine rejects the uncover request.
    second.unmount();
    expect(contentCoverDepth()).toBe(0);
    expect(covered.mock.calls).toEqual([[true], [false], [true], [false]]);
    await act(async () => {
      if (outcome === "resolve") uncovers[1]!.resolve(null);
      else uncovers[1]!.reject(new Error("final uncover failed"));
    });
    expect(screen.getByTestId("preview").textContent).toBe("none");
  });

  it("captures the visible page before hiding the native view", async () => {
    let finishCapture!: (value: { tab_id: string; data_url: string }[]) => void;
    const capture = vi.fn(
      () =>
        new Promise<{ tab_id: string; data_url: string }[]>((resolve) => {
          finishCapture = resolve;
        }),
    );
    vi.spyOn(ipc, "prepareContentCover").mockImplementation(capture);
    const covered = vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);

    const view = render(<Overlay />);

    expect(capture).toHaveBeenCalledTimes(1);
    expect(covered).not.toHaveBeenCalled();

    await act(async () => finishCapture([{ tab_id: "tab-a", data_url: "data:image/jpeg;base64,real-page" }]));
    await waitFor(() => expect(covered).toHaveBeenCalledWith(true));

    view.unmount();
  });

  it("hides the page for as long as at least one overlay is on screen", async () => {
    vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
    const covered = vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);

    const first = render(<Overlay />);
    await waitFor(() => expect(covered.mock.calls).toEqual([[true]]));

    const second = render(<Overlay />);
    first.unmount();
    expect(covered.mock.calls).toEqual([[true]]);

    second.unmount();
    expect(covered.mock.calls).toEqual([[true], [false]]);
  });

  it("does not hide the page when the overlay closes before capture finishes", async () => {
    let finishCapture!: (value: []) => void;
    vi.spyOn(ipc, "prepareContentCover").mockImplementation(
      () =>
        new Promise<[]>((resolve) => {
          finishCapture = resolve;
        }),
    );
    const covered = vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);

    const view = render(<Overlay />);
    view.unmount();
    await act(async () => finishCapture([]));

    expect(covered).not.toHaveBeenCalled();
  });

  it("leaves the page alone for an overlay that is not showing", () => {
    vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
    const covered = vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);

    const view = render(<Overlay active={false} />);
    view.unmount();

    expect(covered).not.toHaveBeenCalled();
  });
});


describe("live native overlays", () => {
  it("keeps the renderer visible and sends live geometry without taking a screenshot", async () => {
    Object.defineProperty(window, "__DIVE_LIVE_OVERLAYS__", {value:true, configurable:true});
    const geometry = vi.spyOn(ipc, "setOverlayRegions").mockResolvedValue(null);
    const capture = vi.spyOn(ipc, "prepareContentCover");
    const hide = vi.spyOn(ipc, "setContentCovered");
    const view = render(<Overlay />);
    await waitFor(() => expect(geometry).toHaveBeenCalledWith([], true));
    expect(capture).not.toHaveBeenCalled();
    expect(hide).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(geometry).toHaveBeenLastCalledWith([], false));
    Reflect.deleteProperty(window, "__DIVE_LIVE_OVERLAYS__");
  });
  it("keeps nested overlays raised and serializes rapid close/reopen", async () => {
    Object.defineProperty(window, "__DIVE_LIVE_OVERLAYS__", {value:true, configurable:true});
    let finish!: (value: null) => void;
    const geometry = vi.spyOn(ipc, "setOverlayRegions").mockImplementationOnce(() => new Promise<null>((resolve) => { finish = resolve; })).mockResolvedValue(null);
    const first = render(<Overlay />);
    await waitFor(() => expect(geometry).toHaveBeenCalledTimes(1));
    const nested = render(<Overlay />);
    first.unmount();
    expect(contentCoverDepth()).toBe(1);
    nested.unmount();
    const reopened = render(<Overlay />);
    await act(async () => finish(null));
    await waitFor(() => expect(geometry.mock.calls).toEqual([[[], true], [[], true]]));
    reopened.unmount();
    await waitFor(() => expect(geometry).toHaveBeenLastCalledWith([], false));
    expect(contentCoverDepth()).toBe(0);
  });
  it("uses the dialog surface once, not its nested menus or full-window scrim", () => {
    const {container} = render(<div><div role="dialog"><div role="menu" /></div></div>);
    const dialog = container.querySelector('[role="dialog"]')!;
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({x:100,y:90,width:340,height:500} as DOMRect);
    expect(visibleOverlayRegions()).toEqual([{x:100,y:90,width:340,height:500}]);
  });
});

describe("what counts as an overlay", () => {
  // These append to the body directly, which `cleanup()` does not undo.
  afterEach(() => {
    document.body.innerHTML = "";
    resetOverlayElements();
  });

  // A region is what actually masks the page. Covering content without one
  // sends an empty list, the whole page stays on top, and the element is drawn
  // behind it -- which is how every JS dialog, toast and tooltip went missing
  // while their own tests passed on `contentCoverDepth() === 1` alone.
  const box = { x: 10, y: 20, width: 300, height: 100 };

  function measured(role: string, extra: Record<string, string> = {}) {
    const el = document.createElement("div");
    for (const [k, v] of Object.entries({ role, ...extra })) el.setAttribute(k, v);
    el.getBoundingClientRect = () => ({ ...box, top: box.y, left: box.x, right: box.x + box.width, bottom: box.y + box.height, toJSON: () => "" });
    document.body.append(el);
    resetOverlayElements();
    return el;
  }

  it.each([
    ["dialog", "a modal"],
    ["alertdialog", "a page's alert(), which pauses the renderer until answered"],
    ["menu", "a chrome menu"],
    ["listbox", "the address bar's suggestions"],
    ["tooltip", "a tip beside a toolbar button"],
  ])("masks the page under role=%s (%s)", (role) => {
    measured(role);
    expect(visibleOverlayRegions()).toEqual([box]);
  });

  it("masks the page under an element that only carries the data attribute", () => {
    const el = document.createElement("div");
    el.dataset.nativeOverlay = "";
    el.getBoundingClientRect = () => ({ ...box, top: box.y, left: box.x, right: box.x + box.width, bottom: box.y + box.height, toJSON: () => "" });
    document.body.append(el);
    resetOverlayElements();
    expect(visibleOverlayRegions()).toEqual([box]);
  });

  it.each(["status", "alert", "log"])("leaves role=%s alone: those are chrome's own layout, not overlays", (role) => {
    measured(role);
    expect(visibleOverlayRegions()).toEqual([]);
  });

  it("drops a hidden overlay, and one that measures nothing", () => {
    const hidden = measured("dialog");
    hidden.style.visibility = "hidden";
    expect(visibleOverlayRegions()).toEqual([]);

    hidden.remove();
    const empty = document.createElement("div");
    empty.setAttribute("role", "dialog");
    empty.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => "" });
    document.body.append(empty);
    resetOverlayElements();
    expect(visibleOverlayRegions()).toEqual([]);
  });

  it("reports a nested overlay once, as the outer element", () => {
    const outer = measured("dialog");
    const inner = document.createElement("div");
    inner.setAttribute("role", "menu");
    outer.append(inner);
    resetOverlayElements();
    expect(visibleOverlayRegions()).toEqual([box]);
  });
});
