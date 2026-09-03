import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { events, ipc } from "../lib/ipc";
import { Welcome } from "./Welcome";

// The feature reel is a Remotion Player with its own tests; jsdom cannot
// drive it and this test is about the background layer.
vi.mock("./FeatureReel", () => ({ FeatureReel: () => null }));

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

class IntersectionObserverStub {
  observe() {}
  disconnect() {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverStub);
vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
vi.stubGlobal("matchMedia", (media: string) => ({
  matches: false,
  media,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => true,
}));
vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

beforeEach(() => {
  vi.spyOn(ipc, "devServersWatch").mockResolvedValue([]);
  vi.spyOn(ipc, "devServers").mockResolvedValue([]);
  vi.spyOn(events.devServersChanged, "listen").mockResolvedValue(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Welcome", () => {
  it("releases the dev-server listener even when it resolves after unmount", async () => {
    const unlisten = vi.fn();
    let resolveListen: (u: () => void) => void = () => undefined;
    vi.spyOn(events.devServersChanged, "listen").mockReturnValue(
      new Promise((resolve) => {
        resolveListen = resolve;
      }),
    );

    const { unmount } = render(<Welcome />);
    unmount();
    resolveListen(unlisten);
    await Promise.resolve();

    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(ipc.devServersWatch).toHaveBeenLastCalledWith(false);
  });

  it("renders its animated text background as a subtle decorative layer", () => {
    render(<Welcome />);

    const background = screen.getByTestId("character-background");
    expect(background.getAttribute("aria-hidden")).toBe("true");
    expect(background.style.opacity).toBe("0.04");
    expect(background.style.position).toBe("absolute");
  });
});
