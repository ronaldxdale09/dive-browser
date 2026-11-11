import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeRoot, preloadChrome, resetChromePreload } from "./ChromeRoot";
import { bootTimeline, resetBootMarks } from "../lib/bootMarks";
import { ChromeErrorBoundary } from "./ChromeErrorBoundary";

vi.mock("../App", () => ({ App: () => <div>Main controls</div> }));
vi.mock("./Popout", () => ({ Popout: ({ tabId }: { tabId: string }) => <div>Popout {tabId}</div> }));

afterEach(() => { cleanup(); vi.useRealTimers(); resetChromePreload(); resetBootMarks(); });

describe("window chrome loading", () => {
  it("shows main controls as soon as the module resolves, without advancing a 300 ms timer", async () => {
    vi.useFakeTimers();
    render(<ChromeRoot tabId={null} />);
    expect(screen.getByLabelText("Loading Dive")).toBeTruthy();
    await act(() => vi.dynamicImportSettled());
    expect(screen.getByText("Main controls")).toBeTruthy();
    expect(screen.queryByLabelText("Loading Dive")).toBeNull();
  });

  it("loads the detached window with its exact tab identity", async () => {
    render(<ChromeRoot tabId="tab-detached-17" />);
    await act(() => vi.dynamicImportSettled());
    expect(screen.getByText("Popout tab-detached-17")).toBeTruthy();
    expect(screen.queryByText("Main controls")).toBeNull();
  });

  it("can unmount while the import is pending", async () => {
    const { unmount } = render(<ChromeErrorBoundary><ChromeRoot tabId={null} /></ChromeErrorBoundary>);
    unmount();
    await act(() => vi.dynamicImportSettled());
    expect(screen.queryByText("Main controls")).toBeNull();
  });

  it("shows main controls at once when the module was preloaded before render", async () => {
    void preloadChrome(null);
    await act(() => vi.dynamicImportSettled());
    render(<ChromeRoot tabId={null} />);
    await act(() => vi.dynamicImportSettled());
    expect(screen.getByText("Main controls")).toBeTruthy();
  });

  it("records app_module_loaded when a preload resolves, before any render", async () => {
    resetBootMarks();
    void preloadChrome(null);
    await act(() => vi.dynamicImportSettled());
    expect(bootTimeline()).toHaveProperty("app_module_loaded");
    expect(bootTimeline()).not.toHaveProperty("app_rendered");
  });

  it("a preload for a detached window does not load the main controls", async () => {
    void preloadChrome("tab-9");
    render(<ChromeRoot tabId="tab-9" />);
    await act(() => vi.dynamicImportSettled());
    expect(screen.getByText("Popout tab-9")).toBeTruthy();
    expect(screen.queryByText("Main controls")).toBeNull();
  });
});
