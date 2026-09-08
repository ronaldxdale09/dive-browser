import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo, Tab } from "../../lib/ipc";
import { useAgent } from "../../store/agent";
import { useBrowser } from "../../store/browser";
import { usePrefs } from "../../store/prefs";
import { Thread } from "./Thread";

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
const placeholder = "Ask, or direct the agent on this page…";

beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, writable: true, value: vi.fn() });
  useAgent.setState({
    providers: PROVIDERS,
    keyed: ["anthropic"],
    loaded: true,
    messages: [],
    busy: false,
    sessionAutoApprove: false,
    send: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    setSessionAutoApprove: vi.fn(),
  });
  usePrefs.setState({
    prefs: { ...usePrefs.getState().prefs, agent_provider: "anthropic", agent_model: "claude-opus-5", agent_include_page: true },
    update: vi.fn().mockResolvedValue(undefined),
  });
  useBrowser.setState({ tabs: [tab], activeTab: tab.id, openTab: vi.fn().mockResolvedValue(undefined) });
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

describe("Thread", () => {
  it("starts with quick actions that send their prompt for the active tab", () => {
    render(<Thread onAddProvider={() => {}} />);
    expect(screen.getByText("Quick Actions")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Summarize page/ }));
    expect(useAgent.getState().send).toHaveBeenCalledWith(expect.stringMatching(/^Summarize this page/), "tab-1");
  });

  it("disables quick actions and changes the prompt without a tab", () => {
    useBrowser.setState({ tabs: [], activeTab: null });
    render(<Thread onAddProvider={() => {}} />);
    expect((screen.getByRole("button", { name: /Summarize page/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByPlaceholderText("Open a tab, then ask…")).toBeTruthy();
  });

  it("renders user and assistant messages, including the pending and failed states", () => {
    useAgent.setState({
      messages: [
        { id: "m1", role: "user", content: "hello there" },
        { id: "m2", role: "assistant", content: "Hi! Here is **bold** text.", stopped: true },
        { id: "m3", role: "user", content: "again" },
        { id: "m4", role: "assistant", content: "", error: "Rate limited." },
        { id: "m5", role: "assistant", content: "", pending: true },
      ],
    });
    render(<Thread onAddProvider={() => {}} />);
    expect(screen.getByText("hello there")).toBeTruthy();
    expect(screen.getByText("bold")).toBeTruthy();
    expect(screen.getByText("stopped")).toBeTruthy();
    expect(screen.getByText("Rate limited.")).toBeTruthy();
    const openSettings = vi.spyOn(useBrowser.getState(), "openSettings").mockImplementation(() => undefined);
    useBrowser.setState({ openSettings });
    fireEvent.click(screen.getByRole("button", { name: "Change model or key" }));
    expect(openSettings).toHaveBeenCalledWith("agent");
    expect(screen.getByText("Thinking…")).toBeTruthy();
    expect(screen.queryByText("Quick Actions")).toBeNull();
  });

  it("says so when a finished reply carries no text, steps or error", () => {
    useAgent.setState({ messages: [{ id: "u", role: "user", content: "hi" }, { id: "a", role: "assistant", content: "", usage: { input_tokens: 10, output_tokens: 3, cache_read_tokens: 0, cost_usd: null } as never }] });
    render(<Thread onAddProvider={() => {}} />);
    expect(screen.getByText(/The model sent nothing back/)).toBeTruthy();
  });

  it("submits from the send button and from Enter, but not Shift+Enter", () => {
    render(<Thread onAddProvider={() => {}} />);
    const box = screen.getByPlaceholderText(placeholder) as HTMLTextAreaElement;
    const sendButton = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);

    fireEvent.change(box, { target: { value: "first" } });
    expect(sendButton.disabled).toBe(false);
    fireEvent.click(sendButton);
    expect(useAgent.getState().send).toHaveBeenLastCalledWith("first", "tab-1");
    expect(box.value).toBe("");

    fireEvent.change(box, { target: { value: "second" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(useAgent.getState().send).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(useAgent.getState().send).toHaveBeenLastCalledWith("second", "tab-1");
    expect(useAgent.getState().send).toHaveBeenCalledTimes(2);
  });

  it("ignores blank drafts and submissions while busy", () => {
    render(<Thread onAddProvider={() => {}} />);
    const box = screen.getByPlaceholderText(placeholder);
    fireEvent.change(box, { target: { value: "   " } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(useAgent.getState().send).not.toHaveBeenCalled();

    useAgent.setState({ busy: true });
    fireEvent.change(box, { target: { value: "wait" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(useAgent.getState().send).not.toHaveBeenCalled();
  });

  it("swaps the send button for stop while a reply streams", () => {
    useAgent.setState({ busy: true });
    render(<Thread onAddProvider={() => {}} />);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(useAgent.getState().stop).toHaveBeenCalledTimes(1);
  });

  it("shows the page-context chip and toggles the preference", () => {
    render(<Thread onAddProvider={() => {}} />);
    const chip = screen.getByRole("button", { name: /Example docs/ });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    expect(usePrefs.getState().update).toHaveBeenCalledWith({ agent_include_page: false });
  });

  it("lets the user turn session auto-approve back off", () => {
    useAgent.setState({ sessionAutoApprove: true });
    render(<Thread onAddProvider={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Auto-approve on/ }));
    expect(useAgent.getState().setSessionAutoApprove).toHaveBeenCalledWith(false);
  });

  it("says when the setting approves everything, and sends the user to change it in Settings", () => {
    usePrefs.setState({ prefs: { ...usePrefs.getState().prefs, agent_auto_approve: true } });
    const openSettings = vi.fn();
    useBrowser.setState({ openSettings });
    render(<Thread onAddProvider={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Acts without asking/ }));
    expect(openSettings).toHaveBeenCalledWith("agent");
    expect(useAgent.getState().setSessionAutoApprove).not.toHaveBeenCalled();
  });
});
