import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { PrivateBadge, PrivateWelcome } from "./PrivateMode";

vi.mock("../lib/overlay", () => ({ useCoversContent: vi.fn() }));
import { useCoversContent } from "../lib/overlay";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("private mode chrome", () => {
  it("keeps a labelled badge and covers the native page only while its explanation is open", () => {
    render(<PrivateBadge />);
    const badge = screen.getByRole("button", { name: "Private Mode information" });
    expect(badge.getAttribute("aria-expanded")).toBe("false");
    expect(useCoversContent).toHaveBeenLastCalledWith(false);
    fireEvent.click(badge);
    expect(screen.getByRole("dialog", { name: "Private Window" })).toBeTruthy();
    expect(useCoversContent).toHaveBeenLastCalledWith(true);
    expect(screen.getByText(/does not hide your activity/)).toBeTruthy();
    expect(screen.getByText(/Downloads and files you explicitly export remain/)).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: "Close private information" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useCoversContent).toHaveBeenLastCalledWith(false);
    expect(document.activeElement).toBe(badge);
  });
  it("opens normal browsing without ending the private session and offers a separate exit", async () => {
    const normal = vi.spyOn(ipc, "windowOpen").mockResolvedValue(null);
    const exit = vi.spyOn(ipc, "windowExitPrivate").mockResolvedValue(null);
    render(<PrivateBadge />);
    fireEvent.click(screen.getByRole("button", { name: "Private Mode information" }));
    fireEvent.click(screen.getByRole("button", { name: "Open a normal window" }));
    await waitFor(() => expect(normal).toHaveBeenCalledOnce());
    expect(exit).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Private Mode information" }));
    fireEvent.click(screen.getByRole("button", { name: "Exit Private Mode" }));
    await waitFor(() => expect(exit).toHaveBeenCalledOnce());
  });
  it("keeps exit available when the normal window cannot start", async () => {
    vi.spyOn(ipc, "windowOpen").mockRejectedValue(new Error("Normal window unavailable"));
    const exit = vi.spyOn(ipc, "windowExitPrivate").mockResolvedValue(null);
    render(<PrivateBadge />);
    fireEvent.click(screen.getByRole("button", { name: "Private Mode information" }));
    fireEvent.click(screen.getByRole("button", { name: "Open a normal window" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Normal window unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Exit Private Mode" }));
    expect(exit).toHaveBeenCalledOnce();
  });
  it("explains the last-window lifetime and lets the user start browsing", () => {
    const browse = vi.fn();
    render(<PrivateWelcome onBrowse={browse} />);
    expect(screen.getByText(/Close every Private Window/)).toBeTruthy();
    expect(screen.getByText(/Agents and extensions are off/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Browse privately" }));
    expect(browse).toHaveBeenCalledOnce();
  });
});
