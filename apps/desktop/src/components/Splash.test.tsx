import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { SPLASH_DELAY_MS, Splash } from "./Splash";

beforeEach(() => {
  vi.useFakeTimers();
  useBrowser.setState({ ready: false });
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Splash", () => {
  it("never paints for a boot that completes inside the delay", () => {
    render(<Splash />);
    act(() => vi.advanceTimersByTime(SPLASH_DELAY_MS - 1));
    expect(screen.queryByText("Starting engine")).toBeNull();
    act(() => useBrowser.setState({ ready: true }));
    act(() => vi.runAllTimers());
    expect(screen.queryByText("Starting engine")).toBeNull();
  });

  it("appears only when startup actually takes time", () => {
    render(<Splash />);
    expect(screen.queryByText("Starting engine")).toBeNull();
    act(() => vi.advanceTimersByTime(SPLASH_DELAY_MS));
    expect(screen.getByText("Starting engine")).toBeTruthy();
  });
});
