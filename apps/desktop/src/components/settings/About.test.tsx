import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppInfo } from "../../lib/ipc";
import { useUpdates } from "../../store/updates";
import { About, engineLabel } from "./About";

const info = (channel: string): AppInfo => ({ version: "0.1.16", build: { channel, number: "1", commit: "abc", built_at: null }, data_dir: "/tmp/x", mcp_url: "", mcp_token_path: "", simulate: null });
const initial = useUpdates.getState();

afterEach(() => {
  cleanup();
  useUpdates.setState(initial, true);
});

describe("About header", () => {
  it("leads with the mark, the name and the version", () => {
    render(<About info={info("release")} />);
    expect(screen.getByText("Dive")).toBeTruthy();
    expect(screen.getByTestId("about-summary").textContent).toContain("Version 0.1.16");
    expect(screen.getByTestId("about-summary").textContent).toContain(engineLabel());
  });
});

describe("About updates", () => {
  it("says a dev build has no updater instead of offering a check", () => {
    render(<About info={info("dev")} />);
    expect(screen.getByText("Updates are delivered to release builds.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Check for updates/ })).toBeNull();
  });

  it("walks the release states: check, up to date once, error with a retry, available with install", () => {
    const check = vi.fn().mockResolvedValue(undefined);
    useUpdates.setState({ status: "idle", check });
    render(<About info={info("beta")} />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(check).toHaveBeenCalledTimes(1);
    act(() => useUpdates.setState({ status: "none" }));
    expect(screen.getAllByText(/up to date/i)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    act(() => useUpdates.setState({ status: "error", error: "no network" }));
    expect(screen.getByText("no network")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    act(() => useUpdates.setState({ status: "available", update: { version: "0.2.0", notes: "Faster tabs" } as never }));
    expect(screen.getByText("Dive 0.2.0 is available")).toBeTruthy();
    expect(screen.getByText("Faster tabs")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install and restart" })).toBeTruthy();
  });
});

describe("About engine line", () => {
  it("names the Chromium major from the user agent", () => {
    expect(engineLabel("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")).toBe("Chromium 151 · CEF");
    expect(engineLabel("Mozilla/5.0 (X11) Gecko/20100101 Firefox/130.0")).toBe("CEF");
  });

  it("does not advertise the main-window MCP URL in a private window", () => {
    // lib.rs starts MCP only when !private_session::is_private().
    // A private Settings pane that still shows :7391 is the other process.
    const privateWindow = window as Window & { __DIVE_PRIVATE__?: boolean };
    privateWindow.__DIVE_PRIVATE__ = true;
    try {
      render(<About info={{ ...info("release"), mcp_url: "http://127.0.0.1:7391/mcp", mcp_token_path: "/tmp/x/mcp-token" }} />);
      expect(document.body.textContent).not.toMatch(/7391/);
      expect(document.body.textContent).toMatch(/Private windows do not serve MCP/);
      expect(screen.queryByRole("button", { name: "Copy MCP URL" })).toBeNull();
    } finally {
      delete privateWindow.__DIVE_PRIVATE__;
    }
  });

  it("does not say each container has its own process tree", () => {
    // A container is a cache directory and request context. Renderers are
    // process-per-site in the one browser process. Private windows are the
    // exception that starts a second OS process.
    render(<About info={info("release")} />);
    expect(document.body.textContent).not.toMatch(/one process tree per container/i);
    expect(document.body.textContent).toMatch(/Containers isolate cookies and cache, not processes/);
  });
});
