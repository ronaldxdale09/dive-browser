import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyCheck, ProviderInfo } from "../../lib/ipc";
import { ipc } from "../../lib/ipc";
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
const initialAgent = useAgent.getState();
const initialPrefs = usePrefs.getState();

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
  useAgent.setState(initialAgent, true);
  usePrefs.setState(initialPrefs, true);
  vi.restoreAllMocks();
});

describe("Setup", () => {
  it("uses only catalog providers and their names, without stale model labels", () => {
    useAgent.setState({ providers: [{ ...MOCK_PROVIDERS[0]!, name: "Catalog Anthropic", default_model: "catalog-model" }] });
    render(<Setup canGoBack={false} onDone={() => {}} />);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Catalog Anthropic"]);
    expect(screen.getByText("catalog-model")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /OpenAI/ })).toBeNull();
  });

  it("does not save or activate after the setup closes during verification", async () => {
    let resolve!: (value: { ok: boolean; message: string }) => void;
    useAgent.setState({ verifyKey: vi.fn(() => new Promise<KeyCheck>((done) => { resolve = done; })) });
    const update = vi.fn().mockResolvedValue(undefined);
    usePrefs.setState({ update });
    const done = vi.fn();
    const view = render(<Setup canGoBack={false} onDone={done} />);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "fixture" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and connect" }));
    view.unmount();
    await act(async () => { resolve({ ok: true, message: "ok" }); });
    expect(useAgent.getState().saveKey).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it("reports activation failure instead of leaving a false connected state", async () => {
    vi.spyOn(ipc, "prefsSet").mockRejectedValue(Error("Settings could not be saved"));
    const done = vi.fn();
    render(<Setup canGoBack={false} onDone={done} />);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "fixture" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and connect" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Settings could not be saved"));
    expect(screen.queryByText("Connection verified! Loading agent…")).toBeNull();
    expect(done).not.toHaveBeenCalled();
  });

  it("keeps setup busy until activation is saved and calls Done only after acknowledgment", async () => {
    let saved!: () => void;
    const update = vi.fn(() => new Promise<void>((resolve) => { saved = resolve; }));
    usePrefs.setState({ update });
    const done = vi.fn();
    render(<Setup canGoBack={false} onDone={done} />);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "fixture" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and connect" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ agent_provider: "anthropic" }), { rejectOnError: true });
    expect((screen.getByLabelText("All providers") as HTMLSelectElement).disabled).toBe(true);
    expect(done).not.toHaveBeenCalled();
    await act(async () => { saved(); });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("renders onboarding hero when no keys are configured", () => {
    render(<Setup canGoBack={false} onDone={() => {}} />);
    expect(screen.getByText("Connect a model provider")).toBeTruthy();
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
