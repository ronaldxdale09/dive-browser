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
    const write = vi.spyOn(ipc, "clipboardWriteText").mockResolvedValue(null);
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
  });

  it("keeps a pending copy disabled and offers a visible retry after both clipboard methods fail", async () => {
    ready();
    let rejectWrite!: (reason: Error) => void;
    const write = vi.spyOn(ipc, "clipboardWriteText").mockImplementationOnce(() => new Promise<null>((_, reject) => { rejectWrite = reject; }));
    const fallback = vi.fn().mockRejectedValue(new Error("clipboard unavailable"));
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

  it("does not offer setup when the server is off in a private window", async () => {
    vi.spyOn(ipc, "appInfo").mockResolvedValue({ ...info, mcp_url: "" });
    vi.spyOn(ipc, "mcpToken").mockResolvedValue("");
    render(<McpDialog onClose={() => {}} />);

    await waitFor(() => expect(document.body.textContent).toContain("MCP server is off"));
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
