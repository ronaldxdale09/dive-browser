import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { editorOwnsKey } from "./DiveScreen";
import { buildSegments, outputDuration } from "./math";
import { newProject } from "./model";
import { canRetime, useEditor } from "./store";
import { Timeline } from "./Timeline";

const media = { source: "/tmp/recording.mp4", playable: "/tmp/recording.webm", events: null, durationMs: 10_000, width: 1280, height: 720 };
const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");

beforeAll(() => {
  // jsdom lays nothing out; the lanes need a width for pills to be drawn.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
});
afterAll(() => {
  if (width) Object.defineProperty(HTMLElement.prototype, "clientWidth", width);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const project = newProject(media);
  project.editor.zooms = [];
  project.editor.trims = [
    { id: "t1", startMs: 1000, endMs: 2000 },
    { id: "t2", startMs: 2500, endMs: 3000 },
  ];
  const segments = buildSegments(media.durationMs, [], []);
  useEditor.setState({ project, source: media.source, playable: "blob:test", segments, duration: outputDuration(segments), playhead: 0, playing: false, selection: null, cursorRaw: [], cursorSmooth: [], past: [], future: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useEditor.setState({ project: null, source: null, playable: null, playhead: 0, playing: false, selection: null });
});

describe("canRetime", () => {
  const list = [
    { id: "a", startMs: 0, endMs: 1000 },
    { id: "b", startMs: 2000, endMs: 3000 },
  ];
  it("keeps an item inside the recording, at least 100 ms long, and off its neighbours", () => {
    expect(canRetime(list, "a", 100, 1100, 5000, true)).toBe(true);
    expect(canRetime(list, "a", -1, 900, 5000, true)).toBe(false);
    expect(canRetime(list, "a", 0, 50, 5000, true)).toBe(false);
    expect(canRetime(list, "a", 1500, 2500, 5000, true)).toBe(false);
    expect(canRetime(list, "b", 2000, 5001, 5000, true)).toBe(false);
    // Notes may overlap.
    expect(canRetime(list, "a", 1500, 2500, 5000, false)).toBe(true);
  });
});

describe("editorOwnsKey", () => {
  it("leaves keys to buttons, switches, radios, tabs, links and sliders", () => {
    for (const html of ["<button></button>", '<div role="switch" tabindex="0"></div>', '<div role="radio" tabindex="0"></div>', '<div role="tab" tabindex="0"></div>', '<a href="#">x</a>', '<input type="range">', "<input>"]) {
      const host = document.createElement("div");
      host.innerHTML = html;
      document.body.append(host);
      expect(editorOwnsKey(host.firstElementChild)).toBe(false);
      host.remove();
    }
  });

  it("takes keys on the stage, the timeline, its items, or nothing focused", () => {
    const surface = document.createElement("div");
    surface.setAttribute("data-editor-surface", "");
    const item = document.createElement("div");
    item.setAttribute("data-timeline-item", "");
    document.body.append(surface, item);
    expect(editorOwnsKey(surface)).toBe(true);
    expect(editorOwnsKey(item)).toBe(true);
    expect(editorOwnsKey(document.body)).toBe(true);
    surface.remove();
    item.remove();
  });
});

describe("Timeline keyboard", () => {
  it("is one Tab stop, and focusing an item selects it", () => {
    render(<Timeline />);
    const [first, second] = screen.getAllByRole("button", { name: /^Cut Trim/ }) as [HTMLElement, HTMLElement];
    expect([first.tabIndex, second.tabIndex]).toEqual([0, -1]);
    act(() => second.focus());
    expect(useEditor.getState().selection).toEqual({ kind: "trim", id: "t2" });
    expect(second.tabIndex).toBe(0);
  });

  it("moves an item with the arrows, trims its end with Option, and will not push it onto a neighbour", () => {
    render(<Timeline />);
    const item = screen.getAllByRole("button", { name: /^Cut Trim/ })[0]!;
    act(() => item.focus());
    fireEvent.keyDown(item, { key: "ArrowRight" });
    expect(useEditor.getState().project!.editor.trims[0]).toMatchObject({ startMs: 1100, endMs: 2100 });
    fireEvent.keyDown(item, { key: "ArrowLeft", shiftKey: true });
    expect(useEditor.getState().project!.editor.trims[0]).toMatchObject({ startMs: 100, endMs: 1100 });
    fireEvent.keyDown(item, { key: "ArrowRight", altKey: true });
    expect(useEditor.getState().project!.editor.trims[0]).toMatchObject({ startMs: 100, endMs: 1200 });
    fireEvent.keyDown(item, { key: "ArrowRight", shiftKey: true });
    expect(useEditor.getState().project!.editor.trims[0]).toMatchObject({ startMs: 1100, endMs: 2200 });
    // Another second to the right would land on the next cut, at 2.5 s.
    fireEvent.keyDown(item, { key: "ArrowRight", shiftKey: true });
    expect(useEditor.getState().project!.editor.trims[0]).toMatchObject({ startMs: 1100, endMs: 2200 });
    expect(screen.getByRole("status").textContent).toMatch(/cannot overlap/);
    // The playhead is the editor's arrows' business, not the item's.
    expect(useEditor.getState().playhead).toBe(0);
  });
});
