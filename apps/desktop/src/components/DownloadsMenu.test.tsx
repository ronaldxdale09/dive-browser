import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { useDownloads } from "../store/downloads";
import { DEFAULT_PREFS, usePrefs } from "../store/prefs";
import { DownloadsMenu } from "./DownloadsMenu";

const initial = useDownloads.getState();
const initialPrefs = usePrefs.getState();
const platform = Object.getOwnPropertyDescriptor(navigator, "platform");

afterEach(() => {
  cleanup();
  useDownloads.setState(initial, true);
  usePrefs.setState(initialPrefs, true);
  vi.restoreAllMocks();
  if (platform) Object.defineProperty(navigator, "platform", platform);
});

describe("DownloadsMenu", () => {
  it("opens a saved file from its name and shows it in the folder from Show", () => {
    const open = vi.spyOn(ipc, "downloadsOpen").mockResolvedValue(null as never);
    const reveal = vi.spyOn(ipc, "downloadsReveal").mockResolvedValue(null as never);
    useDownloads.setState({
      items: [
        { name: "report.json", path: "/tmp/report.json", url: "http://a.dev/report.json", status: "finished", at: Date.now(), tab: null } as never,
        { name: "big.bin", path: "/tmp/big.bin", url: "http://a.dev/big.bin", status: "started", at: Date.now(), tab: null } as never,
      ],
    });
    render(<DownloadsMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Downloads" }));
    fireEvent.click(screen.getByRole("button", { name: "Open report.json" }));
    expect(open).toHaveBeenCalledWith("/tmp/report.json");
    fireEvent.click(screen.getByRole("button", { name: "Show report.json in folder" }));
    expect(reveal).toHaveBeenCalledWith("/tmp/report.json");
    // A download still in progress has nothing to open yet.
    expect(screen.queryByRole("button", { name: "Open big.bin" })).toBeNull();
    expect(screen.getByText("big.bin")).toBeTruthy();
  });
});

describe("a download in flight", () => {
  const row = (extra: Record<string, unknown>) => ({
    name: "big.bin", path: "/tmp/big.bin", url: "http://a.dev/big.bin",
    status: "started", at: Date.now(), startedAt: Date.now(), ...extra,
  });
  const openPanel = () => {
    render(<DownloadsMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Downloads" }));
  };

  it("shows how far it has got, in the bar and in words", () => {
    useDownloads.setState({ items: [row({ id: 3, received: 500_000, total: 2_000_000, speed: 250_000 }) as never] });
    openPanel();
    const bar = screen.getByRole("progressbar", { name: "big.bin download" });
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByText(/25% of 2\.0 MB · 250 kB\/s/)).toBeTruthy();
  });

  it("shows what has arrived when the server declared no size", () => {
    // A chunked response has no total, and a percentage would be invented.
    useDownloads.setState({ items: [row({ id: 3, received: 1_400_000, speed: 0 }) as never] });
    openPanel();
    const bar = screen.getByRole("progressbar", { name: "big.bin download" });
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    expect(bar.getAttribute("aria-valuetext")).toBe("1.4 MB downloaded");
    expect(screen.getByText(/1\.4 MB/)).toBeTruthy();
  });

  it("can be cancelled once the engine has given it an id", () => {
    const cancel = vi.spyOn(ipc, "downloadsCancel").mockResolvedValue(null as never);
    useDownloads.setState({ items: [row({ id: 42, received: 10, total: 100 }) as never] });
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Cancel big.bin" }));
    expect(cancel).toHaveBeenCalledWith(42);
  });

  it("offers no cancel before the first progress report, when there is no id to send", () => {
    useDownloads.setState({ items: [row({}) as never] });
    openPanel();
    expect(screen.queryByRole("button", { name: "Cancel big.bin" })).toBeNull();
  });

  it("says so when it is paused rather than showing a stalled speed", () => {
    useDownloads.setState({ items: [row({ id: 3, received: 10, total: 100, paused: true }) as never] });
    openPanel();
    expect(screen.getByText(/Paused/)).toBeTruthy();
  });
});

describe("opening a finished file", () => {
  const finished = (name: string) => ({ name, path: `/tmp/${name}`, url: `http://a.dev/${name}`, status: "finished", at: Date.now(), startedAt: Date.now() });

  it("ignores the second half of a double-click, so the file opens once", () => {
    const open = vi.spyOn(ipc, "downloadsOpen").mockResolvedValue(null as never);
    useDownloads.setState({ items: [finished("sheet.csv") as never] });
    render(<DownloadsMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Downloads" }));
    const name = screen.getByRole("button", { name: "Open sheet.csv" });
    fireEvent.click(name);
    fireEvent.click(name);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("opens a PDF in a tab rather than handing it to a document app", () => {
    const open = vi.spyOn(ipc, "downloadsOpen").mockResolvedValue(null as never);
    const openTab = vi.fn().mockResolvedValue(undefined);
    useBrowser.setState({ openTab });
    useDownloads.setState({ items: [finished("a paper.pdf") as never] });
    render(<DownloadsMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Downloads" }));
    fireEvent.click(screen.getByRole("button", { name: "Open a paper.pdf" }));
    expect(openTab).toHaveBeenCalledWith("file:///tmp/a%20paper.pdf");
    expect(open).not.toHaveBeenCalled();
    // The panel gets out of the way of the tab it just opened.
    expect(screen.queryByRole("dialog", { name: "Downloads this session" })).toBeNull();
  });
});

describe("clearing the list", () => {
  it("also clears what an agent can see through the engine", () => {
    const clear = vi.spyOn(ipc, "downloadsClear").mockResolvedValue(null as never);
    useDownloads.setState({
      items: [{ name: "a.pdf", path: "/tmp/a.pdf", url: "http://a.dev/a.pdf", status: "finished", at: Date.now(), startedAt: Date.now() } as never],
    });
    render(<DownloadsMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Downloads" }));
    fireEvent.click(screen.getByRole("button", { name: /Clear list/ }));
    expect(clear).toHaveBeenCalled();
    expect(useDownloads.getState().items).toHaveLength(0);
  });
});

describe("this window's chip vs this session's list", () => {
  const here = {
    id: "tab-here",
    workspace_id: "w",
    tier: "today" as const,
    url: "https://a.test/",
    title: "Here",
    favicon: null,
    position: 0,
    state: "active" as const,
    last_active_at: "2026-09-03T00:00:00Z",
  };
  const away = { ...here, id: "tab-away", title: "Away", position: 1 };
  const initialBrowser = useBrowser.getState();

  afterEach(() => {
    useBrowser.setState(initialBrowser, true);
  });

  it("does not present the session list as this window's in-progress count", () => {
    useBrowser.setState({ tabs: [here, away], activeTab: here.id, detached: [away.id] });
    useDownloads.setState({
      items: [
        { name: "here.bin", path: "/tmp/here.bin", url: "http://a.dev/here.bin", status: "started", at: 1, startedAt: 1, tabId: here.id } as never,
        { name: "away.bin", path: "/tmp/away.bin", url: "http://a.dev/away.bin", status: "started", at: 2, startedAt: 2, tabId: away.id } as never,
      ],
    });
    render(<DownloadsMenu />);
    expect(screen.getByLabelText("1 in progress in this window")).toBeTruthy();
    expect(screen.queryByLabelText("2 in progress in this window")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Downloads" }));
    const dialog = screen.getByRole("dialog", { name: "Downloads this session" });
    expect(dialog.textContent).toMatch(/This session/);
    expect(screen.getByRole("progressbar", { name: "here.bin download" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "away.bin download" })).toBeTruthy();
  });
});

describe("default download folder copy", () => {
  it("does not show ~/Downloads on Windows when the pref is empty", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, download_dir: "" } });
    useDownloads.setState({ items: [] });
    render(<DownloadsMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Downloads" }));
    expect(screen.getByRole("dialog", { name: "Downloads this session" }).textContent).not.toMatch(/~\//);
    expect(screen.getByRole("dialog", { name: "Downloads this session" }).textContent).toMatch(/Downloads folder|USERPROFILE/);
  });
});
