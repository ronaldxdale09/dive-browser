import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChromeRoot } from "./ChromeRoot";
import { ChromeErrorBoundary } from "./ChromeErrorBoundary";

vi.mock("../App", () => { throw new Error("UI module unavailable"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("routes a failed async module load into the existing visible recovery controls", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(<ChromeErrorBoundary><ChromeRoot tabId={null} /></ChromeErrorBoundary>);
  await act(() => vi.dynamicImportSettled());
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.getByText("Dive's controls hit a problem")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reload window" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(screen.queryByLabelText("Loading Dive")).toBeNull();
});
