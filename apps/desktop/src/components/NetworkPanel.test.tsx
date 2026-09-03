import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useBrowser } from "../store/browser";
import { useNetwork } from "../store/network";
import type { RequestRow } from "../store/network";
import { NetworkPanel } from "./NetworkPanel";

const row = (i: number): RequestRow => ({
  id: `r${i}`,
  url: `https://a.dev/api/item-${i}`,
  method: "GET",
  resourceType: "Fetch",
  status: 200,
  mimeType: "application/json",
  fromCache: false,
  size: 100,
  error: null,
  startedAt: i,
  durationMs: 12,
});
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i));

// jsdom has no layout. The virtualizer measures the scroll container and each
// row through offsetHeight; give the container a viewport and rows a height so
// only a window of rows is in view.
const VIEWPORT = 400;
const ROW = 21;
const original = {
  height: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
  width: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
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
  useBrowser.setState({ activeTab: "tab-1" });
  useNetwork.setState({ byTab: {}, frames: {} });
});

afterEach(() => {
  cleanup();
  if (original.height) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original.height);
  if (original.width) Object.defineProperty(HTMLElement.prototype, "offsetWidth", original.width);
  useBrowser.setState(initialBrowser, true);
  useNetwork.setState({ byTab: {}, frames: {} });
});

const mountedRows = (container: HTMLElement) => container.querySelectorAll("tr[data-index]");

describe("NetworkPanel", () => {
  it("renders the active tab's requests with a summary line", () => {
    useNetwork.setState({ byTab: { "tab-1": rows(3) } });
    render(<NetworkPanel />);
    expect(screen.getByText("3 requests")).toBeTruthy();
    expect(screen.getByText("300 B transferred")).toBeTruthy();
    for (const i of [0, 1, 2]) expect(screen.getByText(`item-${i}`)).toBeTruthy();
    expect(screen.queryByText("No requests yet.")).toBeNull();
  });

  it("explains the empty states", () => {
    render(<NetworkPanel />);
    expect(screen.getByText("No requests yet.")).toBeTruthy();
    cleanup();
    useBrowser.setState({ activeTab: null });
    render(<NetworkPanel />);
    expect(screen.getByText("Open a tab to see its traffic.")).toBeTruthy();
  });

  it("selects a row on click, opens its detail strip and toggles it back off", () => {
    useNetwork.setState({ byTab: { "tab-1": rows(3) } });
    render(<NetworkPanel />);
    const tr = screen.getByText("item-1").closest("tr")!;
    expect(tr.getAttribute("aria-selected")).toBe("false");
    expect(screen.queryByRole("button", { name: /Replay/ })).toBeNull();

    fireEvent.click(tr);
    expect(tr.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: /Replay/ })).toBeTruthy();
    expect(screen.getByText("https://a.dev/api/item-1", { exact: false })).toBeTruthy();

    fireEvent.click(screen.getByText("item-1").closest("tr")!);
    expect(screen.queryByRole("button", { name: /Replay/ })).toBeNull();
  });

  it("filters rows by URL", () => {
    useNetwork.setState({ byTab: { "tab-1": rows(3) } });
    const { container } = render(<NetworkPanel />);
    fireEvent.change(screen.getByLabelText("Filter requests"), { target: { value: "ITEM-2" } });
    expect(mountedRows(container)).toHaveLength(1);
    expect(screen.getByText("item-2")).toBeTruthy();
    // The summary still describes the whole capture.
    expect(screen.getByText("3 requests")).toBeTruthy();
  });

  it("mounts only a window of rows when given 1000 requests", () => {
    useNetwork.setState({ byTab: { "tab-1": rows(1000) } });
    const { container } = render(<NetworkPanel />);
    expect(screen.getByText("1000 requests")).toBeTruthy();
    const mounted = mountedRows(container).length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(100);
    expect(screen.getByText("item-0")).toBeTruthy();
    expect(screen.queryByText("item-999")).toBeNull();
    // Everything out of view is stood in for by a spacer so the scrollbar spans the whole list.
    const spacer = container.querySelector("tbody tr[aria-hidden]") as HTMLTableRowElement | null;
    expect(spacer).not.toBeNull();
    expect(parseInt(spacer!.style.height, 10)).toBeGreaterThan(ROW * 800);
  });

  it("keeps rows of the active tab when another tab receives traffic", () => {
    useNetwork.setState({ byTab: { "tab-1": rows(2) } });
    render(<NetworkPanel />);
    useNetwork.getState().apply({
      type: "sent",
      data: { tab_id: "tab-2", request_id: "x", url: "https://b.dev", method: "GET", resource_type: "Fetch", headers: {}, post_data: null, timestamp: 1, wall_time: 1 },
    });
    expect(screen.getByText("2 requests")).toBeTruthy();
    expect(screen.queryByText("b.dev")).toBeNull();
  });
});
