import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { useDownloads } from "../store/downloads";
import { DownloadsMenu } from "./DownloadsMenu";

const initial = useDownloads.getState();

afterEach(() => {
  cleanup();
  useDownloads.setState(initial, true);
  vi.restoreAllMocks();
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
  it("ignores the second half of a double-click, so the file opens once", () => {
    const open = vi.spyOn(ipc, "downloadsOpen").mockResolvedValue(null as never);
    useDownloads.setState({
      items: [{ name: "a.pdf", path: "/tmp/a.pdf", url: "http://a.dev/a.pdf", status: "finished", at: Date.now(), startedAt: Date.now() } as never],
    });
    render(<DownloadsMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Downloads" }));
    const name = screen.getByRole("button", { name: "Open a.pdf" });
    fireEvent.click(name);
    fireEvent.click(name);
    expect(open).toHaveBeenCalledTimes(1);
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
