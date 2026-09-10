import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const win = { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn(), isMaximized: vi.fn(() => Promise.resolve(false)), onResized: vi.fn(() => Promise.resolve(() => {})) };
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));

import { WindowControls } from "./WindowControls";

/** The component decides by platform, which the tests have to be able to set. */
function platform(value: string) {
  Object.defineProperty(navigator, "platform", { configurable: true, get: () => value });
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("WindowControls", () => {
  it("draws nothing on macOS, where the frame has the traffic lights", () => {
    platform("MacIntel");
    const { container } = render(<WindowControls />);
    expect(container.firstChild).toBeNull();
  });

  it("draws minimise, maximise and close on Windows", () => {
    platform("Win32");
    render(<WindowControls />);
    for (const name of ["Minimise", "Maximise", "Close"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("is not a drag region, so a click presses the button", () => {
    // The row around it is the window handle; these are controls inside it,
    // and without this a press would start moving the window instead.
    platform("Win32");
    const { container } = render(<WindowControls />);
    expect((container.firstChild as HTMLElement).getAttribute("data-tauri-drag-region")).toBe("false");
  });
});
