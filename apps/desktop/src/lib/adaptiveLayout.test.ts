import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chromeLayoutForWidth, useChromeLayout, useViewportSize } from "./adaptiveLayout";

afterEach(() => cleanup());

describe("chromeLayoutForWidth", () => {
  it("keeps the full chrome when the window has room", () => {
    expect(chromeLayoutForWidth(1280)).toEqual({ collapseRail: false, compactToolbar: false, singleAuxPanel: false });
  });

  it("protects the page from overflow at the minimum supported width", () => {
    expect(chromeLayoutForWidth(720)).toEqual({ collapseRail: true, compactToolbar: true, singleAuxPanel: true });
  });

  it("compacts auxiliary panels before the primary toolbar", () => {
    expect(chromeLayoutForWidth(880)).toEqual({ collapseRail: true, compactToolbar: false, singleAuxPanel: true });
  });

  it("does not rerender the chrome while resizing inside one breakpoint", () => {
    const original = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 1280, writable: true, configurable: true });
    let renders = 0;
    const view = renderHook(() => {
      renders += 1;
      return useChromeLayout();
    });

    act(() => {
      window.innerWidth = 1200;
      window.dispatchEvent(new Event("resize"));
    });
    expect(renders).toBe(1);

    act(() => {
      window.innerWidth = 800;
      window.dispatchEvent(new Event("resize"));
    });
    expect(renders).toBe(2);
    expect(view.result.current).toEqual({ collapseRail: true, compactToolbar: true, singleAuxPanel: true });
    Object.defineProperty(window, "innerWidth", { value: original, writable: true, configurable: true });
  });
});

describe("useViewportSize", () => {
  it("ignores resizes while inactive and catches up once active again", () => {
    const original = window.innerHeight;
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const runFrames = () => act(() => { frames.splice(0).forEach((cb) => cb(0)); });
    Object.defineProperty(window, "innerHeight", { value: 800, writable: true, configurable: true });
    let renders = 0;
    const view = renderHook(({ active }) => {
      renders += 1;
      return useViewportSize(active);
    }, { initialProps: { active: false } });

    act(() => {
      window.innerHeight = 600;
      window.dispatchEvent(new Event("resize"));
    });
    runFrames();
    expect(renders).toBe(1);
    expect(view.result.current.height).toBe(800);

    view.rerender({ active: true });
    runFrames();
    expect(view.result.current.height).toBe(600);
    act(() => {
      window.innerHeight = 500;
      window.dispatchEvent(new Event("resize"));
    });
    runFrames();
    expect(view.result.current.height).toBe(500);
    vi.restoreAllMocks();
    Object.defineProperty(window, "innerHeight", { value: original, writable: true, configurable: true });
  });
});
