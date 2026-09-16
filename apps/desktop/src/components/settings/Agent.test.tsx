import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "../../lib/ipc";
import { DEFAULT_PREFS, usePrefs } from "../../store/prefs";
import { useAgent } from "../../store/agent";
import { Agent } from "./Agent";

const initialPrefs = usePrefs.getState();
const initialAgent = useAgent.getState();
const platform = Object.getOwnPropertyDescriptor(navigator, "platform");

const anthropic: ProviderInfo = {
  id: "anthropic",
  name: "Anthropic",
  wire: "anthropic",
  base_url: "https://api.anthropic.com",
  key_url: "https://console.anthropic.com",
  key_hint: "sk-ant-...",
  needs_key: true,
  lists_models: true,
  default_model: "claude-opus-5",
  note: "Claude, first party.",
};

beforeEach(() => {
  usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });
  useAgent.setState({ init: vi.fn().mockResolvedValue(undefined), loadModels: vi.fn().mockResolvedValue(undefined), providers: [], keyed: [] });
});

afterEach(() => {
  cleanup();
  usePrefs.setState(initialPrefs, true);
  useAgent.setState(initialAgent, true);
  vi.restoreAllMocks();
  if (platform) Object.defineProperty(navigator, "platform", platform);
});

describe("Settings › Agent", () => {
  it("does not say API keys leave only this Mac", () => {
    render(<Agent />);
    expect(document.body.textContent).not.toMatch(/this Mac/);
    expect(document.body.textContent).toMatch(/this computer/);
  });

  it("does not say API keys live in the Keychain on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    useAgent.setState({ providers: [anthropic], keyed: ["anthropic"] });
    render(<Agent />);
    expect(document.body.textContent).not.toMatch(/keychain/i);
    expect(document.body.textContent).toMatch(/Credential Manager/);
  });

  it("does not name ⌘J for the Agent panel on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    render(<Agent />);
    expect(document.body.textContent).not.toMatch(/⌘/);
    expect(document.body.textContent).toMatch(/Ctrl\+J/);
  });
});
