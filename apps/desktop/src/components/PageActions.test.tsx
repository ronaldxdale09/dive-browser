import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { resetContentCover } from "../lib/overlay";
import { useBrowser } from "../store/browser";
import { PageActions, preferredLanguage, translationMessage } from "./PageActions";

const initial = useBrowser.getState();
const tab = { id: "t1", workspace_id: "w1", tier: "today", url: "https://example.com/article", title: "An article", favicon: null, position: 0, state: "live", last_active_at: "" };

beforeEach(() => {
  vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "pageReader").mockResolvedValue({ ok: true, reason: null, words: 4000, already: false });
  vi.spyOn(ipc, "pageReaderLeave").mockResolvedValue(null);
  vi.spyOn(ipc, "pageTranslate").mockResolvedValue({ ok: true, reason: null, from: "es", target: "en", changed: 120 });
  vi.spyOn(ipc, "pageTranslateRestore").mockResolvedValue(null);
  useBrowser.setState({ tabs: [tab] as never, activeTab: "t1" });
});

afterEach(() => {
  cleanup();
  resetContentCover();
  useBrowser.setState(initial, true);
  vi.restoreAllMocks();
});

describe("preferredLanguage", () => {
  it("takes the base language, and falls back to one the model has", () => {
    expect(preferredLanguage("pt-BR")).toBe("pt");
    expect(preferredLanguage("EN-GB")).toBe("en");
    expect(preferredLanguage("cy")).toBe("en");
  });
});

describe("translationMessage", () => {
  it("says what actually went wrong", () => {
    expect(translationMessage("already", null)).toContain("already in that language");
    expect(translationMessage("unsupported-pair", "es")).toContain("Spanish");
    expect(translationMessage("unavailable", null)).toContain("could not be downloaded");
    expect(translationMessage(null, null)).toContain("could not be translated");
  });
});

describe("PageActions", () => {
  it("stays out of the way of anything that is not a web page", () => {
    useBrowser.setState({ tabs: [{ ...tab, url: "dive://settings" }] as never, activeTab: "t1" });
    render(<PageActions />);
    expect(screen.queryByRole("button", { name: "Reader view" })).toBeNull();
  });

  it("enters reader view and leaves it again", async () => {
    render(<PageActions />);
    fireEvent.click(screen.getByRole("button", { name: "Reader view" }));
    await waitFor(() => expect(ipc.pageReader).toHaveBeenCalledWith("t1"));
    const leave = await screen.findByRole("button", { name: "Leave reader view" });
    fireEvent.click(leave);
    await waitFor(() => expect(ipc.pageReaderLeave).toHaveBeenCalledWith("t1"));
  });

  it("says so rather than doing nothing when there is no article", async () => {
    vi.spyOn(ipc, "pageReader").mockResolvedValue({ ok: false, reason: "no-article", words: null, already: false });
    render(<PageActions />);
    fireEvent.click(screen.getByRole("button", { name: "Reader view" }));
    await waitFor(() => expect(useBrowser.getState().notice).toContain("no article"));
  });

  it("translates into a chosen language and offers the original back", async () => {
    render(<PageActions />);
    fireEvent.click(screen.getByRole("button", { name: "Translate this page" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "English" }));
    await waitFor(() => expect(ipc.pageTranslate).toHaveBeenCalledWith("t1", "en"));
    fireEvent.click(screen.getByRole("button", { name: "Translate this page" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Show original" }));
    await waitFor(() => expect(ipc.pageTranslateRestore).toHaveBeenCalledWith("t1"));
  });

  it("forgets reader view when the tab navigates", async () => {
    const { rerender } = render(<PageActions />);
    fireEvent.click(screen.getByRole("button", { name: "Reader view" }));
    await screen.findByRole("button", { name: "Leave reader view" });
    useBrowser.setState({ tabs: [{ ...tab, url: "https://example.com/other" }] as never });
    rerender(<PageActions />);
    expect(screen.getByRole("button", { name: "Reader view" })).toBeTruthy();
  });
});
