import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { DIALOG_FADE_MS } from "../lib/useFadeClose";
import { usePrefs } from "../store/prefs";
import { Modal, useModalClose } from "./Modal";

beforeEach(() => {
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Harness({ onClose, fade }: { onClose: () => void; fade?: boolean }) {
  const field = useRef<HTMLInputElement>(null);
  return (
    <Modal label="Thing" onClose={onClose} initialFocus={field} fade={fade} className="panel">
      <button type="button">first</button>
      <input ref={field} aria-label="field" />
      <Inner />
    </Modal>
  );
}

function Inner() {
  const close = useModalClose();
  return (
    <button type="button" onClick={close}>
      done
    </button>
  );
}

describe("Modal", () => {
  it("labels the dialog and focuses initialFocus", () => {
    render(<Harness onClose={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "Thing" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByLabelText("field"));
  });

  it("Escape closes after the fade", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(screen.getByLabelText("field"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(DIALOG_FADE_MS);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes at once under reduced motion", () => {
    usePrefs.setState({ prefs: { ...usePrefs.getState().prefs, motion: "reduce" } });
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(screen.getByLabelText("field"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    usePrefs.setState({ prefs: { ...usePrefs.getState().prefs, motion: "system" } });
  });

  it("closes at once without a fade, and a child can close it", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} fade={false} />);
    fireEvent.click(screen.getByRole("button", { name: "done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a scrim press but not on a press inside the dialog", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} fade={false} />);
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
