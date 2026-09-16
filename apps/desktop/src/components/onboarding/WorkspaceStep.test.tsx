import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStep } from "./WorkspaceStep";

const platform = Object.getOwnPropertyDescriptor(navigator, "platform");

afterEach(() => {
  cleanup();
  if (platform) Object.defineProperty(navigator, "platform", platform);
});

describe("WorkspaceStep", () => {
  it("does not name ⌘ chords for jumping workspaces on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    render(<WorkspaceStep />);
    expect(document.body.textContent).not.toMatch(/⌘/);
    expect(document.body.textContent).toMatch(/Ctrl\+1 to Ctrl\+9/);
  });
});
