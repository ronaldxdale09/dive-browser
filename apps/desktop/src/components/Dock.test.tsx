import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleEntry } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { useConsole } from "../store/console";
import { useNetwork } from "../store/network";
import { Dock } from "./Dock";

const entry = (i: number, text = `line ${i}`, level: ConsoleEntry["level"] = "info"): ConsoleEntry => ({
  tab_id: "tab-1",
  level,
  text,
  source: "console",
  url: null,
  line: null,
  column: null,
  timestamp: i,
});
const push = (entries: ConsoleEntry[]) => act(() => entries.forEach((e) => useConsole.getState().push(e)));

// jsdom has no layout; the virtualizer measures through offsetHeight.
const VIEWPORT = 400;
const ROW = 25;
const original = {
  height: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
  width: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
  scrollTo: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo"),
};
const initialBrowser = useBrowser.getState();

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-index") ? ROW : VIEWPORT;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, writable: true, value: vi.fn() });
  useBrowser.setState({ activeTab: "tab-1" });
  useConsole.setState({ byTab: {} });
  useNetwork.setState({ byTab: {}, frames: {} });
});

afterEach(() => {
  cleanup();
  for (const [name, desc] of Object.entries(original)) {
    if (desc) Object.defineProperty(HTMLElement.prototype, name === "height" ? "offsetHeight" : name === "width" ? "offsetWidth" : "scrollTo", desc);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name === "scrollTo" ? "scrollTo" : name];
  }
  useBrowser.setState(initialBrowser, true);
  useConsole.setState({ byTab: {} });
  vi.restoreAllMocks();
});

const mountedRows = (container: HTMLElement) => container.querySelectorAll("[data-index]");

describe("Dock console panel", () => {
  it("opens on the console and renders the active tab's entries", () => {
    push([entry(1, "first line"), entry(2, "second line", "error")]);
    render(<Dock />);
    expect(screen.getByRole("button", { name: "Console" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("first line")).toBeTruthy();
    expect(screen.getByText("second line")).toBeTruthy();
    expect(screen.getByText("second line").parentElement?.className).toContain("text-danger");
    expect(screen.queryByText("No console output yet.")).toBeNull();
  });

  it("explains the empty states", () => {
    render(<Dock />);
    expect(screen.getByText("No console output yet.")).toBeTruthy();
    cleanup();
    useBrowser.setState({ activeTab: null });
    render(<Dock />);
    expect(screen.getByText("Open a tab to see its console.")).toBeTruthy();
  });

  it("filters entries by text, case-insensitively", () => {
    push([entry(1, "fetch ok"), entry(2, "TypeError: boom"), entry(3, "fetch retry")]);
    const { container } = render(<Dock />);
    fireEvent.change(screen.getByLabelText("Filter console"), { target: { value: "FETCH" } });
    expect(mountedRows(container)).toHaveLength(2);
    expect(screen.queryByText("TypeError: boom")).toBeNull();
    fireEvent.change(screen.getByLabelText("Filter console"), { target: { value: "" } });
    expect(mountedRows(container)).toHaveLength(3);
  });

  it("mounts only a window of rows for 500 entries", () => {
    push(Array.from({ length: 500 }, (_, i) => entry(i)));
    const { container } = render(<Dock />);
    const mounted = mountedRows(container).length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(100);
    const list = screen.getByTestId("console-scroll").firstElementChild as HTMLElement;
    expect(parseInt(list.style.height, 10)).toBe(500 * ROW);
  });

  it("follows new output only while the user is at the bottom", () => {
    push([entry(1)]);
    render(<Dock />);
    const scroll = screen.getByTestId("console-scroll");
    const scrollTo = HTMLElement.prototype.scrollTo as unknown as ReturnType<typeof vi.fn>;
    scrollTo.mockClear();

    push([entry(2)]);
    expect(scrollTo).toHaveBeenCalled();

    // Scroll up to read older output: new entries no longer pull the view along.
    Object.defineProperty(scroll, "scrollHeight", { configurable: true, get: () => 5000 });
    Object.defineProperty(scroll, "clientHeight", { configurable: true, get: () => VIEWPORT });
    scroll.scrollTop = 0;
    fireEvent.scroll(scroll);
    scrollTo.mockClear();
    push([entry(3)]);
    expect(scrollTo).not.toHaveBeenCalled();

    // Back at the end, following resumes.
    scroll.scrollTop = 5000 - VIEWPORT;
    fireEvent.scroll(scroll);
    push([entry(4)]);
    expect(scrollTo).toHaveBeenCalled();
  });

  it("ignores console output for other tabs", () => {
    push([entry(1, "mine")]);
    render(<Dock />);
    push([{ ...entry(2, "theirs"), tab_id: "tab-2" }]);
    expect(screen.getByText("mine")).toBeTruthy();
    expect(screen.queryByText("theirs")).toBeNull();
  });

  it("switches to the network panel", () => {
    render(<Dock />);
    fireEvent.click(screen.getByRole("button", { name: "Network" }));
    expect(screen.getByText("No requests yet.")).toBeTruthy();
    expect(screen.getByLabelText("Filter requests")).toBeTruthy();
  });
});
