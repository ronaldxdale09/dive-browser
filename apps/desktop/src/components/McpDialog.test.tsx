import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import type { AppInfo } from "../lib/ipc";
import { instruction, McpDialog } from "./McpDialog";

const info: AppInfo = {
  version: "0.1.19",
  build: { channel: "dev", number: "1", commit: "abc", built_at: null },
  data_dir: "/tmp/x",
  mcp_url: "http://127.0.0.1:7391/mcp",
  mcp_token_path: "/tmp/x/mcp-token",
  simulate: null,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("instruction", () => {
  it("gives the agent everything it needs to register itself", () => {
    const text = instruction(info.mcp_url, info.mcp_token_path, "secret-token");
    expect(text).toContain(info.mcp_url);
    expect(text).toContain("Authorization: Bearer secret-token");
    expect(text).toContain(info.mcp_token_path);
  });

  it("is addressed to the agent and names the harnesses people ask about", () => {
    // One block for every client: the agent picks the shape its own config
    // wants, which is why there is no client to choose here.
    const text = instruction(info.mcp_url, info.mcp_token_path, "secret-token");
    expect(text.startsWith("Add the Dive browser to yourself as an MCP server")).toBe(true);
    for (const client of ["Claude Code", "Cursor", "Codex"]) expect(text).toContain(client);
  });
});

describe("McpDialog", () => {
  it("shows the instruction with the token masked, and copies it whole", async () => {
    vi.spyOn(ipc, "appInfo").mockResolvedValue(info);
    vi.spyOn(ipc, "mcpToken").mockResolvedValue("secret-token");
    render(<McpDialog onClose={() => {}} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Copy instruction" })).toBeTruthy());
    expect(document.body.textContent).toContain("Add the Dive browser to yourself");
    expect(document.body.textContent).not.toContain("secret-token");
  });

  it("names the agents it is known to work with", async () => {
    vi.spyOn(ipc, "appInfo").mockResolvedValue(info);
    vi.spyOn(ipc, "mcpToken").mockResolvedValue("secret-token");
    render(<McpDialog onClose={() => {}} />);

    await waitFor(() => expect(screen.getByTitle("Claude Code")).toBeTruthy());
    for (const name of ["Cursor", "Codex", "Windsurf", "Zed"]) expect(screen.getByTitle(name)).toBeTruthy();
  });

  it("says the server is off rather than offering an instruction that cannot work", async () => {
    vi.spyOn(ipc, "appInfo").mockResolvedValue({ ...info, mcp_url: "" });
    vi.spyOn(ipc, "mcpToken").mockResolvedValue("secret-token");
    render(<McpDialog onClose={() => {}} />);

    await waitFor(() => expect(document.body.textContent).toContain("MCP server is off"));
    expect(screen.queryByRole("button", { name: "Copy instruction" })).toBeNull();
  });
});
