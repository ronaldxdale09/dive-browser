import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { events, ipc } from "../lib/ipc";
import { DEFAULT_PREFS, usePrefs } from "../store/prefs";
import { Welcome, visibleDevServers } from "./Welcome";

// The feature reel is a Remotion Player with its own tests; jsdom cannot
// drive it and this test is about the background layer.
const reelState = vi.hoisted(() => ({ broken: false }));
vi.mock("./FeatureReel", () => ({ FeatureReel: () => {
  if (reelState.broken) throw Error("tour failed");
  return <div data-testid="feature-tour-player" />;
} }));

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
  reelState.broken = false;
  usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });
  vi.restoreAllMocks();
});

describe("Welcome", () => {
  it.each([
    { motion: "system", osReduced: false, moves: true },
    { motion: "system", osReduced: true, moves: false },
    { motion: "reduce", osReduced: false, moves: false },
    { motion: "full", osReduced: true, moves: true },
  ])("globe motion follows $motion with OS reduced motion=$osReduced", ({ motion, osReduced, moves }) => {
    // Exercise the real globe renderer; jsdom lacks Canvas 2D and a compositor.
    const arcs: number[][] = [];
    const context = {
      setTransform() {}, clearRect() { arcs.length = 0; }, beginPath() {}, fill() {},
      arc(x: number, y: number, radius: number) { arcs.push([x, y, radius]); },
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(window, "matchMedia").mockImplementation((media) => ({
      matches: media.includes("prefers-reduced-motion") && osReduced, media,
      addEventListener() {}, removeEventListener() {},
    }) as unknown as MediaQueryList);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    let sequence = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(++sequence, callback);
      return sequence;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
    const paint = (time: number) => act(() => {
      const ready = [...frames.values()];
      frames.clear();
      ready.forEach((callback) => callback(time));
    });
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, motion }, loaded: true });
    const view = render(<Welcome />);
    const start = performance.now();
    paint(start + 20);
    expect(arcs.length).toBeGreaterThan(0);
    const initial = JSON.stringify(arcs);
    paint(start + 60);
    expect(JSON.stringify(arcs) !== initial).toBe(moves);
    view.unmount();
  });

  it("contains a broken tour while browsing controls remain usable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    reelState.broken = true;
    render(<Welcome />);
    fireEvent.click(screen.getByRole("button", { name: "Watch the feature tour" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("You can keep browsing"));
    expect(screen.getByRole("button", { name: /Open a tab/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide tour" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("mounts the tour only on request and removes it when hidden", async () => {
    render(<Welcome />);
    expect(screen.queryByTestId("feature-tour-player")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Watch the feature tour" }));
    await waitFor(() => expect(screen.getByTestId("feature-tour-player")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Hide tour" }));
    expect(screen.queryByTestId("feature-tour-player")).toBeNull();
  });

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
