import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DIALOG_FADE_MS, useFadeClose } from "./useFadeClose";

const original = window.matchMedia;

function answer(reduce: boolean) {
  window.matchMedia = vi.fn(
    (query: string) =>
      ({
        matches: reduce && query.includes("reduce"),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.matchMedia = original;
});

describe("useFadeClose", () => {
  it("plays the leave animation, then closes once, even if asked twice", () => {
    answer(false);
    const onClosed = vi.fn();
    const { result } = renderHook(() => useFadeClose(onClosed));
    expect(result.current.className).toBe("dialog-enter");
    act(() => result.current.close());
    act(() => result.current.close());
    expect(result.current.closing).toBe(true);
    expect(result.current.className).toBe("dialog-leave");
    expect(onClosed).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(DIALOG_FADE_MS));
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("closes at once under reduced motion", () => {
    answer(true);
    const onClosed = vi.fn();
    const { result } = renderHook(() => useFadeClose(onClosed));
    act(() => result.current.close());
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(result.current.closing).toBe(false);
  });

  it("drops a pending close when the dialog is unmounted first", () => {
    answer(false);
    const onClosed = vi.fn();
    const { result, unmount } = renderHook(() => useFadeClose(onClosed));
    act(() => result.current.close());
    unmount();
    act(() => void vi.advanceTimersByTime(DIALOG_FADE_MS * 2));
    expect(onClosed).not.toHaveBeenCalled();
  });
});
