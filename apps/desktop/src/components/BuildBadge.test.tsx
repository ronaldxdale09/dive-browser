import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { BuildBadge, formatBuilt } from "./BuildBadge";

const info = { version: "0.1.5", build: { channel: "beta", number: "212", commit: "9966239ab", built_at: 1_788_684_000 }, data_dir: "/tmp", mcp_url: "", mcp_token_path: "", simulate: null };

afterEach(() => vi.restoreAllMocks());

describe("BuildBadge", () => {
  it("names the channel and opens the build details", async () => {
    vi.spyOn(ipc, "appInfo").mockResolvedValue(info);
    vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
    render(<BuildBadge />);
    const badge = await screen.findByRole("button", { name: "Beta build" });
    expect(badge.textContent).toContain("BETA");
    fireEvent.click(badge);
    const dialog = screen.getByRole("dialog", { name: "Build details" });
    expect(dialog.textContent).toContain("0.1.5");
    expect(dialog.textContent).toContain("212");
    expect(dialog.textContent).not.toContain("9966239ab");
    expect(dialog.textContent).toContain(formatBuilt(info.build.built_at) ?? "");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("reads DEV for a development build", async () => {
    vi.spyOn(ipc, "appInfo").mockResolvedValue({ ...info, build: { ...info.build, channel: "dev" } });
    render(<BuildBadge />);
    expect((await screen.findByRole("button", { name: "Development build" })).textContent).toContain("DEV");
  });

  it("has no build time for an unstamped build", () => {
    expect(formatBuilt(0)).toBeNull();
  });
});
