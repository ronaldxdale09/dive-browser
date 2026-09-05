import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportDialog } from "./ExportDialog";
import { exportProject } from "./export";
import { newProject } from "./model";
import { useEditor } from "./store";

vi.mock("./export", () => ({ exportProject: vi.fn() }));
const media = { source: "/tmp/audio.mp4", playable: "/tmp/audio.webm", events: null, durationMs: 3000, width: 640, height: 360 };

beforeEach(() => {
  useEditor.setState({ generation: useEditor.getState().generation + 1, exporting: false, project: newProject(media), playable: "asset://test", duration: 3000, playing: false });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("Export dialog keyboard ownership", () => {
  it("focuses inside, wraps both Tab directions, and restores its trigger", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger); trigger.focus();
    const { unmount } = render(<ExportDialog onClose={vi.fn()} />);
    const first = screen.getByRole("button", { name: "Close" });
    const last = screen.getByRole("button", { name: "Export" });
    expect(document.activeElement).toBe(first);
    first.focus(); fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    unmount(); expect(document.activeElement).toBe(trigger); trigger.remove();
  });

  it("closes on Escape while idle", () => {
    const close = vi.fn(); render(<ExportDialog onClose={close} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("focuses Done when the export completes", async () => {
    vi.mocked(exportProject).mockImplementation(async (input) => {
      input.onProgress({ phase: "done", progress: 1 });
      return { path: "/tmp/edited.mp4", duration_secs: 3, bytes: 1000, width: 640, height: 360, format: "mp4", frames: 90, has_audio: true, events: null, preview: null };
    });
    render(<ExportDialog onClose={vi.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Export" })); });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Done" }));
  });

  it("moves focus to Cancel while busy and does not dismiss the running export", async () => {
    vi.mocked(exportProject).mockImplementation((input) => {
      input.onProgress({ phase: "rendering", progress: 0.2 });
      return new Promise(() => undefined);
    });
    const close = vi.fn(); render(<ExportDialog onClose={close} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Export" })); });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
  });
});
