import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS, usePrefs } from "../../store/prefs";
import { useAgent } from "../../store/agent";
import { Agent } from "./Agent";

const initialPrefs = usePrefs.getState();
const initialAgent = useAgent.getState();

beforeEach(() => {
  usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });
  useAgent.setState({ init: vi.fn().mockResolvedValue(undefined), providers: [], keyed: [] });
});

afterEach(() => {
  cleanup();
  usePrefs.setState(initialPrefs, true);
  useAgent.setState(initialAgent, true);
  vi.restoreAllMocks();
});

describe("Settings › Agent", () => {
  it("does not say API keys leave only this Mac", () => {
    render(<Agent />);
    expect(document.body.textContent).not.toMatch(/this Mac/);
    expect(document.body.textContent).toMatch(/this computer/);
  });
});
