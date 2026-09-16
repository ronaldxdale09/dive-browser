import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { StoragePanel } from "./StoragePanel";

const tab = { id: "t1", workspace_id: "w1", url: "https://a.test/", title: "A", favicon: null, tier: "today", position: 0, state: "active", last_active_at: "" } as unknown as Tab;
const initial = useBrowser.getState();

beforeEach(() => {
  useBrowser.setState({ tabs: [tab], activeTab: "t1", loading: {} });
  vi.spyOn(ipc, "tabStorage").mockResolvedValue({
    cookies: [{ name: "session", value: "abc", domain: "a.test", path: "/", expires: null, http_only: true, secure: true, same_site: "Lax" }],
    local: [["theme", "dark"]],
    session: [],
  });
});

afterEach(() => {
  cleanup();
  useBrowser.setState(initial, true);
  vi.restoreAllMocks();
});

describe("StoragePanel", () => {
  it("does not count a detached tab's cookies as this window's dock", () => {
    useBrowser.setState({ tabs: [tab], activeTab: "t1", detached: ["t1"], loading: {} });
    render(<StoragePanel />);
    expect(screen.getByText("Open a tab to inspect its storage.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cookies (1)" })).toBeNull();
    expect(ipc.tabStorage).not.toHaveBeenCalled();
  });

  it("heads the columns and explains a cookie's flags, then switches to local storage", async () => {
    render(<StoragePanel />);
    expect(await screen.findByText("session")).toBeTruthy();
    expect(screen.getByText("Domain · path · flags")).toBeTruthy();
    expect(screen.getByText("a.test/ · HttpOnly · Secure · Lax")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Local (1)" }));
    expect(screen.getByText("Key")).toBeTruthy();
    expect(screen.getByText("theme")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Session (0)" }));
    expect(screen.getByText("Nothing stored.")).toBeTruthy();
    expect(screen.queryByText("Key")).toBeNull();
  });

  it("does not keep the last cookie count when this tab is sleeping", async () => {
    render(<StoragePanel />);
    expect(await screen.findByRole("button", { name: "Cookies (1)" })).toBeTruthy();
    await act(async () => {
      useBrowser.setState({ tabs: [{ ...tab, state: "discarded" }], activeTab: "t1" });
    });
    expect(screen.queryByRole("button", { name: "Cookies (1)" })).toBeNull();
    expect(screen.getByText(/sleeping/i)).toBeTruthy();
  });
});

describe("StoragePanel deletes", () => {
  it("removes a cookie by name, domain and path, and a storage key by name, then reads again", async () => {
    const del = vi.spyOn(ipc, "tabStorageDelete").mockResolvedValue(null as never);
    render(<StoragePanel />);
    await screen.findByText("session");
    const reads = vi.mocked(ipc.tabStorage).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Delete session" }));
    expect(del).toHaveBeenCalledWith("t1", "cookies", "session", "a.test", "/");
    await vi.waitFor(() => expect(vi.mocked(ipc.tabStorage).mock.calls.length).toBeGreaterThan(reads));
    fireEvent.click(screen.getByRole("button", { name: "Local (1)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete theme" }));
    expect(del).toHaveBeenCalledWith("t1", "local", "theme", null, null);
  });
});
