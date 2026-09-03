import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCK_LIMITS, SIDECAR_LIMITS } from "../lib/resize";
import { ResizeHandle } from "./ResizeHandle";

afterEach(cleanup);

describe("ResizeHandle", () => {
  it("reports live sizes while dragging and commits the last one on release", () => {
    const onResize = vi.fn();
    const onCommit = vi.fn();
    render(<ResizeHandle orientation="vertical" label="Resize agent panel" value={360} limits={SIDECAR_LIMITS} onResize={onResize} onCommit={onCommit} />);
    const handle = screen.getByRole("separator", { name: "Resize agent panel" });
    expect(handle.getAttribute("aria-valuenow")).toBe("360");
    expect(handle.getAttribute("aria-valuemin")).toBe("280");

    fireEvent.pointerDown(handle, { button: 0, clientX: 500, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 460, clientY: 0 });
    expect(onResize).toHaveBeenLastCalledWith(400);
    // Far past the limit, the size stops at it.
    fireEvent.pointerMove(window, { clientX: -2000, clientY: 0 });
    expect(onResize).toHaveBeenLastCalledWith(720);
    fireEvent.pointerUp(window);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(720);

    // Released: later moves are nobody's business.
    fireEvent.pointerMove(window, { clientX: 100, clientY: 0 });
    expect(onResize).toHaveBeenCalledTimes(2);
  });

  it("measures a horizontal handle along the y axis and ignores other buttons", () => {
    const onResize = vi.fn();
    const onCommit = vi.fn();
    render(<ResizeHandle orientation="horizontal" label="Resize dock" value={240} limits={DOCK_LIMITS} onResize={onResize} onCommit={onCommit} />);
    const handle = screen.getByRole("separator", { name: "Resize dock" });
    fireEvent.pointerDown(handle, { button: 2, clientX: 0, clientY: 700 });
    fireEvent.pointerMove(window, { clientX: 0, clientY: 600 });
    expect(onResize).not.toHaveBeenCalled();

    fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 700 });
    fireEvent.pointerMove(window, { clientX: 0, clientY: 600 });
    expect(onResize).toHaveBeenLastCalledWith(340);
    fireEvent.pointerUp(window);
    expect(onCommit).toHaveBeenCalledWith(340);
  });

  it("nudges with the arrow keys for keyboard users", () => {
    const onCommit = vi.fn();
    render(<ResizeHandle orientation="horizontal" label="Resize dock" value={240} limits={DOCK_LIMITS} onResize={() => undefined} onCommit={onCommit} />);
    const handle = screen.getByRole("separator", { name: "Resize dock" });
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(onCommit).toHaveBeenLastCalledWith(256);
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(onCommit).toHaveBeenLastCalledWith(224);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onCommit).toHaveBeenCalledTimes(2);
  });
});
