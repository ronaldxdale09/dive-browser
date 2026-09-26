import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { announce, currentAnnouncements, resetAnnouncements } from "../lib/announce";
import { NOTICE_ACTION_MS, useBrowser } from "../store/browser";
import { DialogLoading, LiveRegions, ToastViewport } from "./ChromeFeedback";

afterEach(() => {
  cleanup();
  resetAnnouncements();
  vi.useRealTimers();
  useBrowser.setState({ notice: null, noticeAction: null, error: null });
});

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
    expect(screen.getByText("Saved report.pdf")).toBeTruthy();
    // Said through the standing region, with the action named.
    expect(currentAnnouncements().polite?.text).toBe("Saved report.pdf. Show in Finder is in the notification.");
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

describe("LiveRegions", () => {
  it("is in the document before anything is said, and says the same words twice as two messages", () => {
    const { container } = render(<LiveRegions />);
    const polite = container.querySelector('[aria-live="polite"]')!;
    const assertive = container.querySelector('[aria-live="assertive"]')!;
    expect(polite.textContent).toBe("");
    expect(assertive.getAttribute("role")).toBe("alert");
    act(() => announce("Copied the address"));
    const first = polite.firstElementChild;
    expect(polite.textContent).toBe("Copied the address");
    act(() => announce("Copied the address"));
    // A new node, so a screen reader hears the second copy too.
    expect(polite.firstElementChild).not.toBe(first);
    act(() => announce("Could not save", "assertive"));
    expect(assertive.textContent).toBe("Could not save");
    expect(polite.textContent).toBe("Copied the address");
  });

  it("clears a message once it has been said", () => {
    vi.useFakeTimers();
    const { container } = render(<LiveRegions />);
    act(() => announce("Saved"));
    act(() => vi.advanceTimersByTime(10_000));
    expect(container.querySelector('[aria-live="polite"]')!.textContent).toBe("");
  });
});

describe("notice timing", () => {
  function Toasts() {
    const notice = useBrowser((s) => s.notice);
    const noticeAction = useBrowser((s) => s.noticeAction);
    return <ToastViewport notice={notice} noticeAction={noticeAction} error={null} onDismissNotice={() => useBrowser.setState({ notice: null })} onDismissError={() => undefined} />;
  }

  it("waits while the pointer is over the notice or focus is in it", () => {
    vi.useFakeTimers();
    render(<Toasts />);
    act(() => useBrowser.getState().notify("Copied", 3000));
    const toast = screen.getByText("Copied").parentElement!;
    fireEvent.mouseEnter(toast);
    act(() => vi.advanceTimersByTime(5000));
    expect(useBrowser.getState().notice).toBe("Copied");
    fireEvent.mouseLeave(toast);
    fireEvent.focus(screen.getByRole("button", { name: "Dismiss notification" }));
    act(() => vi.advanceTimersByTime(5000));
    expect(useBrowser.getState().notice).toBe("Copied");
    fireEvent.blur(screen.getByRole("button", { name: "Dismiss notification" }));
    act(() => vi.advanceTimersByTime(3000));
    expect(useBrowser.getState().notice).toBeNull();
  });

  it("gives a notice with a button long enough to reach it", () => {
    vi.useFakeTimers();
    render(<Toasts />);
    act(() => useBrowser.getState().notify("Closed 3 tabs", 3000, { label: "Undo", run: () => undefined }));
    act(() => vi.advanceTimersByTime(NOTICE_ACTION_MS - 100));
    expect(useBrowser.getState().notice).toBe("Closed 3 tabs");
    act(() => vi.advanceTimersByTime(200));
    expect(useBrowser.getState().notice).toBeNull();
  });

  it("says an error assertively", () => {
    render(<ToastViewport notice={null} error="The engine stopped" onDismissNotice={() => undefined} onDismissError={() => undefined} />);
    expect(currentAnnouncements().assertive?.text).toBe("The engine stopped");
  });
});
