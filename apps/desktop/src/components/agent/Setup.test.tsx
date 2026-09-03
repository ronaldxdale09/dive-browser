import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "../../lib/ipc";
import { useAgent } from "../../store/agent";
import { usePrefs } from "../../store/prefs";
import { Setup } from "./Setup";

const MOCK_PROVIDERS: ProviderInfo[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    wire: "anthropic",
    base_url: "https://api.anthropic.com",
    key_url: "https://console.anthropic.com",
    key_hint: "sk-ant-...",
    needs_key: true,
    lists_models: true,
    default_model: "claude-3-7-sonnet",
    note: "Claude, first party. Best at driving a page.",
  },
  {
    id: "openai",
    name: "OpenAI",
    wire: "open_ai",
    base_url: "https://api.openai.com/v1",
    key_url: "https://platform.openai.com/api-keys",
    key_hint: "sk-...",
    needs_key: true,
    lists_models: true,
    default_model: "gpt-4o",
    note: "GPT models.",
  },
  {
    id: "ollama",
    name: "Ollama",
    wire: "open_ai",
    base_url: "http://localhost:11434/v1",
    key_url: "",
    key_hint: "",
    needs_key: false,
    lists_models: true,
    default_model: "llama3.3",
    note: "Local models, running on this machine.",
  },
];

beforeEach(() => {
  useAgent.setState({
    providers: MOCK_PROVIDERS,
    keyed: [],
    loaded: true,
    verifyKey: vi.fn().mockResolvedValue({ ok: true, message: "Valid key." }),
    saveKey: vi.fn().mockResolvedValue(undefined),
  });
  usePrefs.setState({
    prefs: {
      ...usePrefs.getState().prefs,
      agent_provider: "anthropic",
      agent_model: "claude-3-7-sonnet",
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Setup", () => {
  it("renders onboarding hero when no keys are configured", () => {
    render(<Setup canGoBack={false} onDone={() => {}} />);
    expect(screen.getByText("Connect Model Provider")).toBeTruthy();
    expect(screen.getByText(/inspect DOM elements/)).toBeTruthy();
    expect(screen.getByText(/stored in macOS Keychain/)).toBeTruthy();
  });

  it("allows selecting a local provider", () => {
    render(<Setup canGoBack={true} onDone={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /Ollama/ }));

    expect(screen.getByText("Local & Offline Model")).toBeTruthy();
  });

  it("handles back button when canGoBack is true", () => {
    const onDone = vi.fn();
    render(<Setup canGoBack={true} onDone={onDone} />);

    const backButton = screen.getByLabelText("Back to chat");
    fireEvent.click(backButton);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
