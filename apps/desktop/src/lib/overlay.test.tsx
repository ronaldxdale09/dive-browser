import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "./ipc";
import { contentCoverDepth, resetContentCover, useContentPreview, useCoversContent } from "./overlay";

function Overlay({ active = true }: { active?: boolean }) {
  useCoversContent(active);
  return null;
}

function Preview() {
  const preview = useContentPreview("tab");
  return <output data-testid="preview">{preview ?? "none"}</output>;
}

afterEach(() => {
  cleanup();
  resetContentCover();
  vi.restoreAllMocks();
});

describe("useCoversContent", () => {
  it.each(["resolve", "reject"])("preserves the current preview when a previous uncover settles by %s", async (outcome) => {
    const uncovers: { resolve: (value: null) => void; reject: (error: Error) => void }[] = [];
    const covered = vi.spyOn(ipc, "setContentCovered").mockImplementation((value) => {
      if (value) return Promise.resolve(null);
      return new Promise<null>((resolve, reject) => uncovers.push({ resolve, reject }));
    });
    vi.spyOn(ipc, "prepareContentCover")
      .mockResolvedValueOnce([{ tab_id: "tab", data_url: "preview-a" }])
      .mockResolvedValueOnce([{ tab_id: "tab", data_url: "preview-b" }]);
    render(<Preview />);
    const first = render(<Overlay />);
    await waitFor(() => expect(covered.mock.calls).toEqual([[true]]));
    expect(screen.getByTestId("preview").textContent).toBe("preview-a");

    first.unmount();
    expect(uncovers).toHaveLength(1);
    const second = render(<Overlay />);
    await waitFor(() => expect(covered.mock.calls).toEqual([[true], [false], [true]]));
    expect(contentCoverDepth()).toBe(1);
    expect(screen.getByTestId("preview").textContent).toBe("preview-b");

    await act(async () => {
      if (outcome === "resolve") uncovers[0]!.resolve(null);
      else uncovers[0]!.reject(new Error("previous uncover failed"));
    });
    expect.soft(screen.getByTestId("preview").textContent).toBe("preview-b");

    // The current generation's final release still clears its preview even
    // when the engine rejects the uncover request.
    second.unmount();
    expect(contentCoverDepth()).toBe(0);
    expect(covered.mock.calls).toEqual([[true], [false], [true], [false]]);
    await act(async () => {
      if (outcome === "resolve") uncovers[1]!.resolve(null);
      else uncovers[1]!.reject(new Error("final uncover failed"));
    });
    expect(screen.getByTestId("preview").textContent).toBe("none");
  });

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
