import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prefersReducedMotion, useReducedMotion } from "./useReducedMotion";

/** A matchMedia whose "reduce" answer can be flipped, firing its change listeners. */
function fakeMatchMedia() {
  const listeners = new Set<() => void>();
  const query = {
    matches: false,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: (_: string, cb: () => void) => void listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => void listeners.delete(cb),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  } as unknown as MediaQueryList & { matches: boolean };
  const set = (matches: boolean) => {
    query.matches = matches;
    for (const cb of listeners) cb();
  };
  return { query, set, listeners };
}

let media: ReturnType<typeof fakeMatchMedia>;
const original = window.matchMedia;

beforeEach(() => {
  media = fakeMatchMedia();
  window.matchMedia = vi.fn(() => media.query);
});

afterEach(() => {
  cleanup();
  window.matchMedia = original;
});

describe("useReducedMotion", () => {
  it("reports the current preference and follows it when it changes", () => {
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
    act(() => media.set(true));
    expect(result.current).toBe(true);
    act(() => media.set(false));
    expect(result.current).toBe(false);
  });

  it("subscribes once per mount and lets go on unmount", () => {
    function Probe() {
      return <span>{useReducedMotion() ? "still" : "moving"}</span>;
    }
    const view = render(<Probe />);
    expect(screen.getByText("moving")).toBeTruthy();
    expect(media.listeners.size).toBe(1);
    view.unmount();
    expect(media.listeners.size).toBe(0);
  });

  it("answers outside React too, and says no when matchMedia is missing", () => {
    media.set(true);
    expect(prefersReducedMotion()).toBe(true);
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    expect(prefersReducedMotion()).toBe(false);
  });
});
