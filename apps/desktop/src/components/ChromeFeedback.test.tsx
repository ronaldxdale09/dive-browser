import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DialogLoading, ToastViewport } from "./ChromeFeedback";

afterEach(cleanup);

describe("DialogLoading", () => {
  it("shows an immediately cancellable dialog while a panel loads", () => {
    const close = vi.fn();
    render(<DialogLoading onClose={close} />);
    expect(screen.getByRole("dialog", { name: "Loading dialog" })).toBeTruthy();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
    fireEvent.click(cancel);
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe("ToastViewport", () => {
  it("shows a notice's action and dismisses after running it", () => {
    const run = vi.fn();
    const dismiss = vi.fn();
    render(<ToastViewport notice="Saved report.pdf" noticeAction={{ label: "Show in Finder", run }} error={null} onDismissNotice={dismiss} onDismissError={() => undefined} />);
    expect(screen.getByRole("status").textContent).toContain("Saved report.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("renders nothing without a notice or error, and no action button without one", () => {
    const { container } = render(<ToastViewport notice={null} error={null} onDismissNotice={() => undefined} onDismissError={() => undefined} />);
    expect(container.innerHTML).toBe("");
    cleanup();
    render(<ToastViewport notice="Copied" error={null} onDismissNotice={() => undefined} onDismissError={() => undefined} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
