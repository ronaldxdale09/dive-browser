import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { StoragePanel } from "./StoragePanel";

// jsdom has no layout; the virtualizer measures rows through offsetHeight.
const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");

const tab = { id: "t1", workspace_id: "w1", url: "https://a.test/", title: "A", favicon: null, tier: "today", position: 0, state: "active", last_active_at: "" } as unknown as Tab;
const initial = useBrowser.getState();

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-index") ? 25 : 400;
    },
  });
  useBrowser.setState({ tabs: [tab], activeTab: "t1", loading: {} });
  vi.spyOn(ipc, "tabStorage").mockResolvedValue({
    cookies: [
      { name: "session", value: "abc", size: 3, domain: "a.test", path: "/", expires: -1, http_only: true, secure: true, same_site: "Lax" },
      { name: "session", value: "other", size: 5, domain: "b.a.test", path: "/app", expires: -1, http_only: false, secure: false, same_site: null },
    ],
    local: [
      { key: "theme", value: "dark", size: 4 },
      { key: "blob", value: "x".repeat(2048), size: 90_000 },
    ],
    session: [],
  });
});

afterEach(() => {
  cleanup();
  if (originalHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalHeight);
  useBrowser.setState(initial, true);
  vi.restoreAllMocks();
});

describe("StoragePanel", () => {
  it("does not count a detached tab's cookies as this window's dock", () => {
    useBrowser.setState({ tabs: [tab], activeTab: "t1", detached: ["t1"], loading: {} });
    render(<StoragePanel />);
    expect(screen.getByText("Open a tab to inspect its storage.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cookies (2)" })).toBeNull();
    expect(ipc.tabStorage).not.toHaveBeenCalled();
  });

  it("heads the columns and explains a cookie's flags, then switches to local storage", async () => {
    render(<StoragePanel />);
    expect((await screen.findAllByText("session")).length).toBe(2);
    expect(screen.getByText("Domain · path · flags")).toBeTruthy();
    expect(screen.getByText("a.test/ · HttpOnly · Secure · Lax")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Local (2)" }));
    expect(screen.getByText("Key")).toBeTruthy();
    expect(screen.getByText("theme")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Session (0)" }));
    expect(screen.getByText("Nothing stored.")).toBeTruthy();
    expect(screen.queryByText("Key")).toBeNull();
  });

  it("does not keep the last cookie count when this tab is sleeping", async () => {
    render(<StoragePanel />);
    expect(await screen.findByRole("button", { name: "Cookies (2)" })).toBeTruthy();
    await act(async () => {
      useBrowser.setState({ tabs: [{ ...tab, state: "discarded" }], activeTab: "t1" });
    });
    expect(screen.queryByRole("button", { name: "Cookies (2)" })).toBeNull();
    expect(screen.getByText(/sleeping/i)).toBeTruthy();
  });

  it("does not show the page it left while the new one is read", async () => {
    render(<StoragePanel />);
    expect(await screen.findByRole("button", { name: "Cookies (2)" })).toBeTruthy();
    vi.mocked(ipc.tabStorage).mockReturnValue(new Promise(() => undefined));
    await act(async () => {
      useBrowser.setState({ tabs: [{ ...tab, url: "https://b.test/" }] });
    });
    expect(screen.queryByRole("button", { name: "Cookies (2)" })).toBeNull();
    expect(screen.getByText("Reading…")).toBeTruthy();
  });
});

describe("StoragePanel deletes", () => {
  it("removes a cookie by name, domain and path, and a storage key by name, then reads again", async () => {
    const del = vi.spyOn(ipc, "tabStorageDelete").mockResolvedValue(null as never);
    render(<StoragePanel />);
    await screen.findAllByText("session");
    const reads = vi.mocked(ipc.tabStorage).mock.calls.length;
    // Two cookies share the name; each row deletes its own, not the first
    // one whose domain happens to start the same way.
    const [first, second] = screen.getAllByRole("button", { name: "Delete session" });
    fireEvent.click(second!);
    expect(del).toHaveBeenCalledWith("t1", "cookies", "session", "b.a.test", "/app");
    fireEvent.click(first!);
    expect(del).toHaveBeenCalledWith("t1", "cookies", "session", "a.test", "/");
    await vi.waitFor(() => expect(vi.mocked(ipc.tabStorage).mock.calls.length).toBeGreaterThan(reads));
    fireEvent.click(screen.getByRole("button", { name: "Local (2)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete theme" }));
    expect(del).toHaveBeenCalledWith("t1", "local", "theme", null, null);
  });
});

describe("StoragePanel values", () => {
  it("says it is reading rather than that nothing is stored", () => {
    vi.mocked(ipc.tabStorage).mockReturnValue(new Promise(() => undefined));
    render(<StoragePanel />);
    expect(screen.getByText("Reading…")).toBeTruthy();
    expect(screen.queryByText("Nothing stored.")).toBeNull();
  });

  it("shows a long value's size and copies all of it, not the part on screen", async () => {
    const full = vi.spyOn(ipc, "tabStorageValue").mockResolvedValue("x".repeat(90_000));
    const write = vi.spyOn(ipc, "clipboardWriteText").mockResolvedValue(null as never);
    render(<StoragePanel />);
    await screen.findAllByText("session");
    fireEvent.click(screen.getByRole("button", { name: "Local (2)" }));
    expect(screen.getByText("87.9 kB")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy the value of blob" }));
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith("x".repeat(90_000)));
    expect(full).toHaveBeenCalledWith("t1", "local", "blob", null, null);
    expect(await screen.findByRole("button", { name: "Copied blob" })).toBeTruthy();
    // A short value is copied as it is, without asking the page again.
    full.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Copy the value of theme" }));
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith("dark"));
    expect(full).not.toHaveBeenCalled();
  });
});
