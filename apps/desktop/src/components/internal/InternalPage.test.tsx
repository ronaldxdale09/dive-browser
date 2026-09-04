import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../../lib/ipc";
import { ipc } from "../../lib/ipc";
import { useBrowser } from "../../store/browser";
import { InternalPage } from "./InternalPage";

const capture: Tab = {
  id: "capture-tab",
  workspace_id: "workspace-1",
  tier: "today",
  url: "dive://capture?src=%2Ftmp%2Fdive.png&url=https%3A%2F%2Fexample.com%2Fdocs&title=Example%20Docs",
  title: "Dive Capture",
  favicon: null,
  position: 1,
  state: "active",
  last_active_at: "2026-09-04T00:00:00Z",
};

const context = {
  clearRect: vi.fn(),
  drawImage: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  strokeRect: vi.fn(),
  fillRect: vi.fn(),
  fillText: vi.fn(),
  strokeText: vi.fn(),
  closePath: vi.fn(),
  fill: vi.fn(),
  setLineDash: vi.fn(),
  getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })),
  putImageData: vi.fn(),
};

class LoadedImage {
  naturalWidth = 1200;
  naturalHeight = 3600;
  width = 1200;
  height = 3600;
  onload: null | (() => void) = null;
  onerror: null | (() => void) = null;
  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

beforeEach(() => {
  useBrowser.setState({ notice: null, error: null });
  vi.spyOn(ipc, "captureRead").mockResolvedValue("aW1hZ2U=");
  vi.spyOn(ipc, "captureSave").mockResolvedValue("/tmp/dive-annotated.png");
  vi.stubGlobal("Image", LoadedImage);
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => context });
  Object.defineProperty(HTMLCanvasElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 1800, width: 600, height: 1800, toJSON: () => ({}) }),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", { configurable: true, value: () => "data:image/png;base64,Y2FwdHVyZQ==" });
  Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", { configurable: true, value: (callback: BlobCallback, type?: string) => callback(new Blob(["capture"], type ? { type } : undefined)) });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:dive-capture") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("capture internal page", () => {
  it("opens a full editor with capture, annotation and export controls", async () => {
    render(<InternalPage tab={capture} />);

    expect(await screen.findByRole("main", { name: "Capture editor" })).toBeTruthy();
    expect(screen.getByText("Example Docs")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Crop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rectangle" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Arrow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pen" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Highlight" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Text" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Blur sensitive content" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export PNG" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export JPEG" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export PDF" })).toBeTruthy();
  });

  it("loads the full-resolution image and keeps annotation edits undoable", async () => {
    render(<InternalPage tab={capture} />);

    const canvas = await screen.findByRole("img", { name: "Full-page capture preview" });
    expect(canvas.getAttribute("width")).toBe("1200");
    expect(canvas.getAttribute("height")).toBe("3600");
    const undo = screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement;
    expect(undo.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Rectangle" }));
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 20, clientY: 30 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 180, clientY: 130 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 180, clientY: 130 });
    await waitFor(() => expect(undo.disabled).toBe(false));
    fireEvent.click(undo);
    expect((screen.getByRole("button", { name: "Redo" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("copies the edited pixels and reports completion", async () => {
    render(<InternalPage tab={capture} />);
    await screen.findByRole("img", { name: "Full-page capture preview" });

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("exports a paginated PDF with a useful filename and completion notice", async () => {
    let downloaded = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloaded = this.download; });
    render(<InternalPage tab={capture} />);
    await screen.findByRole("img", { name: "Full-page capture preview" });

    fireEvent.change(screen.getByRole("combobox", { name: "PDF page size" }), { target: { value: "a4" } });
    fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));

    await waitFor(() => expect(downloaded).toBe("example-docs-full-page.pdf"));
    expect(useBrowser.getState().notice).toBe("Exported example-docs-full-page.pdf");
    const pdf = vi.mocked(URL.createObjectURL).mock.calls.at(-1)?.[0];
    if (!(pdf instanceof Blob)) throw new Error("PDF export did not create a Blob");
    expect(pdf.type).toBe("application/pdf");
    const bytes = new Uint8Array(await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(pdf);
    }));
    const documentText = new TextDecoder().decode(bytes);
    expect(documentText.startsWith("%PDF-1.4")).toBe(true);
    expect(documentText).toContain("/Type /Pages");
    expect(documentText).toContain("/Count 3");
  });
});
