import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "./ipc";
import { resetContentCover, useCoversContent } from "./overlay";

function Overlay({ active = true }: { active?: boolean }) {
  useCoversContent(active);
  return null;
}

afterEach(() => {
  cleanup();
  resetContentCover();
  vi.restoreAllMocks();
});

describe("useCoversContent", () => {
  it("captures the visible page before hiding the native view", async () => {
    let finishCapture!: (value: { tab_id: string; data_url: string }[]) => void;
    const capture = vi.fn(
      () =>
        new Promise<{ tab_id: string; data_url: string }[]>((resolve) => {
          finishCapture = resolve;
        }),
    );
    vi.spyOn(ipc, "prepareContentCover").mockImplementation(capture);
    const covered = vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);

    const view = render(<Overlay />);

    expect(capture).toHaveBeenCalledTimes(1);
    expect(covered).not.toHaveBeenCalled();

    await act(async () => finishCapture([{ tab_id: "tab-a", data_url: "data:image/jpeg;base64,real-page" }]));
    await waitFor(() => expect(covered).toHaveBeenCalledWith(true));

    view.unmount();
  });

  it("hides the page for as long as at least one overlay is on screen", async () => {
    vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
    const covered = vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);

    const first = render(<Overlay />);
    await waitFor(() => expect(covered.mock.calls).toEqual([[true]]));

    const second = render(<Overlay />);
    first.unmount();
    expect(covered.mock.calls).toEqual([[true]]);

    second.unmount();
    expect(covered.mock.calls).toEqual([[true], [false]]);
  });

  it("does not hide the page when the overlay closes before capture finishes", async () => {
    let finishCapture!: (value: []) => void;
    vi.spyOn(ipc, "prepareContentCover").mockImplementation(
      () =>
        new Promise<[]>((resolve) => {
          finishCapture = resolve;
        }),
    );
    const covered = vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);

    const view = render(<Overlay />);
    view.unmount();
    await act(async () => finishCapture([]));

    expect(covered).not.toHaveBeenCalled();
  });

  it("leaves the page alone for an overlay that is not showing", () => {
    vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
    const covered = vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);

    const view = render(<Overlay active={false} />);
    view.unmount();

    expect(covered).not.toHaveBeenCalled();
  });
});
