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

  it("does not say everything is a keystroke or that the palette finds the rest", () => {
    render(<FeaturesStep />);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Everything is a keystroke away/);
    expect(text).not.toMatch(/finds the rest/);
    expect(text).toMatch(/commands that apply here/);
  });

  it("does not say ads are blocked in the engine before finish writes the pref", () => {
    render(<FeaturesStep />);
    expect(document.body.textContent).not.toMatch(/In the engine/);
    expect(document.body.textContent).toMatch(/when you start browsing/i);
  });

  it("names the MCP clients Settings › Developer names, not only Claude Code", () => {
    render(<FeaturesStep />);
    expect(document.body.textContent).toMatch(/over MCP from Claude Code, Cursor or Codex/);
  });

  it("does not name ⌘ chords for workspaces, the agent, the dock, or the palette on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    render(<FeaturesStep />);
    expect(document.body.textContent).not.toMatch(/⌘/);
    expect(document.body.textContent).toMatch(/Ctrl\+1–9/);
    expect(document.body.textContent).toMatch(/Ctrl\+J/);
    expect(document.body.textContent).toMatch(/Ctrl\+Shift\+D/);
    expect(document.body.textContent).toMatch(/Ctrl\+Alt\+Shift\+R/);
    expect(document.body.textContent).toMatch(/Ctrl\+K finds commands that apply here/);
  });
});
