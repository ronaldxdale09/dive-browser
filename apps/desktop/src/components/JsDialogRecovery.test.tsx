import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JsDialogAsked, JsDialogClosed } from "../lib/ipc";
import { events, ipc } from "../lib/ipc";
import { resetContentCover } from "../lib/overlay";
import { useJsDialog } from "../store/jsDialog";
import { JsDialogCard } from "./JsDialogCard";

const host = vi.hoisted(() => ({ pending: vi.fn() }));
vi.mock("../lib/ipc", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/ipc")>();
  return { ...original, ipc: { ...original.ipc, jsDialogPending: host.pending } };
});
const prompt: JsDialogAsked = { tab_id: "a", dialog_id: "7", kind: "prompt", origin: "https://example.com", message: "Pending before detach", default_value: "anon", is_reload: false };
let asked: (payload: JsDialogAsked) => void;
let closed: (payload: JsDialogClosed) => void;
let resolveSnapshot: (dialogs: JsDialogAsked[]) => void;
beforeEach(() => {
  host.pending.mockReset().mockImplementation(() => new Promise<JsDialogAsked[]>((resolve) => { resolveSnapshot = resolve; }));
  useJsDialog.setState({ byTab: {}, listening: false });
  vi.spyOn(events.jsDialogAsked, "listen").mockImplementation(async (callback) => {
    asked = (payload) => callback({ event: "js-dialog-asked", id: 0, payload });
    return () => undefined;
  });
  vi.spyOn(events.jsDialogClosed, "listen").mockImplementation(async (callback) => {
    closed = (payload) => callback({ event: "js-dialog-closed", id: 0, payload });
    return () => undefined;
  });
  vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "jsDialogAnswer").mockResolvedValue(null);
});
afterEach(() => { cleanup(); resetContentCover(); vi.restoreAllMocks(); });

it("recovers a dialog already open before chrome mounted", async () => {
  render(<JsDialogCard tabId="a" />);
  await waitFor(() => expect(host.pending).toHaveBeenCalledWith("a"));
  await act(async () => resolveSnapshot([prompt]));
  expect(screen.getByRole("alertdialog").textContent).toContain("Pending before detach");
});

it("merges a newer event once while retaining older pending dialogs", async () => {
  render(<JsDialogCard tabId="a" />);
  await waitFor(() => expect(host.pending).toHaveBeenCalledWith("a"));
  const next = { ...prompt, dialog_id: "8", message: "Newer" };
  act(() => { asked(next); asked(next); });
  await act(async () => resolveSnapshot([prompt, next]));
  expect(useJsDialog.getState().byTab.a?.map((dialog) => dialog.dialog_id)).toEqual(["7", "8"]);
});

it("does not resurrect a closed dialog from a stale snapshot", async () => {
  render(<JsDialogCard tabId="a" />);
  await waitFor(() => expect(host.pending).toHaveBeenCalledWith("a"));
  act(() => closed({ tab_id: "a", dialog_id: "7" }));
  await act(async () => resolveSnapshot([prompt]));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(useJsDialog.getState().byTab.a).toBeUndefined();
});

it("does not resurrect a locally answered dialog while the close event is delayed", async () => {
  render(<JsDialogCard tabId="a" />);
  await waitFor(() => expect(host.pending).toHaveBeenCalledWith("a"));
  act(() => asked(prompt));
  await act(async () => useJsDialog.getState().answer(prompt, true, "Dale"));
  await act(async () => resolveSnapshot([prompt]));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("waits for event subscription before reading the snapshot", async () => {
  let ready!: () => void;
  vi.spyOn(events.jsDialogClosed, "listen").mockImplementation(() => new Promise((resolve) => { ready = () => resolve(() => undefined); }));
  render(<JsDialogCard tabId="a" />);
  await act(async () => undefined);
  expect(host.pending).not.toHaveBeenCalled();
  await act(async () => ready());
  await waitFor(() => expect(host.pending).toHaveBeenCalledWith("a"));
  await act(async () => resolveSnapshot([prompt]));
  expect(screen.getByRole("alertdialog")).toBeTruthy();
});

it("preserves native queue order when an older asked event overlaps the snapshot", async () => {
  render(<JsDialogCard tabId="a" />);
  await waitFor(() => expect(host.pending).toHaveBeenCalledWith("a"));
  act(() => asked(prompt));
  await act(async () => resolveSnapshot([prompt, { ...prompt, dialog_id: "8", message: "Next" }]));
  expect(useJsDialog.getState().byTab.a?.map((dialog) => dialog.dialog_id)).toEqual(["7", "8"]);
});
