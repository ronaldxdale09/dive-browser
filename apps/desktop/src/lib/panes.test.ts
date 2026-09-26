import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "./ipc";
import type { Tab } from "./ipc";
import { availablePanes, currentPane, cyclePane, nextPane, resetPageFocus } from "./panes";
import { useBrowser } from "../store/browser";
import { FOCUS_AGENT, UI_COMMANDS, shortcutFor } from "./commands";

const tab: Tab = { id: "t1", workspace_id: "w", tier: "today", url: "https://x", title: "X", position: 0, state: "active", last_active_at: "2026-01-01T00:00:00Z", favicon: null };

/** The chrome's regions as the components draw them, in the one-row layout. */
function chrome() {
  document.body.innerHTML = `
    <nav aria-label="Sidebar"><div role="group" aria-label="Workspaces">
      <div role="button" tabindex="-1" data-workspace-row>Work</div>
      <div role="button" tabindex="0" data-workspace-row aria-current="true">Home</div></div>
      <nav aria-label="Tabs"><div role="tablist" aria-label="Tabs">
        <button role="tab" tabindex="-1">A</button><button role="tab" tabindex="0">B</button>
      </div></nav>
    </nav>
    <nav aria-label="Browser controls"><button>Back</button><input aria-label="Address"></nav>
    <div data-pane="features"><button>Agent</button><button>Apps</button></div>
    <section aria-label="Agent"><textarea aria-label="Message the agent"></textarea></section>
    <div role="dialog" aria-label="Save the password for github.com?" data-pane="prompt" tabindex="-1"><button>Save</button></div>
  `;
}

const focused = () => document.activeElement as HTMLElement;

beforeEach(() => {
  resetPageFocus();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(ipc, "tabFocus").mockResolvedValue(null);
  useBrowser.setState({ tabs: [tab], activeTab: tab.id, detached: [], open: { ...useBrowser.getState().open, sidecar: false } });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  useBrowser.setState({ tabs: [], activeTab: null, detached: [] });
});

describe("nextPane", () => {
  it("walks forward and back, wrapping, and goes on from a pane that has gone", () => {
    const all = ["tabs", "rail", "toolbar", "page"] as const;
    expect(nextPane(all, "tabs", 1)).toBe("rail");
    expect(nextPane(all, "page", 1)).toBe("tabs");
    expect(nextPane(all, "tabs", -1)).toBe("page");
    expect(nextPane(all, null, 1)).toBe("tabs");
    expect(nextPane(all, null, -1)).toBe("page");
    // The card was answered: F6 from where it was goes on to the page.
    expect(nextPane(all, "prompt", 1)).toBe("page");
    expect(nextPane([], "tabs", 1)).toBeNull();
  });
});

describe("cyclePane", () => {
  it("stops at every region that is on screen, in order, and ends at the page", () => {
    chrome();
    expect(availablePanes()).toEqual(["tabs", "rail", "toolbar", "features", "agent", "prompt", "page"]);
    expect(cyclePane(1)).toBe("tabs");
    expect(focused().textContent).toBe("B");
    expect(cyclePane(1)).toBe("rail");
    expect(focused().textContent).toBe("Home");
    expect(cyclePane(1)).toBe("toolbar");
    expect(focused().getAttribute("aria-label")).toBe("Address");
    expect(cyclePane(1)).toBe("features");
    expect(focused().textContent).toBe("Agent");
    expect(cyclePane(1)).toBe("agent");
    expect(focused().getAttribute("aria-label")).toBe("Message the agent");
    expect(cyclePane(1)).toBe("prompt");
    expect(focused().getAttribute("data-pane")).toBe("prompt");
    expect(cyclePane(1)).toBe("page");
    expect(ipc.tabFocus).toHaveBeenCalledWith("t1");
  });

  it("comes back from the page to the tabs, and Shift+F6 from the tabs goes to the page", () => {
    chrome();
    (document.querySelector('[aria-label="Address"]') as HTMLElement).focus();
    // The page took the keyboard: the chrome's window no longer has focus.
    vi.mocked(document.hasFocus).mockReturnValue(false);
    expect(currentPane()).toBe("page");
    expect(cyclePane(1)).toBe("tabs");
    vi.mocked(document.hasFocus).mockReturnValue(true);
    expect(currentPane()).toBe("tabs");
    expect(cyclePane(-1)).toBe("page");
  });

  it("leaves a modal dialog alone", () => {
    chrome();
    document.body.insertAdjacentHTML("beforeend", '<div role="dialog" aria-modal="true"><button id="inside">OK</button></div>');
    (document.getElementById("inside") as HTMLElement).focus();
    expect(cyclePane(1)).toBeNull();
    expect(focused().id).toBe("inside");
  });

  it("skips the page when this window shows none", () => {
    chrome();
    useBrowser.setState({ activeTab: null });
    expect(availablePanes()).not.toContain("page");
  });
});

describe("F6 and ⌘J", () => {
  it("binds F6 and Shift+F6, even from a field", () => {
    const field = document.createElement("input");
    document.body.append(field);
    const f6 = new KeyboardEvent("keydown", { key: "F6", bubbles: true });
    const back = new KeyboardEvent("keydown", { key: "F6", shiftKey: true, bubbles: true });
    const seen: (string | null)[] = [];
    field.addEventListener("keydown", (e) => seen.push(shortcutFor(e)));
    field.dispatchEvent(f6);
    field.dispatchEvent(back);
    expect(seen).toEqual(["pane.next", "pane.prev"]);
  });

  it("brings the keyboard to an open agent instead of closing it, and closes it from inside", () => {
    chrome();
    const heard = vi.fn();
    window.addEventListener(FOCUS_AGENT, heard);
    useBrowser.setState({ open: { ...useBrowser.getState().open, sidecar: true } });
    (document.querySelector('[aria-label="Address"]') as HTMLElement).focus();
    void UI_COMMANDS["sidecar.toggle"]!();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(useBrowser.getState().open.sidecar).toBe(true);
    (document.querySelector("textarea") as HTMLElement).focus();
    void UI_COMMANDS["sidecar.toggle"]!();
    expect(useBrowser.getState().open.sidecar).toBe(false);
    window.removeEventListener(FOCUS_AGENT, heard);
  });
});
