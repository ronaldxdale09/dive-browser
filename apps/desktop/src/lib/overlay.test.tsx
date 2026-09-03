import { cleanup, render } from "@testing-library/react";
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
  it("hides the page for as long as at least one overlay is on screen", () => {
    const covered = vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);

    const first = render(<Overlay />);
    expect(covered.mock.calls).toEqual([[true]]);

    const second = render(<Overlay />);
    first.unmount();
    expect(covered.mock.calls).toEqual([[true]]);

    second.unmount();
    expect(covered.mock.calls).toEqual([[true], [false]]);
  });

  it("leaves the page alone for an overlay that is not showing", () => {
    const covered = vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);

    const view = render(<Overlay active={false} />);
    view.unmount();

    expect(covered).not.toHaveBeenCalled();
  });
});
