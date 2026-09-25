import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Camera } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IconButton } from "./Icon";
import { Tooltip } from "./Tooltip";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("IconButton", () => {
  it("connects its button to a visible custom tooltip instead of a native title", () => {
    render(<IconButton icon={Camera} label="Capture full page" />);

    const button = screen.getByRole("button", { name: "Capture full page" });
    const tooltip = screen.getByRole("tooltip", { hidden: true });
    expect(tooltip.textContent).toBe("Capture full page");
    expect(button.getAttribute("aria-describedby")).toBe(tooltip.id);
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
