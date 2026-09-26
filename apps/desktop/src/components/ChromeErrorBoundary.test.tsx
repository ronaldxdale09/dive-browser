import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { contentCoverDepth, resetContentCover } from "../lib/overlay";
import { ChromeErrorBoundary } from "./ChromeErrorBoundary";

afterEach(() => {
  cleanup();
  resetContentCover();
  vi.restoreAllMocks();
});

describe("ChromeErrorBoundary", () => {
  it("keeps a render failure recoverable", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let broken = true;
    function Child() {
      if (broken) throw new Error("render exploded");
      return <p>Chrome restored</p>;
    }

    render(
      <ChromeErrorBoundary>
        <Child />
      </ChromeErrorBoundary>,
    );

    expect(screen.getByRole("alert").textContent).toContain("controls hit a problem");
    expect(screen.getByText("render exploded")).toBeTruthy();
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("Chrome restored")).toBeTruthy();
  });

  it("covers the page while the recovery card is up and tells the host log", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const covered = vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
    vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
    const logged = vi.spyOn(ipc, "logChromeError").mockResolvedValue(undefined);
    let broken = true;
    function Child() {
      if (broken) throw new Error("render exploded");
      return <p>Chrome restored</p>;
    }

    render(
      <ChromeErrorBoundary>
        <Child />
      </ChromeErrorBoundary>,
    );

    // The card sits where the native page paints; without the cover it is
    // drawn underneath the page and nobody sees it.
    expect(covered).toHaveBeenCalledWith(true);
    expect(contentCoverDepth()).toBe(1);
    expect(logged).toHaveBeenCalledWith("render", "render exploded", expect.any(String));
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(contentCoverDepth()).toBe(0);
  });
});
