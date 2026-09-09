import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrowser } from "../store/browser";
import { DEFAULT_PREFS, usePrefs } from "../store/prefs";
import { QuickLinks, parseQuickLink } from "./QuickLinks";

beforeEach(() => {
  usePrefs.setState({ prefs: { ...DEFAULT_PREFS }, loaded: true, update: vi.fn().mockResolvedValue(undefined) });
  useBrowser.setState({ tabs: [], openOrSwitch: vi.fn().mockResolvedValue(undefined) });
});

afterEach(() => cleanup());

describe("QuickLinks", () => {
  it("opens each pinned site, switching to its tab when one is open", () => {
    render(<QuickLinks />);
    for (const link of DEFAULT_PREFS.quick_links) {
      fireEvent.click(screen.getByRole("button", { name: `Open ${link.name}` }));
      expect(useBrowser.getState().openOrSwitch).toHaveBeenCalledWith(link.url);
    }
  });

  it("removes a link and adds one from a bare host, naming it after the host", () => {
    render(<QuickLinks />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Gemini from quick links" }));
    expect(usePrefs.getState().update).toHaveBeenCalledWith({ quick_links: DEFAULT_PREFS.quick_links.slice(0, 2) });

    fireEvent.click(screen.getByRole("button", { name: "Add a quick link" }));
    const address = screen.getByRole("textbox", { name: "Address" });
    expect(document.activeElement).toBe(address);
    fireEvent.change(address, { target: { value: "linear.app" } });
    fireEvent.submit(screen.getByRole("form", { name: "New quick link" }));
    expect(usePrefs.getState().update).toHaveBeenLastCalledWith({ quick_links: [...DEFAULT_PREFS.quick_links, { name: "linear.app", url: "https://linear.app/" }] });
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("refuses an address that is not a web page and says so", () => {
    render(<QuickLinks />);
    fireEvent.click(screen.getByRole("button", { name: "Add a quick link" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Address" }), { target: { value: "file:///etc/hosts" } });
    fireEvent.submit(screen.getByRole("form", { name: "New quick link" }));
    expect(screen.getByRole("alert").textContent).toContain("http or https");
    expect(usePrefs.getState().update).not.toHaveBeenCalled();
  });
});

describe("parseQuickLink", () => {
  it("adds https, strips www from a default name and keeps a typed name", () => {
    expect(parseQuickLink("www.notion.so/team", "")).toEqual({ name: "notion.so", url: "https://www.notion.so/team" });
    expect(parseQuickLink("https://x.test", " My X ")).toEqual({ name: "My X", url: "https://x.test/" });
    expect(parseQuickLink("", "")).toEqual({ error: "Enter a web address." });
  });
});
