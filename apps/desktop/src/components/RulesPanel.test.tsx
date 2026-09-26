import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { useBrowser } from "../store/browser";
import { newRule, ruleProblem, useRules } from "../store/rules";
import type { Rule } from "../lib/ipc";
import { RulesPanel, RulesTools, SAVE_AFTER_MS } from "./RulesPanel";

const initialBrowser = useBrowser.getState();
const initialRules = useRules.getState();

beforeEach(() => {
  vi.spyOn(ipc, "rulesList").mockResolvedValue([]);
  vi.spyOn(ipc, "rulesSet").mockResolvedValue(null as never);
  useBrowser.setState({ activeWorkspace: "w1" });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

  it("saves what is typed once typing pauses, not on every key", async () => {
    vi.useFakeTimers();
    const rule: Rule = { ...newRule(), id: "r1" };
    useRules.setState({ byWorkspace: { w1: [rule] }, status: { w1: "ready" } });
    render(<RulesPanel />);
    const pattern = screen.getByLabelText("URL pattern");
    for (const text of ["h", "ht", "htt", "http"]) fireEvent.change(pattern, { target: { value: text } });
    expect(ipc.rulesSet).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(SAVE_AFTER_MS); });
    expect(ipc.rulesSet).toHaveBeenCalledTimes(1);
    expect(ipc.rulesSet).toHaveBeenLastCalledWith("w1", [expect.objectContaining({ id: "r1", pattern: "http" })]);
    vi.useRealTimers();
  });

  it("lets the status be cleared and retyped, and says what is wrong instead of sending it", async () => {
    vi.useFakeTimers();
    const rule: Rule = { id: "r1", pattern: "https://a.dev/*", enabled: true, action: { kind: "mock", status: 200, content_type: "application/json", body: "{}" } };
    useRules.setState({ byWorkspace: { w1: [rule] }, status: { w1: "ready" } });
    render(<RulesPanel />);
    const status = screen.getByLabelText("Status") as HTMLInputElement;
    fireEvent.change(status, { target: { value: "" } });
    expect(status.value).toBe("");
    await act(async () => { await vi.advanceTimersByTimeAsync(SAVE_AFTER_MS); });
    expect(ipc.rulesSet).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/100 to 599/);
    fireEvent.change(status, { target: { value: "404" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(SAVE_AFTER_MS); });
    expect(ipc.rulesSet).toHaveBeenLastCalledWith("w1", [expect.objectContaining({ action: expect.objectContaining({ status: 404 }) })]);
    expect(screen.queryByRole("alert")).toBeNull();
    vi.useRealTimers();
  });

  it("puts a rule back when the host refuses it", async () => {
    vi.mocked(ipc.rulesSet).mockRejectedValue(new Error("rule pattern must be 1-2048 characters"));
    const rule: Rule = { ...newRule(), id: "r1" };
    useRules.setState({ byWorkspace: { w1: [rule] }, status: { w1: "ready" } });
    render(<RulesPanel />);
    fireEvent.click(screen.getByLabelText("Enabled"));
    await waitFor(() => expect(ipc.rulesSet).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByLabelText("Enabled") as HTMLInputElement).checked).toBe(false));
    expect(useRules.getState().byWorkspace.w1).toEqual([rule]);
  });

  it("does not offer Add when the rules could not be read, so nothing is saved over them", async () => {
    vi.mocked(ipc.rulesList).mockRejectedValue(new Error("store locked"));
    render(
      <>
        <RulesTools />
        <RulesPanel />
      </>,
    );
    expect(await screen.findByText(/workspace.s rules could not be read/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Rules could not be read" }) as HTMLButtonElement).disabled).toBe(true);
    expect(ipc.rulesSet).not.toHaveBeenCalled();
  });

  it("reads the rules again when asked, for a change made by the agent", async () => {
    vi.mocked(ipc.rulesList).mockResolvedValue([{ ...newRule(), id: "from-agent", pattern: "https://agent.dev/*" }]);
    useRules.setState({ byWorkspace: { w1: [] }, status: { w1: "ready" } });
    await useRules.getState().load("w1", true);
    expect(useRules.getState().byWorkspace.w1?.[0]?.id).toBe("from-agent");
  });
});

describe("ruleProblem", () => {
  it("catches what the host would refuse", () => {
    const base = newRule();
    expect(ruleProblem(base)).toBeNull();
    expect(ruleProblem({ ...base, pattern: "  " })).toMatch(/pattern/);
    expect(ruleProblem({ ...base, action: { kind: "header", name: "X Debug", value: "1" } })).toMatch(/header name/i);
    expect(ruleProblem({ ...base, action: { kind: "header", name: "X-Debug", value: "a\nb" } })).toMatch(/lines/);
    expect(ruleProblem({ ...base, action: { kind: "mock", status: 99, content_type: "text/plain", body: "" } })).toMatch(/100 to 599/);
    expect(ruleProblem({ ...base, action: { kind: "mock", status: 200, content_type: "", body: "" } })).toMatch(/content type/);
  });
});
