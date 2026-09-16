import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS, usePrefs } from "../../store/prefs";
import { ipc } from "../../lib/ipc";
import { General } from "./General";

const initialPrefs = usePrefs.getState();
const platform = Object.getOwnPropertyDescriptor(navigator, "platform");

beforeEach(() => {
  usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });
  vi.spyOn(ipc, "backupExport").mockResolvedValue(null);
  vi.spyOn(ipc, "backupRestore").mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  usePrefs.setState(initialPrefs, true);
  vi.restoreAllMocks();
  if (platform) Object.defineProperty(navigator, "platform", platform);
});

describe("Settings › General", () => {
  it("does not say Safari bookmarks can be read on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    render(<General />);
    expect(document.body.textContent).not.toMatch(/from Safari/);
    expect(document.body.textContent).toMatch(/AppData/);
  });

  it("does not say a backup leaves passwords only in the Keychain on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    render(<General />);
    expect(document.body.textContent).not.toMatch(/Keychain/);
    expect(document.body.textContent).toMatch(/Credential Manager/);
  });

  it("does not say the default download folder is ~/Downloads on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    render(<General />);
    expect(document.body.textContent).not.toMatch(/~\//);
    expect(screen.getByLabelText("Save files to").getAttribute("placeholder")).not.toBe("~/Downloads");
    expect(document.body.textContent).toMatch(/Downloads folder/);
  });

  it("does not name ⌘ chords for zoom and fill-tab on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    render(<General />);
    expect(document.body.textContent).not.toMatch(/⌘/);
    expect(document.body.textContent).toMatch(/Ctrl\+=/);
    expect(document.body.textContent).toMatch(/Ctrl\+Shift\+F/);
  });
});
