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
