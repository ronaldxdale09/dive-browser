import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "../../lib/ipc";
import { DEFAULT_PREFS, usePrefs } from "../../store/prefs";
import { useAgent } from "../../store/agent";
import { Agent, stepOptions } from "./Agent";

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

  it("saves a key it could not check, and says it could not", async () => {
    const saveKey = vi.fn().mockResolvedValue(undefined);
    useAgent.setState({
      providers: [anthropic],
      keyed: [],
      saveKey,
      verifyKey: vi.fn().mockResolvedValue({ ok: false, rejected: false, message: "Could not reach Anthropic: timed out" }),
    });
    render(<Agent />);
    fireEvent.change(screen.getByLabelText("Anthropic API key"), { target: { value: "sk-ant-offline" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveKey).toHaveBeenCalledWith("anthropic", "sk-ant-offline"));
    expect(await screen.findByText(/Saved; couldn't verify it/)).toBeTruthy();
  });

  it("does not save a key the provider refused", async () => {
    const saveKey = vi.fn().mockResolvedValue(undefined);
    useAgent.setState({
      providers: [anthropic],
      keyed: [],
      saveKey,
      verifyKey: vi.fn().mockResolvedValue({ ok: false, rejected: true, message: "Anthropic rejected the key." }),
    });
    render(<Agent />);
    fireEvent.change(screen.getByLabelText("Anthropic API key"), { target: { value: "sk-ant-wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Anthropic rejected the key.")).toBeTruthy();
    expect(saveKey).not.toHaveBeenCalled();
  });

  it("clears a half-typed key on Escape before Escape can close Settings", () => {
    useAgent.setState({ providers: [anthropic], keyed: [] });
    render(<Agent />);
    const field = screen.getByLabelText("Anthropic API key") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "sk-ant-half" } });
    const outer = vi.fn();
    const { container } = { container: document.body };
    container.addEventListener("keydown", outer);
    fireEvent.keyDown(field, { key: "Escape" });
    container.removeEventListener("keydown", outer);
    expect(field.value).toBe("");
    // Stopped at the field, so the dialog around it never hears it.
    expect(outer).not.toHaveBeenCalled();
  });

  it("shows a step limit that is not a listed one as itself", () => {
    expect(stepOptions(25).some((o) => o.label.startsWith("Custom"))).toBe(false);
    expect(stepOptions(30).map((o) => o.label)).toEqual(["10", "25", "Custom (30)", "50", "100", "200"]);
  });
});
