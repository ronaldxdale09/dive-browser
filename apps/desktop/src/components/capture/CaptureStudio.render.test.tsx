import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CaptureStudio } from "./CaptureStudio";

afterEach(() => {
  cleanup();
});

describe("CaptureStudio", () => {
  it("does not say captures stay only on this Mac", () => {
    render(<CaptureStudio src={null} sourceUrl={null} sourceTitle={null} />);
    expect(screen.queryByText(/this Mac/)).toBeNull();
    expect(screen.getByText("Everything stays on this computer")).toBeTruthy();
  });
});
