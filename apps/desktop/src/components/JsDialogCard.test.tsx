import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import type { JsDialogAsked } from "../lib/ipc";
import { contentCoverDepth, resetContentCover } from "../lib/overlay";
import { useBrowser } from "../store/browser";
import { useJsDialog } from "../store/jsDialog";
import { JsDialogCard } from "./JsDialogCard";

const confirm: JsDialogAsked = { tab_id: "t1", dialog_id: "7", kind: "confirm", origin: "https://example.com", message: "Delete it?", default_value: "", is_reload: false };
const initialBrowser = useBrowser.getState();

beforeEach(() => {
  vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "jsDialogAnswer").mockResolvedValue(null);
  useJsDialog.setState({ byTab: {}, listening: true });
});

afterEach(() => {
  cleanup();
  resetContentCover();
  useBrowser.setState(initialBrowser, true);
  vi.restoreAllMocks();
});

describe("JsDialogCard", () => {
  it("shows a confirm for its own tab only, covers the page, and answers OK", async () => {
    useJsDialog.setState({ byTab: { t1: [confirm] } });
    render(<JsDialogCard tabId="other" />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    cleanup();
    render(<JsDialogCard tabId="t1" />);
    const card = screen.getByRole("alertdialog", { name: "example.com says" });
    expect(card.textContent).toContain("Delete it?");
    expect(contentCoverDepth()).toBe(1);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "OK" }));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(ipc.jsDialogAnswer).toHaveBeenCalledWith("t1", "7", true, null));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(useJsDialog.getState().byTab.t1).toBeUndefined();
  });

  it("cancels with Escape and shows the next dialog in the queue", async () => {
    const second: JsDialogAsked = { ...confirm, dialog_id: "8", kind: "alert", message: "Done." };
    useJsDialog.setState({ byTab: { t1: [confirm, second] } });
    render(<JsDialogCard tabId="t1" />);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    await waitFor(() => expect(ipc.jsDialogAnswer).toHaveBeenCalledWith("t1", "7", false, null));
    // An alert has nothing to cancel: one button, and it reads as such.
    expect(screen.getByRole("alertdialog").textContent).toContain("Done.");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Enter" });
    await waitFor(() => expect(ipc.jsDialogAnswer).toHaveBeenCalledWith("t1", "8", true, null));
  });

  it("puts the cursor in a prompt's field with the suggested text and sends what was typed", async () => {
    useJsDialog.setState({ byTab: { t1: [{ ...confirm, kind: "prompt", message: "Your name?", default_value: "anon" }] } });
    render(<JsDialogCard tabId="t1" />);
    const field = screen.getByRole("textbox", { name: "Your answer" }) as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("anon");
    fireEvent.change(field, { target: { value: "dale" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(ipc.jsDialogAnswer).toHaveBeenCalledWith("t1", "7", true, "dale"));
  });

  it("words a leave-page question as Leave or Stay, and Stay is a cancel", async () => {
    useJsDialog.setState({ byTab: { t1: [{ ...confirm, kind: "beforeunload", origin: "", message: "" }] } });
    render(<JsDialogCard tabId="t1" />);
    expect(screen.getByRole("alertdialog", { name: "Leave this page?" }).textContent).toContain("may not be saved");
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    await waitFor(() => expect(ipc.jsDialogAnswer).toHaveBeenCalledWith("t1", "7", false, null));
  });

  it("stays quiet when the dialog was already answered elsewhere", async () => {
    vi.spyOn(ipc, "jsDialogAnswer").mockRejectedValue(new Error("that dialog is no longer open"));
    useJsDialog.setState({ byTab: { t1: [confirm] } });
    render(<JsDialogCard tabId="t1" />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(ipc.jsDialogAnswer).toHaveBeenCalled());
    expect(useBrowser.getState().error).toBe(initialBrowser.error);
  });
});
