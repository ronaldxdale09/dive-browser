import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "../../lib/ipc";
import { ipc } from "../../lib/ipc";
import { resetContentCover } from "../../lib/overlay";
import { useAgent } from "../../store/agent";
import { usePrefs } from "../../store/prefs";
import { ModelPicker } from "./ModelPicker";

const provider: ProviderInfo = {
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

const initialAgent = useAgent.getState();
const initialPrefs = usePrefs.getState();

beforeEach(() => {
  resetContentCover();
  vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  useAgent.setState({
    providers: [provider],
    keyed: ["anthropic"],
    models: {
      anthropic: [
        {
          id: "claude-opus-5",
          name: "Claude Opus 5",
          context_length: null,
          tools: true,
          reasoning: true,
          input_per_mtok: null,
          output_per_mtok: null,
        },
      ],
    },
    modelsLoading: null,
    modelsError: null,
    loadModels: vi.fn().mockResolvedValue([]),
  });
  usePrefs.setState({
    prefs: { ...usePrefs.getState().prefs, agent_provider: "anthropic", agent_model: "claude-opus-5" },
    update: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  cleanup();
  resetContentCover();
  useAgent.setState(initialAgent, true);
  usePrefs.setState(initialPrefs, true);
  vi.restoreAllMocks();
});

describe("ModelPicker", () => {
  it("covers the page, traps focus, and restores the trigger after Escape", async () => {
    render(<ModelPicker onAddProvider={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Claude Opus 5/ });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Model and provider" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await waitFor(() => expect(ipc.prepareContentCover).toHaveBeenCalledTimes(1));

    const last = screen.getByRole("radio", { name: "Max" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Model and provider" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
