import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { useBrowserImport } from "../store/browserImport";
import { ImportDialog } from "./ImportDialog";

const initial = useBrowserImport.getState();
const platform = Object.getOwnPropertyDescriptor(navigator, "platform");

beforeEach(() => {
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  vi.spyOn(ipc, "browserImportSources").mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  cleanup();
  useBrowserImport.setState(initial, true);
  vi.restoreAllMocks();
  if (platform) Object.defineProperty(navigator, "platform", platform);
});

describe("ImportDialog", () => {
  it("does not say import reads a browser on this Mac on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    render(<ImportDialog />);
    expect(document.body.textContent).not.toMatch(/this Mac/);
    expect(document.body.textContent).toMatch(/from another browser/);
  });
});
