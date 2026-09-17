import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../lib/ipc";
import { useBrowserImport } from "../../store/browserImport";
import { useOnboarding } from "../../store/onboarding";
import { ImportStep } from "./ImportStep";

const initialImport = useBrowserImport.getState();
const platform = Object.getOwnPropertyDescriptor(navigator, "platform");

beforeEach(() => {
  vi.spyOn(ipc, "browserImportSources").mockImplementation(() => new Promise(() => {}));
  useOnboarding.setState({ stage: "import", skipped: [] });
});

afterEach(() => {
  cleanup();
  useBrowserImport.setState(initialImport, true);
  useOnboarding.setState({ stage: null });
  vi.restoreAllMocks();
  if (platform) Object.defineProperty(navigator, "platform", platform);
});

describe("ImportStep", () => {
  it("does not say it reads the browser you have been using on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    render(<ImportStep />);
    expect(document.body.textContent).not.toMatch(/browser you have been using/);
    expect(document.body.textContent).toMatch(/another browser/);
  });
});
