import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo, Tab } from "../lib/ipc";
import { useAgent } from "../store/agent";
import { useBrowser } from "../store/browser";
import { usePrefs } from "../store/prefs";
import { Sidecar } from "./Sidecar";

const PROVIDERS: ProviderInfo[] = [
  {
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
    note: "Local models.",
  },
];

const tab: Tab = {
  id: "tab-1",
  workspace_id: "w",
  tier: "today",
  url: "https://example.com/docs",
  title: "Example docs",
  favicon: null,
  position: 0,
  state: "active",
  last_active_at: "2026-09-03T00:00:00Z",
};

const initialAgent = useAgent.getState();
const initialBrowser = useBrowser.getState();
const initialPrefs = usePrefs.getState();
const scrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, writable: true, value: vi.fn() });
  useAgent.setState({
    providers: PROVIDERS,
    keyed: ["anthropic"],
    loaded: true,
    messages: [],
    busy: false,
    init: vi.fn().mockResolvedValue(undefined),
    refreshKeys: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn(),
  });
  usePrefs.setState({ prefs: { ...usePrefs.getState().prefs, agent_provider: "anthropic", agent_model: "claude-opus-5" } });
  useBrowser.setState({ tabs: [tab], activeTab: tab.id, open: { ...useBrowser.getState().open, settings: false }, toggle: vi.fn() });
});

afterEach(() => {
  cleanup();
  if (scrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", scrollIntoView);
  else delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView;
  useAgent.setState(initialAgent, true);
  useBrowser.setState(initialBrowser, true);
  usePrefs.setState(initialPrefs, true);
  vi.restoreAllMocks();
});

describe("Sidecar", () => {
  it("shows initialization failure with retry and keeps its close control", () => {
    useAgent.setState({ loaded: true, initError: "Credential discovery timed out" });
    render(<Sidecar />);
    expect(screen.getByRole("alert").textContent).toContain("timed out");
    expect(screen.queryByText("Connect Model Provider")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading agent" }));
    expect(useAgent.getState().init).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Close agent" }));
    expect(useBrowser.getState().toggle).toHaveBeenCalledWith("sidecar", false);
  });

  it("refreshes credentials only when Settings closes, not alongside initialization", () => {
    render(<Sidecar />);
    expect(useAgent.getState().refreshKeys).not.toHaveBeenCalled();
    act(() => useBrowser.setState({ open: { ...useBrowser.getState().open, settings: true } }));
    expect(useAgent.getState().refreshKeys).not.toHaveBeenCalled();
    act(() => useBrowser.setState({ open: { ...useBrowser.getState().open, settings: false } }));
    expect(useAgent.getState().refreshKeys).toHaveBeenCalledTimes(1);
  });

  it("can be closed from its own header", () => {
    render(<Sidecar />);
    fireEvent.click(screen.getByRole("button", { name: "Close agent" }));
    expect(useBrowser.getState().toggle).toHaveBeenCalledWith("sidecar", false);
  });

  it("loads the provider catalog and shows the thread with the ready provider", () => {
    render(<Sidecar />);
    expect(useAgent.getState().init).toHaveBeenCalledTimes(1);
    expect(useAgent.getState().refreshKeys).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Agent" })).toBeTruthy();
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByPlaceholderText("Ask, or direct the agent on this page…")).toBeTruthy();
    expect(screen.queryByText("Connect Model Provider")).toBeNull();
  });

  it("renders the seeded conversation", () => {
    useAgent.setState({
      messages: [
        { id: "m1", role: "user", content: "What is this page?" },
        { id: "m2", role: "assistant", content: "A **docs** site.", usage: { input_tokens: 1200, output_tokens: 40, cache_read_tokens: 0, cost_usd: null } },
      ],
    });
    render(<Sidecar />);
    expect(screen.getByText("What is this page?")).toBeTruthy();
    expect(screen.getByText("docs")).toBeTruthy();
    expect(screen.getByText(/1\.2k in · 40 out/)).toBeTruthy();
    expect(screen.queryByText("Quick Actions")).toBeNull();
  });

  it("submits the composer to the store with the active tab", () => {
    render(<Sidecar />);
    const box = screen.getByPlaceholderText("Ask, or direct the agent on this page…") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Explain the console errors" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(useAgent.getState().send).toHaveBeenCalledWith("Explain the console errors", "tab-1");
    expect(box.value).toBe("");
  });

  it("offers a new conversation once there are messages, and opens settings", () => {
    render(<Sidecar />);
    expect((screen.getByRole("button", { name: "New conversation" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => useAgent.setState({ messages: [{ id: "m1", role: "user", content: "hi" }] }));
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(useAgent.getState().clear).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Agent settings" }));
    expect(useBrowser.getState().toggle).toHaveBeenCalledWith("settings", true);
  });

  it("shows setup instead of the thread when the chosen provider has no key", () => {
    useAgent.setState({ keyed: [] });
    render(<Sidecar />);
    expect(screen.getByText("Connect Model Provider")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Ask, or direct the agent on this page…")).toBeNull();
  });

  it("renders nothing but the frame until the catalog has loaded", () => {
    useAgent.setState({ loaded: false });
    render(<Sidecar />);
    expect(screen.queryByPlaceholderText("Ask, or direct the agent on this page…")).toBeNull();
    expect(screen.queryByText("Connect Model Provider")).toBeNull();
  });
});
