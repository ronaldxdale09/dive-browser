import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExportDialog } from "./ExportDialog";
import { exportProject } from "./export";
import type { RecordingResult } from "../lib/ipc";
import { newProject } from "./model";
import { useEditor } from "./store";

vi.mock("./export", () => ({ exportProject: vi.fn() }));
const result = (path: string): RecordingResult => ({ path, duration_secs: 3, bytes: 1000, width: 640, height: 360, format: "mp4", frames: 90, has_audio: true, events: null, preview: null });
function open(source: string) {
  useEditor.setState({ generation: useEditor.getState().generation + 1, source, project: newProject({ source, playable: `${source}.webm`, events: null, durationMs: 3000, width: 640, height: 360 }), playable: `asset:${source}`, exporting: false, playing: false });
}
function pendingExport() {
  let resolve!: (value: RecordingResult) => void;
  const promise = new Promise<RecordingResult>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => open("A.mp4"));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("does not let a closed editor's native finish release the replacement export or publish its result", async () => {
  const a = pendingExport();
  const b = pendingExport();
  vi.mocked(exportProject).mockImplementationOnce((input) => { input.onProgress({ phase: "finishing", progress: 0 }); return a.promise; });
  const old = render(<ExportDialog onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  old.unmount();
  act(() => open("B.mp4"));
  vi.mocked(exportProject).mockImplementationOnce((input) => { input.onProgress({ phase: "rendering", progress: 0.1, frame: 1, frames: 90 }); return b.promise; });
  render(<ExportDialog onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  expect(useEditor.getState().exporting).toBe(true);
  await act(async () => { a.resolve(result("old.mp4")); });
  expect(useEditor.getState().exporting).toBe(true);
  expect(screen.queryByText(/old.mp4/)).toBeNull();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  await act(async () => { b.resolve(result("new.mp4")); });
  expect(useEditor.getState().exporting).toBe(false);
  expect(screen.getByText(/Saved new.mp4/)).toBeTruthy();
});

it("admits only one export before any progress callback or React rerender", async () => {
  const work = pendingExport();
  vi.mocked(exportProject).mockReturnValue(work.promise);
  render(<ExportDialog onClose={vi.fn()} />);
  const button = screen.getByRole("button", { name: "Export" });
  act(() => { button.click(); button.click(); });
  expect(exportProject).toHaveBeenCalledOnce();
  await act(async () => { work.resolve(result("once.mp4")); });
});

it("prevents a remounted dialog from starting a second export in the same editor generation", async () => {
  const work = pendingExport();
  vi.mocked(exportProject).mockReturnValue(work.promise);
  const old = render(<ExportDialog onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  old.unmount();
  render(<ExportDialog onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  expect(exportProject).toHaveBeenCalledOnce();
  await act(async () => { work.resolve(result("first.mp4")); });
  expect(screen.queryByText(/first.mp4/)).toBeNull();
  vi.mocked(exportProject).mockResolvedValue(result("second.mp4"));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Export" })); });
  expect(exportProject).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/Saved second.mp4/)).toBeTruthy();
});
