import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { resetContentCover } from "../lib/overlay";
import { tabInThisWindow, useBrowser } from "../store/browser";
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
  vi.spyOn(ipc, "pageReaderOpen").mockResolvedValue(false);
  vi.spyOn(ipc, "pageTranslateState").mockResolvedValue({ translated: false, target: null, language: "es", supported: true });
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

  it("keeps the tags where the region or length is the language", () => {
    expect(preferredLanguage("zh-TW")).toBe("zh-TW");
    expect(preferredLanguage("zh-Hant-HK")).toBe("zh-TW");
    expect(preferredLanguage("zh-CN")).toBe("zh");
    expect(preferredLanguage("fil-PH")).toBe("fil");
    expect(preferredLanguage("tl")).toBe("fil");
    // Finnish is not Filipino.
    expect(preferredLanguage("fi")).toBe("en");
  });
});

describe("translationMessage", () => {
  it("says what actually went wrong", () => {
    expect(translationMessage("already", null)).toContain("already in that language");
    expect(translationMessage("already", "en", "en")).toBe("This page is already in English.");
    expect(translationMessage("unsupported-pair", "es")).toContain("Spanish");
    expect(translationMessage("unavailable", null)).toContain("could not be downloaded");
    expect(translationMessage(null, null)).toContain("could not be translated");
  });
});

describe("PageActions", () => {
  it("does not offer reader view for a detached tab", () => {
    useBrowser.setState({ tabs: [tab] as never, activeTab: "t1", detached: ["t1"] });
    expect(tabInThisWindow(useBrowser.getState().activeTab, useBrowser.getState().detached)).toBeNull();
    render(<PageActions />);
    expect(screen.queryByRole("button", { name: "Reader view" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Translate this page" })).toBeNull();
  });

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
    expect(await screen.findByRole("button", { name: "Reader view" })).toBeTruthy();
  });

  it("shows what the page is in when it appears, and what the palette did to it", async () => {
    vi.spyOn(ipc, "pageReaderOpen").mockResolvedValue(true);
    vi.spyOn(ipc, "pageTranslateState").mockResolvedValue({ translated: true, target: "fr", language: "es", supported: true });
    render(<PageActions />);
    expect(await screen.findByRole("button", { name: "Leave reader view" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Translate this page" }).className).toContain("text-highlight");
    // Reader view left from the palette shows here without a remount.
    act(() => useBrowser.getState().setPageMode("t1", { reader: false }));
    expect(screen.getByRole("button", { name: "Reader view" })).toBeTruthy();
  });

  it("spins only the button whose work is running", async () => {
    let finish: (value: never) => void = () => undefined;
    vi.spyOn(ipc, "pageTranslate").mockReturnValue(new Promise((resolve) => (finish = resolve)) as never);
    render(<PageActions />);
    fireEvent.click(screen.getByRole("button", { name: "Translate this page" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "French" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Translate this page" }).getAttribute("aria-busy")).toBe("true"));
    expect(screen.getByRole("button", { name: "Reader view" }).querySelector(".animate-spin, .motion-safe\\:animate-spin")).toBeNull();
    await act(async () => finish({ ok: true, reason: null, from: "es", target: "fr", changed: 1 } as never));
  });
});
