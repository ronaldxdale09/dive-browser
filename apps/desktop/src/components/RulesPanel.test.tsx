import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { newRule, useRules } from "../store/rules";
import { RulesPanel, RulesTools } from "./RulesPanel";

const initialBrowser = useBrowser.getState();
const initialRules = useRules.getState();

beforeEach(() => {
  vi.spyOn(ipc, "rulesList").mockResolvedValue([]);
  vi.spyOn(ipc, "rulesSet").mockResolvedValue(null as never);
  useBrowser.setState({ activeWorkspace: "w1" });
});

afterEach(() => {
  cleanup();
  useBrowser.setState(initialBrowser, true);
  useRules.setState(initialRules, true);
  vi.restoreAllMocks();
});

describe("RulesPanel", () => {
  it("does not say workspace rules apply to every tab without naming media", () => {
    useRules.setState({ byWorkspace: { w1: [newRule()] } });
    render(<RulesPanel />);
    const text = screen.getByText(/First enabled match/).textContent ?? "";
    expect(text).not.toMatch(/every tab/);
    expect(text).toMatch(/media is not intercepted/i);
  });

  it("a new rule starts off and hands focus to its pattern", async () => {
    expect(newRule().enabled).toBe(false);
    render(
      <>
        <RulesTools />
        <RulesPanel />
      </>,
    );
    expect(await screen.findByText(/No rules/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    const pattern = await screen.findByLabelText("URL pattern");
    await waitFor(() => expect(document.activeElement).toBe(pattern));
    expect((screen.getByLabelText("Enabled") as HTMLInputElement).checked).toBe(false);
    // Nothing is sent to the engine as a live rule until it is turned on.
    expect(ipc.rulesSet).toHaveBeenLastCalledWith("w1", [expect.objectContaining({ enabled: false, pattern: "https://*/api/*" })]);
  });
});
