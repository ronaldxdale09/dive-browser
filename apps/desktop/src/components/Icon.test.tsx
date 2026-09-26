import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Camera } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IconButton } from "./Icon";
import { Tooltip, ariaKeyShortcut } from "./Tooltip";
import { contentCoverDepth, resetContentCover } from "../lib/overlay";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("IconButton", () => {
  it("gives its button a visible custom tooltip instead of a native title, not read twice as its description", () => {
    render(<IconButton icon={Camera} label="Capture full page" />);

    const button = screen.getByRole("button", { name: "Capture full page" });
    const tooltip = screen.getByRole("tooltip", { hidden: true });
    expect(tooltip.textContent).toBe("Capture full page");
    expect(button.getAttribute("aria-describedby")).toBeNull();
    expect(button.getAttribute("title")).toBeNull();
  });

  it("announces a pressed state only for a real toggle", () => {
    render(
      <>
        <IconButton icon={Camera} label="Menu" active hasPopup="dialog" expanded />
        <IconButton icon={Camera} label="Fit to window" active toggle />
        <IconButton icon={Camera} label="Reload" />
      </>,
    );
    const menu = screen.getByRole("button", { name: "Menu" });
    // An open popover's button is drawn as on, but it is not a toggle.
    expect(menu.getAttribute("aria-pressed")).toBeNull();
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    expect(menu.hasAttribute("data-active")).toBe(true);
    expect(screen.getByRole("button", { name: "Fit to window" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Reload" }).getAttribute("aria-pressed")).toBeNull();
  });
});

describe("Tooltip", () => {
  const rectAt = (top: number) => vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top, left: 0, right: 28, bottom: top + 28, width: 28, height: 28, x: 0, y: top, toJSON: () => ({}) });

  it("opens below a control in the window's top row instead of past the window's edge", () => {
    rectAt(6);
    render(<IconButton icon={Camera} label="Back" />);
    const tip = screen.getByRole("tooltip", { hidden: true });
    expect(tip.className).toContain("bottom-full");
    fireEvent.mouseEnter(tip.parentElement!);
    expect(tip.className).toContain("top-full");
    expect(tip.className).not.toContain("bottom-full");
  });

  it("stays above a control with room over it, and keeps an asked-for side", () => {
    rectAt(200);
    render(
      <>
        <Tooltip label="Above">
          <button type="button">a</button>
        </Tooltip>
        <Tooltip label="Beside" side="right">
          <button type="button">b</button>
        </Tooltip>
      </>,
    );
    const [above, beside] = screen.getAllByRole("tooltip", { hidden: true });
    fireEvent.mouseEnter(above!.parentElement!);
    fireEvent.focus(screen.getByRole("button", { name: "b" }));
    expect(above!.className).toContain("bottom-full");
    expect(beside!.className).toContain("left-full");
  });

  it("describes its trigger only when it says more than the trigger's name", () => {
    render(
      <>
        <Tooltip label="Reload" shortcut="⌘R">
          <button type="button" aria-label="Reload">r</button>
        </Tooltip>
        <Tooltip label="Connect an agent: drive Dive from Claude Code">
          <button type="button" aria-label="Connect an agent">c</button>
        </Tooltip>
      </>,
    );
    const reload = screen.getByRole("button", { name: "Reload" });
    expect(reload.getAttribute("aria-describedby")).toBeNull();
    expect(reload.getAttribute("aria-keyshortcuts")).toMatch(/^(Meta|Control)\+R$/);
    const connect = screen.getByRole("button", { name: "Connect an agent" });
    expect(document.getElementById(connect.getAttribute("aria-describedby")!)?.textContent).toContain("Claude Code");
  });

  it("shows for keyboard focus, covers the page while shown, and Escape puts it away", () => {
    // jsdom never calls focus keyboard focus; a browser does after a Tab or F6.
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
      return selector === ":focus-visible" ? true : matches.call(this, selector);
    });
    resetContentCover();
    render(
      <Tooltip label="Share this page to another device">
        <button type="button" aria-label="Share">s</button>
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "Share" });
    const tip = screen.getByRole("tooltip", { hidden: true });
    expect(tip.className).toContain("hidden");
    act(() => button.focus());
    expect(tip.className).toContain("flex");
    expect(contentCoverDepth()).toBe(1);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(tip.className).toContain("hidden");
    expect(contentCoverDepth()).toBe(0);
    act(() => button.blur());
    act(() => button.focus());
    expect(tip.className).toContain("flex");
  });

  it("stays while the pointer crosses to it, and takes the pointer only once it can be seen", () => {
    vi.useFakeTimers();
    try {
      render(
        <Tooltip label="Stop and save">
          <button type="button">x</button>
        </Tooltip>,
      );
      const tip = screen.getByRole("tooltip", { hidden: true });
      const wrapper = tip.parentElement!;
      fireEvent.mouseEnter(wrapper);
      expect(tip.className).toContain("pointer-events-none");
      act(() => vi.advanceTimersByTime(500));
      expect(tip.className).toContain("pointer-events-auto");
      fireEvent.mouseLeave(wrapper);
      act(() => vi.advanceTimersByTime(100));
      fireEvent.mouseEnter(wrapper);
      act(() => vi.advanceTimersByTime(500));
      expect(tip.className).toContain("flex");
      fireEvent.mouseLeave(wrapper);
      act(() => vi.advanceTimersByTime(200));
      expect(tip.className).toContain("hidden");
    } finally {
      vi.useRealTimers();
    }
  });

  it("spells a shortcut for aria-keyshortcuts", () => {
    expect(ariaKeyShortcut("⌘⌥⇧R", true)).toBe("Meta+Alt+Shift+R");
    expect(ariaKeyShortcut("⌘⇧Space", false)).toBe("Control+Shift+Space");
    expect(ariaKeyShortcut("mod+shift+[", true)).toBe("Meta+Shift+[");
    expect(ariaKeyShortcut("Esc", true)).toBe("Escape");
    expect(ariaKeyShortcut("⇧F6", true)).toBe("Shift+F6");
  });

  it("wraps a long label instead of letting it spill out of its box", () => {
    render(
      <Tooltip label="Connect an agent: drive Dive from Claude Code, Cursor or Codex" shortcut="mod+k">
        <button type="button">c</button>
      </Tooltip>,
    );
    const tip = screen.getByRole("tooltip", { hidden: true });
    expect(tip.className).not.toContain("whitespace-nowrap");
    expect(tip.querySelector("kbd")!.className).toContain("whitespace-nowrap");
  });
});
