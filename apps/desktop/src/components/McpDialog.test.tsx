import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import type { AppInfo } from "../lib/ipc";
import { McpDialog } from "./McpDialog";

const info: AppInfo = {
  version: "0.1.19",
  build: { channel: "dev", number: "1", commit: "abc", built_at: null },
  data_dir: "/tmp/x",
  mcp_url: "http://127.0.0.1:7391/mcp",
  mcp_token_path: "/tmp/x/mcp-token",
  simulate: null,
  updater: false,
};

function ready() {
  vi.spyOn(ipc, "appInfo").mockResolvedValue(info);
  vi.spyOn(ipc, "mcpToken").mockResolvedValue("secret-token");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("McpDialog", () => {
  it("keeps the token out of the DOM but copies the complete skill and MCP setup", async () => {
    ready();
    const plain = vi.spyOn(ipc, "clipboardWriteText").mockResolvedValue(null);
    const write = vi.spyOn(ipc, "clipboardWriteSecret").mockResolvedValue(null);
    const { container } = render(<McpDialog onClose={() => {}} />);

    const button = await screen.findByRole("button", { name: "Copy setup" });
    expect(button.textContent).toContain("Copy setup");
    expect(container.innerHTML).not.toContain("secret-token");
    expect(screen.getByRole("dialog").textContent).toContain("••••••••••••");
    expect(write).not.toHaveBeenCalled();
    fireEvent.click(button);

    await screen.findByRole("button", { name: "Copied" });
    const payload = write.mock.calls[0]?.[0];
    expect(payload).toContain("https://github.com/ronaldxdale09/dive-skill");
    expect(payload).toContain("npx skills add ronaldxdale09/dive-skill --skill dive");
    expect(payload).toContain("--agent");
    for (const id of ["claude-code", "codex", "cursor", "opencode", "zed", "windsurf"]) expect(payload).toContain(id);
    expect(payload).toContain("Streamable HTTP");
    expect(payload).toContain(info.mcp_url);
    expect(payload).toContain("Authorization: Bearer secret-token");
    expect(payload).toContain(info.mcp_token_path);
    expect(payload).toContain("dive_capabilities");
    expect(payload).toContain("tabs_list");
    expect(container.innerHTML).not.toContain("secret-token");
    // The token only ever goes through the secret clipboard, which clears.
    expect(plain).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("30 seconds");
  });

  it("keeps a pending copy disabled and offers a visible retry when the secret clipboard fails", async () => {
    ready();
    let rejectWrite!: (reason: Error) => void;
    const write = vi.spyOn(ipc, "clipboardWriteSecret").mockImplementationOnce(() => new Promise<null>((_, reject) => { rejectWrite = reject; }));
    // The page clipboard is never a fallback for a secret: it can neither
    // hide it from history nor clear it again.
    const fallback = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: fallback } });
    render(<McpDialog onClose={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Copy setup" }));
    expect((screen.getByRole("button", { name: "Copying…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { rejectWrite(new Error("host unavailable")); });
    const retry = await screen.findByRole("button", { name: "Copy failed · Retry" });
    expect(retry.textContent).toContain("Retry");
    expect(screen.getByRole("alert").textContent).toContain("copy");

    write.mockResolvedValue(null);
    fireEvent.click(retry);
    await screen.findByRole("button", { name: "Copied" });
    expect(write).toHaveBeenCalledTimes(2);
    expect(fallback).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows loading until the runtime details and token are both available", async () => {
    vi.spyOn(ipc, "appInfo").mockResolvedValue(info);
    let resolveToken!: (token: string) => void;
    vi.spyOn(ipc, "mcpToken").mockImplementation(() => new Promise<string>((resolve) => { resolveToken = resolve; }));
    render(<McpDialog onClose={() => {}} />);

    expect(screen.getByRole("status").textContent).toContain("Loading");
    expect(screen.queryByRole("button", { name: "Copy setup" })).toBeNull();
    await act(async () => { resolveToken("secret-token"); });
    await screen.findByRole("button", { name: "Copy setup" });
    expect(document.body.textContent).not.toContain("Loading");
  });

  it("includes OpenCode among the supported setup choices", async () => {
    ready();
    render(<McpDialog onClose={() => {}} />);
    await screen.findByRole("button", { name: "Copy setup" });
    for (const name of ["Claude Code", "Cursor", "Codex", "OpenCode", "Windsurf", "Zed"]) expect(screen.getByTitle(name)).toBeTruthy();
  });

  it("labels the agent names as skill install IDs, not extra catalog clients", async () => {
    // OpenCode, Windsurf and Zed sit in the same row as Cursor. Without a
    // label they look like extra MCP surfaces. They are --agent IDs.
    ready();
    render(<McpDialog onClose={() => {}} />);
    await screen.findByRole("button", { name: "Copy setup" });
    expect(screen.getByText(/skill --agent IDs/i)).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).not.toMatch(/OpenCode can read/);
  });

  it("says the port is taken instead of offering a URL nothing of Dive's answers", async () => {
    vi.spyOn(ipc, "appInfo").mockResolvedValue({ ...info, mcp_url: "", mcp_error: "Port 7391 is in use by another program, so the MCP server is not running." });
    vi.spyOn(ipc, "mcpToken").mockResolvedValue("secret-token");
    render(<McpDialog onClose={() => {}} />);

    expect((await screen.findByRole("alert")).textContent).toContain("Port 7391 is in use");
    expect(screen.queryByRole("button", { name: "Copy setup" })).toBeNull();
  });

  it("does not offer setup when the server is not running, and says why it might not be", async () => {
    vi.spyOn(ipc, "appInfo").mockResolvedValue({ ...info, mcp_url: "" });
    vi.spyOn(ipc, "mcpToken").mockResolvedValue("");
    render(<McpDialog onClose={() => {}} />);

    await waitFor(() => expect(document.body.textContent).toContain("MCP server is not running"));
    expect(document.body.textContent).toContain("private");
    expect(document.body.textContent).toContain("DIVE_MCP_PORT");
    expect(screen.queryByRole("button", { name: "Copy setup" })).toBeNull();
    expect(document.body.textContent).not.toContain("Loading");
  });

  it.each(["appInfo", "mcpToken"] as const)("reports a failed %s lookup instead of showing incomplete setup", async (method) => {
    ready();
    vi.mocked(ipc[method]).mockRejectedValue(new Error("unavailable"));
    render(<McpDialog onClose={() => {}} />);

    expect((await screen.findByRole("alert")).textContent).toContain("could not read");
    expect(screen.queryByRole("button", { name: "Copy setup" })).toBeNull();
    expect(document.body.textContent).not.toContain("Loading");
  });

  it("does not offer an authenticated connection with an empty token", async () => {
    ready();
    vi.mocked(ipc.mcpToken).mockResolvedValue("");
    render(<McpDialog onClose={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toContain("token");
    expect(screen.queryByRole("button", { name: "Copy setup" })).toBeNull();
  });

  it("keeps keyboard focus in the dialog and closes on Escape without treating interior clicks as backdrop clicks", async () => {
    ready();
    const close = vi.fn();
    render(<McpDialog onClose={close} />);
    const copy = await screen.findByRole("button", { name: "Copy setup" });
    const done = screen.getByRole("button", { name: "Done" });
    fireEvent.mouseDown(copy);
    expect(close).not.toHaveBeenCalled();
    done.focus();
    fireEvent.keyDown(done, { key: "Tab" });
    expect(document.activeElement).toBe(copy);
    fireEvent.keyDown(copy, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(done);
    fireEvent.keyDown(done, { key: "Escape" });
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it("closes when the backdrop is pressed", async () => {
    ready();
    const close = vi.fn();
    render(<McpDialog onClose={close} />);
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });
});
