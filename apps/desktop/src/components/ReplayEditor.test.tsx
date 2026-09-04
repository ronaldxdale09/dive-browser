import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { ReplayEditor } from "./ReplayEditor";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ReplayEditor", () => {
  it("opens as a keyboard-contained dialog and closes on Escape", () => {
    vi.spyOn(ipc, "requestCaptured").mockReturnValue(new Promise(() => undefined));
    const onClose = vi.fn();
    render(<ReplayEditor tabId="tab-1" requestId="request-1" onClose={onClose} />);

    const dialog = screen.getByRole("dialog", { name: "Replay request" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close replay" }));
    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
