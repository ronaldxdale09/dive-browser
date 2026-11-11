import { describe, expect, it, vi } from "vitest";
import { dragOnWindow } from "./drag";

const move = () => window.dispatchEvent(new Event("pointermove"));

describe("dragOnWindow", () => {
  it("ends once on pointercancel and stops following the pointer", () => {
    const onMove = vi.fn();
    const onEnd = vi.fn();
    dragOnWindow(onMove, onEnd);
    move();
    expect(onMove).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("pointercancel"));
    move();
    window.dispatchEvent(new Event("pointercancel"));
    expect(onMove).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("ends when the window loses focus", () => {
    const onEnd = vi.fn();
    dragOnWindow(vi.fn(), onEnd);
    window.dispatchEvent(new Event("blur"));
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("ends early through the returned disposer, and a second end is a no-op", () => {
    const onMove = vi.fn();
    const onEnd = vi.fn();
    const dispose = dragOnWindow(onMove, onEnd);
    dispose();
    dispose();
    window.dispatchEvent(new Event("pointerup"));
    move();
    expect(onMove).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(null);
  });
});
