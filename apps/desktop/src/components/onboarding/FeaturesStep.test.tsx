import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../lib/ipc";
import { useDefaultBrowser } from "../../store/defaultBrowser";
import { FeaturesStep } from "./FeaturesStep";

const platform = Object.getOwnPropertyDescriptor(navigator, "platform");
const initial = useDefaultBrowser.getState();

beforeEach(() => {
  vi.spyOn(ipc, "defaultBrowserStatus").mockResolvedValue({ supported: true, is_default: false, current: null });
  useDefaultBrowser.setState({ status: { supported: true, is_default: false, current: null }, phase: "idle", error: null });
});

afterEach(() => {
  cleanup();
  useDefaultBrowser.setState(initial, true);
  vi.restoreAllMocks();
  if (platform) Object.defineProperty(navigator, "platform", platform);
});

describe("FeaturesStep", () => {
  it("does not say macOS will confirm the default browser on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    render(<FeaturesStep />);
    expect(document.body.textContent).not.toMatch(/macOS/);
    expect(document.body.textContent).toMatch(/Windows Settings will open so you can pick Dive/);
  });

  it("does not say macOS is asking when Windows is waiting for Settings", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    useDefaultBrowser.setState({ phase: "waiting" });
    render(<FeaturesStep />);
    expect(document.body.textContent).not.toMatch(/macOS/);
    expect(document.body.textContent).toMatch(/Settings › Apps › Default apps/);
  });
});
