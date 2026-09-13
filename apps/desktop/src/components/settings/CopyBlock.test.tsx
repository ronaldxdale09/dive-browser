import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ipc } from "../../lib/ipc";
import { CopyBlock } from "./CopyBlock";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("never exposes a masked payload in DOM attributes while preserving the full clipboard value", async () => {
  const write = vi.spyOn(ipc, "clipboardWriteText").mockResolvedValue(null);
  const { container } = render(<CopyBlock text="Bearer private-secret" display="Bearer ••••••••" label="Copy mcp.json entry" />);
  expect(container.innerHTML).not.toContain("private-secret");
  fireEvent.click(screen.getByRole("button", { name: "Copy mcp.json entry" }));
  await waitFor(() => expect(write).toHaveBeenCalledWith("Bearer private-secret"));
  expect(screen.getByRole("status").textContent).toContain("Copied");
});

it("keeps ordinary commands visible and disables copy when there is no payload", () => {
  const { rerender } = render(<CopyBlock text="http://127.0.0.1:7391/mcp" />);
  expect(document.body.textContent).toContain("http://127.0.0.1:7391/mcp");
  expect((screen.getByRole("button", { name: "Copy command" }) as HTMLButtonElement).disabled).toBe(false);
  rerender(<CopyBlock text="" />);
  expect((screen.getByRole("button", { name: "Copy command" }) as HTMLButtonElement).disabled).toBe(true);
});
