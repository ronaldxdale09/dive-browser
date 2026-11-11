import { afterEach, describe, expect, it, vi } from "vitest";
import { Renderer } from "./render";
import { newProject } from "./model";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function project(wallpaper: string) {
  const p = newProject({ source: "original.mp4", playable: "original.webm", events: null, durationMs: 1000, width: 64, height: 64 });
  return { ...p, editor: { ...p.editor, wallpaper } };
}

afterEach(() => vi.restoreAllMocks());

describe("Renderer.preload", () => {
  it("waits for the wallpaper to decode", async () => {
    let release: () => void = () => undefined;
    const decoding = new Promise<void>((resolve) => {
      release = resolve;
    });
    const decode = vi.fn(() => decoding);
    Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, writable: true, value: decode });
    try {
      const renderer = new Renderer();
      let done = false;
      const pending = renderer.preload(project(PNG)).then(() => {
        done = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(decode).toHaveBeenCalledOnce();
      expect(done).toBe(false);
      release();
      await pending;
      expect(done).toBe(true);
    } finally {
      Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
    }
  });

  it("resolves at once when no picture is involved", async () => {
    await expect(new Renderer().preload(project("#112233"))).resolves.toBeUndefined();
  });
});

describe("Renderer.stepCursor", () => {
  it("covers the same ground per second of content whatever the frame rate", () => {
    const start = { cx: 0.1, cy: 0.1 };
    const target = { cx: 0.9, cy: 0.9 };
    const coarse = new Renderer();
    const fine = new Renderer();
    coarse.stepCursor(start, Number.NaN, true);
    fine.stepCursor(start, Number.NaN, true);
    let a = start;
    let b = start;
    for (let i = 0; i < 10; i++) a = coarse.stepCursor(target, 100, true);
    for (let i = 0; i < 60; i++) b = fine.stepCursor(target, 1000 / 60, true);
    expect(Math.abs(a.cx - b.cx)).toBeLessThan(0.02);
  });

  it("lands on the target when paused or after a jump", () => {
    const r = new Renderer();
    expect(r.stepCursor({ cx: 0.4, cy: 0.6 }, 16, false)).toEqual({ cx: 0.4, cy: 0.6 });
    expect(r.stepCursor({ cx: 0.9, cy: 0.1 }, 900, true)).toEqual({ cx: 0.9, cy: 0.1 });
  });
});
