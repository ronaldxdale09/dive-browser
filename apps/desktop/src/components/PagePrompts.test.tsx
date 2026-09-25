import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import type { HttpAuthAsked, JsDialogAsked } from "../lib/ipc";
import { resetContentCover } from "../lib/overlay";
import { useHttpAuth } from "../store/httpAuth";
import { useJsDialog } from "../store/jsDialog";
import { PagePrompts } from "./PagePrompts";

const leave: JsDialogAsked = { tab_id: "t1", dialog_id: "7", kind: "beforeunload", origin: "", message: "", default_value: "", is_reload: false };
const challenge: HttpAuthAsked = { tab_id: "t1", request_id: "r1", host: "intranet.example", realm: "Staff", scheme: "basic", is_proxy: false, secure: true };

beforeEach(() => {
  vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "jsDialogAnswer").mockResolvedValue(null);
  vi.spyOn(ipc, "httpAuthAnswer").mockResolvedValue(null);
  vi.spyOn(ipc, "jsDialogPending").mockImplementation(async () => useJsDialog.getState().byTab.t1 ?? []);
  vi.spyOn(ipc, "httpAuthPending").mockImplementation(async () => useHttpAuth.getState().byTab.t1 ?? []);
  useJsDialog.setState({ byTab: {}, listening: true });
  useHttpAuth.setState({ byTab: {}, listening: true });
});

afterEach(() => {
  cleanup();
  resetContentCover();
  vi.restoreAllMocks();
});

describe("PagePrompts", () => {
  it("stacks a page's question above a sign-in, and only the question takes the keyboard", async () => {
    useJsDialog.setState({ byTab: { t1: [leave] } });
    useHttpAuth.setState({ byTab: { t1: [challenge] } });
    render(<PagePrompts tabId="t1" />);
    const [first, second] = screen.getAllByRole("alertdialog");
    expect(first).toHaveProperty("ariaLabel", "Leave this page?");
    expect(second).toHaveProperty("ariaLabel", "Sign in to intranet.example");
    // One column, so neither card is pinned over the other.
    expect(first!.parentElement).toBe(second!.parentElement);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Leave" }));

    // With the page's question answered, the sign-in has the keyboard.
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    await waitFor(() => expect(screen.getAllByRole("alertdialog")).toHaveLength(1));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Username" })));
  });

  it("does not answer Leave when Enter lands on a focused Stay", async () => {
    useJsDialog.setState({ byTab: { t1: [leave] } });
    render(<PagePrompts tabId="t1" />);
    const stay = screen.getByRole("button", { name: "Stay" });
    stay.focus();
    fireEvent.keyDown(stay, { key: "Enter" });
    // The button's own click is the browser's to deliver; the card must not
    // turn the key into the opposite answer first.
    expect(ipc.jsDialogAnswer).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("signs in from a field only once there is a username, and Enter on Cancel never signs in", async () => {
    useHttpAuth.setState({ byTab: { t1: [challenge] } });
    render(<PagePrompts tabId="t1" />);
    const user = screen.getByRole("textbox", { name: "Username" });
    fireEvent.keyDown(user, { key: "Enter" });
    expect(ipc.httpAuthAnswer).not.toHaveBeenCalled();

    fireEvent.change(user, { target: { value: "dale" } });
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Enter" });
    expect(ipc.httpAuthAnswer).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2" } });
    fireEvent.keyDown(screen.getByLabelText("Password"), { key: "Enter" });
    await waitFor(() => expect(ipc.httpAuthAnswer).toHaveBeenCalledWith("t1", "r1", "dale", "hunter2"));
  });

  it("starts below whatever floats over the top of the page", () => {
    useHttpAuth.setState({ byTab: { t1: [challenge] } });
    render(<PagePrompts tabId="t1" top={52} />);
    expect(screen.getByRole("alertdialog").parentElement!.style.top).toBe("52px");
  });
});
