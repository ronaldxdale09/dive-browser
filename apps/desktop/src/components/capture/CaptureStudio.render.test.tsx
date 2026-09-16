import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CaptureStudio } from "./CaptureStudio";

const platform = Object.getOwnPropertyDescriptor(navigator, "platform");

afterEach(() => {
  cleanup();
  if (platform) Object.defineProperty(navigator, "platform", platform);
});

describe("CaptureStudio", () => {
  it("does not say captures stay only on this Mac", () => {
    render(<CaptureStudio src={null} sourceUrl={null} sourceTitle={null} />);
    expect(screen.queryByText(/this Mac/)).toBeNull();
    expect(screen.getByText("Everything stays on this computer")).toBeTruthy();
  });

  it("names Explorer when revealing a capture on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    render(<CaptureStudio src={null} sourceUrl={null} sourceTitle={null} />);
    expect(screen.getByRole("button", { name: "Original in Explorer" })).toBeTruthy();
    expect(screen.queryByText("Original in Finder")).toBeNull();
  });
});
