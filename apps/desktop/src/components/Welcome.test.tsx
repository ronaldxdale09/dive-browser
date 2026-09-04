import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { events, ipc } from "../lib/ipc";
import { DEFAULT_PREFS, usePrefs } from "../store/prefs";
import { Welcome, visibleDevServers } from "./Welcome";

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
  usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });
  vi.restoreAllMocks();
});

describe("Welcome", () => {
  it("prioritizes recognized tools and caps the initial server list", () => {
    const servers = [
      { port: 9334, url: "http://localhost:9334", framework: "HTTP", title: "", process: "node", pid: 1 },
      { port: 3000, url: "http://localhost:3000", framework: "Next.js", title: "App", process: "node", pid: 2 },
      { port: 5173, url: "http://localhost:5173", framework: "Vite", title: "UI", process: "node", pid: 3 },
      { port: 4173, url: "http://localhost:4173", framework: "Vite preview", title: "", process: "node", pid: 4 },
    ];

    expect(visibleDevServers(servers, false).map((server) => server.port)).toEqual([3000, 5173, 4173]);
    expect(visibleDevServers(servers, true)).toHaveLength(4);
  });

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

  it("drops the canvas layers for a plain background", () => {
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, welcome_background: "plain" }, loaded: true });
    const { container } = render(<Welcome />);
    expect(screen.queryByTestId("character-background")).toBeNull();
    expect(container.querySelector("canvas")).toBeNull();
    const root = container.querySelector(".welcome")!;
    expect(root.getAttribute("data-background")).toBe("plain");
    expect(root.className).not.toContain("welcome-gradient");
  });

  it("draws a CSS gradient instead of the canvas for the gradient background", () => {
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, welcome_background: "gradient" }, loaded: true });
    const { container } = render(<Welcome />);
    expect(screen.queryByTestId("character-background")).toBeNull();
    expect(container.querySelector("canvas")).toBeNull();
    expect(container.querySelector(".welcome")!.className).toContain("welcome-gradient");
  });

  it("keeps the orbs and character field by default", () => {
    const { container } = render(<Welcome />);
    expect(screen.getByTestId("character-background")).toBeTruthy();
    expect(container.querySelector("canvas")).not.toBeNull();
  });
});
