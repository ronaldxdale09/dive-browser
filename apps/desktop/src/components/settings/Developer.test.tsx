import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../lib/ipc";
import type { AppInfo } from "../../lib/ipc";
import { cursorConfig, Developer, mcpCommand, shortTokenPath } from "./Developer";

const info: AppInfo = { version: "0.1.16", build: { channel: "dev", number: "1", commit: "abc", built_at: null }, data_dir: "/tmp/x", mcp_url: "http://127.0.0.1:7391/mcp", mcp_token_path: "/tmp/x/mcp-token", simulate: null };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Developer › MCP setup", () => {
  it("builds the claude command around the token file and a JSON entry around the token itself", () => {
    expect(mcpCommand(info, info.mcp_token_path)).toBe(`claude mcp add --transport http dive http://127.0.0.1:7391/mcp --header "Authorization: Bearer $(cat '/tmp/x/mcp-token')"`);
    expect(shortTokenPath(info.mcp_token_path)).toBe("…/mcp-token");
    const json = JSON.parse(cursorConfig(info, "abc123")) as { mcpServers: { dive: { url: string; headers: { Authorization: string } } } };
    expect(json.mcpServers.dive.url).toBe(info.mcp_url);
    expect(json.mcpServers.dive.headers.Authorization).toBe("Bearer abc123");
  });

  it("shows the Cursor entry with the token masked once the token has loaded", async () => {
    vi.spyOn(ipc, "mcpToken").mockResolvedValue("secret-token");
    render(<Developer info={info} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy mcp.json entry" })).toBeTruthy());
    expect(document.body.textContent).toContain("••••••••");
    expect(document.body.textContent).not.toContain("secret-token");
  });
});
