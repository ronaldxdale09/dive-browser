import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentAnnouncements, resetAnnouncements } from "../../lib/announce";
import { useAgent } from "../../store/agent";
import type { Message, Step } from "../../store/agent";
import { useBrowser } from "../../store/browser";
import { AgentAnnouncer, agentAnnouncements, openingSentence } from "./AgentAnnouncer";
import { StepList } from "./StepList";

const initialAgent = useAgent.getState();
const initialBrowser = useBrowser.getState();

afterEach(() => {
  cleanup();
  resetAnnouncements();
  useAgent.setState(initialAgent, true);
  useBrowser.setState(initialBrowser, true);
  vi.restoreAllMocks();
});

const click: Step = { id: "s1", name: "page_click", input: "{}", action: true, caution: "click the Delete button", awaiting: true };
const reply = (patch: Partial<Message>): Message => ({ id: "a1", role: "assistant", content: "", pending: true, ...patch });

describe("openingSentence", () => {
  it("reads the first sentence as words, without the Markdown", () => {
    expect(openingSentence("**The page** has [two errors](https://x). The first is a 404.")).toBe("The page has two errors.");
    expect(openingSentence("## Summary\n\n- It is a docs site")).toBe("Summary It is a docs site");
    expect(openingSentence("```js\nlet a = 1;\n```\nDone!")).toBe("Done!");
    expect(openingSentence("a".repeat(300)).length).toBe(200);
  });
});

describe("agentAnnouncements", () => {
  it("asks for approval once per step, and says how to reach it with the dock closed", () => {
    const before = [reply({ steps: [] })];
    const after = [reply({ steps: [click] })];
    expect(agentAnnouncements(before, after, true)).toEqual([{ text: "Agent needs approval: Click the Delete button.", urgency: "polite" }]);
    expect(agentAnnouncements(before, after, false)[0]?.text).toContain("to answer.");
    // Still waiting is not news.
    expect(agentAnnouncements(after, after, true)).toEqual([]);
  });

  it("says a reply finished with its opening, and a failure assertively", () => {
    const done = agentAnnouncements([reply({})], [reply({ pending: false, content: "It is a docs site. It has 12 pages." })], true);
    expect(done).toEqual([{ text: "Reply finished. It is a docs site.", urgency: "polite" }]);
    const failed = agentAnnouncements([reply({})], [reply({ pending: false, error: "The key was refused" })], true);
    expect(failed).toEqual([{ text: "Agent reply failed: The key was refused", urgency: "assertive" }]);
    expect(agentAnnouncements([reply({})], [reply({ pending: false, stopped: true })], true)[0]?.text).toBe("Agent reply stopped");
  });

  it("says nothing while a reply streams, or about another tab's conversation arriving", () => {
    expect(agentAnnouncements([reply({ content: "It" })], [reply({ content: "It is" })], true)).toEqual([]);
    expect(agentAnnouncements([], [reply({ pending: false, content: "Old answer.", error: "old failure" })], true)).toEqual([]);
  });
});

describe("AgentAnnouncer", () => {
  it("speaks through the chrome's region while the dock is closed", () => {
    useBrowser.setState({ open: { ...useBrowser.getState().open, sidecar: false } });
    useAgent.setState({ messages: [reply({ steps: [] })] });
    render(<AgentAnnouncer />);
    act(() => useAgent.setState({ messages: [reply({ steps: [click] })] }));
    expect(currentAnnouncements().polite?.text).toMatch(/^Agent needs approval: Click the Delete button\. Press .*J to answer\.$/);
    act(() => useAgent.setState({ messages: [reply({ pending: false, content: "Deleted it." })] }));
    expect(currentAnnouncements().polite?.text).toBe("Reply finished. Deleted it.");
  });
});

describe("StepList", () => {
  it("says each step's state in words, and names Allow and Deny by the question", () => {
    render(<StepList live steps={[click, { id: "s2", name: "page_read", input: "{}", action: false, summary: "ok" }, { id: "s3", name: "page_click", input: "{}", action: true, summary: "no such element", error: true }]} />);
    const rows = screen.getAllByRole("button", { expanded: false });
    expect(rows[0]!.textContent).toContain(", waiting for your approval");
    expect(rows[1]!.textContent).toContain(", done");
    expect(rows[2]!.textContent).toContain(", failed");
    const group = screen.getByRole("group", { name: "Click the Delete button. Allow it?" });
    expect(group.querySelectorAll("button")).toHaveLength(3);
  });
});
