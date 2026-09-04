import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeErrorBoundary } from "./ChromeErrorBoundary";

afterEach(() => {
  cleanup();
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
});
