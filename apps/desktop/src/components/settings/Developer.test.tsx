import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../lib/ipc";
import type { AppInfo } from "../../lib/ipc";
import { cursorConfig, cursorMcpJsonPath, Developer, mcpCommand, shortTokenPath } from "./Developer";

const info: AppInfo = { version: "0.1.16", build: { channel: "dev", number: "1", commit: "abc", built_at: null }, data_dir: "/tmp/x", mcp_url: "http://127.0.0.1:7391/mcp", mcp_token_path: "/tmp/x/mcp-token", simulate: null, updater: false };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Developer › MCP setup", () => {
  it("does not send Windows to ~/.cursor/mcp.json", () => {
    expect(cursorMcpJsonPath(true)).not.toMatch(/~\//);
    expect(cursorMcpJsonPath(true)).toMatch(/%USERPROFILE%/);
    expect(cursorMcpJsonPath(false)).toBe("~/.cursor/mcp.json");
  });

  it("does not tell Windows to cat the token", () => {
    const win = "C:\\Users\\a\\AppData\\Roaming\\dive\\mcp-token";
    expect(mcpCommand(info, win, true)).not.toMatch(/\$\(cat /);
    expect(mcpCommand(info, win, true)).toMatch(/Get-Content/);
    expect(shortTokenPath(win)).toBe("…/mcp-token");
  });

  it("builds the claude command around the token file and a JSON entry around the token itself", () => {
    expect(mcpCommand(info, info.mcp_token_path)).toBe(`claude mcp add --transport http dive http://127.0.0.1:7391/mcp --header "Authorization: Bearer $(cat '/tmp/x/mcp-token')"`);
    expect(shortTokenPath(info.mcp_token_path)).toBe("…/mcp-token");
    const json = JSON.parse(cursorConfig(info, "abc123")) as { mcpServers: { dive: { url: string; headers: { Authorization: string } } } };
    expect(json.mcpServers.dive.url).toBe(info.mcp_url);
    expect(json.mcpServers.dive.headers.Authorization).toBe("Bearer abc123");
  });

  it("does not say every tab opens with the inspector", () => {
    render(<Developer info={info} />);
    expect(document.body.textContent).not.toMatch(/Every tab opens/);
    expect(document.body.textContent).toMatch(/already on screen stay as they are/);
  });

  it("does not advertise MCP setup in a private window", () => {
    const privateWindow = window as Window & { __DIVE_PRIVATE__?: boolean };
    privateWindow.__DIVE_PRIVATE__ = true;
    try {
      render(<Developer info={info} />);
      expect(document.body.textContent).not.toMatch(/7391/);
      expect(document.body.textContent).not.toMatch(/claude mcp add/);
      expect(document.body.textContent).toMatch(/Private windows do not serve MCP/);
    } finally {
      delete privateWindow.__DIVE_PRIVATE__;
    }
  });

  it("does not say agents can read discarded tabs", () => {
    render(<Developer info={info} />);
    expect(document.body.textContent).not.toMatch(/can read your tabs/);
    expect(document.body.textContent).toMatch(/sleeping/i);
  });

  it("says page scripts stay off unless DIVE_MCP_ALLOW_EVAL is set", () => {
    render(<Developer info={info} />);
    expect(document.body.textContent).toMatch(/DIVE_MCP_ALLOW_EVAL=1/);
    expect(document.body.textContent).toMatch(/Page scripts are never run/i);
    expect(document.body.textContent).not.toMatch(/this Mac/);
    expect(document.body.textContent).toMatch(/this computer/);
  });

  it("shows the Cursor entry with the token masked once the token has loaded", async () => {
    vi.spyOn(ipc, "mcpToken").mockResolvedValue("secret-token");
    render(<Developer info={info} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy mcp.json entry" })).toBeTruthy());
    expect(document.body.textContent).toContain("••••••••");
    expect(document.body.innerHTML).not.toContain("secret-token");
  });
});
