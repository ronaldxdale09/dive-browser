import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { focusables, menuItems, nextInCycle, useFocusTrap } from "./useFocusTrap";

function Dialog({ active = true, onEscape, initial = false }: { active?: boolean; onEscape?: () => void; initial?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const second = useRef<HTMLButtonElement>(null);
  useFocusTrap(root, { active, onEscape, initialFocus: initial ? second : undefined });
  return (
    <div ref={root} role="dialog" aria-label="Trap">
      <button type="button">first</button>
      <button type="button" ref={second}>
        second
      </button>
      <button type="button" disabled>
        disabled
      </button>
      <input aria-label="last" />
    </div>
  );
}

function DisabledPrimary({ onEscape }: { onEscape: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  useFocusTrap(root, { initialFocus: primary, onEscape });
  return (
    <div ref={root} role="dialog" aria-label="Disabled primary">
      <button type="button">option</button>
      <button type="button" ref={primary} disabled>
        start
      </button>
    </div>
  );
}

function Menu({ onClose }: { onClose?: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useFocusTrap(root, { menu: true, onEscape: onClose });
  return (
    <div ref={root} role="menu" aria-label="Menu">
      <div>heading</div>
      <button type="button" role="menuitem">
        one
      </button>
      <button type="button" role="menuitemradio" aria-checked="false">
        two
      </button>
      <button type="button" role="menuitem" disabled>
        off
      </button>
      <button type="button" role="menuitem">
        three
      </button>
    </div>
  );
}

/** A trigger that opens the dialog, the way a menu button does. */
function Host() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      {open && <Dialog onEscape={() => setOpen(false)} />}
    </>
  );
}

afterEach(cleanup);

describe("nextInCycle", () => {
  it("wraps at both ends and starts from an end when nothing inside is focused", () => {
    const items = ["a", "b", "c"];
    expect(nextInCycle(items, "a", false)).toBe("b");
    expect(nextInCycle(items, "c", false)).toBe("a");
    expect(nextInCycle(items, "a", true)).toBe("c");
    expect(nextInCycle(items, null, false)).toBe("a");
    expect(nextInCycle(items, null, true)).toBe("c");
    expect(nextInCycle([], null, false)).toBeNull();
  });
});

describe("useFocusTrap", () => {
  it("focuses the first focusable element on open, or the initialFocus ref", () => {
    render(<Dialog />);
    expect(document.activeElement).toBe(screen.getByText("first"));
    cleanup();
    render(<Dialog initial />);
    expect(document.activeElement).toBe(screen.getByText("second"));
  });

  it("falls back from a disabled initialFocus so Escape still reaches the trap", () => {
    const onEscape = vi.fn();
    render(<DisabledPrimary onEscape={onEscape} />);
    expect(document.activeElement).toBe(screen.getByText("option"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("cycles Tab and Shift+Tab inside the container, skipping disabled controls", () => {
    render(<Dialog />);
    const dialog = screen.getByRole("dialog");
    const first = screen.getByText("first");
    const last = screen.getByLabelText("last");
    expect(focusables(dialog).map((el) => el.textContent || el.getAttribute("aria-label"))).toEqual(["first", "second", "last"]);

    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    // In the middle of the list the browser's own Tab is left alone.
    first.focus();
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    dialog.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("restores focus to the element that had it before, when the trap goes away", () => {
    render(<Host />);
    const trigger = screen.getByText("open");
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByText("first"));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("does nothing while inactive, and arms when it turns active", () => {
    const before = document.createElement("button");
    document.body.appendChild(before);
    before.focus();
    const view = render(<Dialog active={false} />);
    expect(document.activeElement).toBe(before);
    view.rerender(<Dialog active />);
    expect(document.activeElement).toBe(screen.getByText("first"));
    view.rerender(<Dialog active={false} />);
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it("leaves an element that already has focus inside the container alone", () => {
    function AutoFocused() {
      const root = useRef<HTMLDivElement>(null);
      useFocusTrap(root);
      return (
        <div ref={root}>
          <button type="button">a</button>
          <input aria-label="typed" autoFocus />
        </div>
      );
    }
    render(<AutoFocused />);
    expect(document.activeElement).toBe(screen.getByLabelText("typed"));
  });

  it("walks a menu with the arrow keys and closes it on Escape", () => {
    const onClose = vi.fn();
    render(<Menu onClose={onClose} />);
    const menu = screen.getByRole("menu");
    expect(menuItems(menu).map((el) => el.textContent)).toEqual(["one", "two", "three"]);
    expect(document.activeElement).toBe(screen.getByText("one"));

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByText("two"));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByText("three"));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByText("one"));
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByText("three"));
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByText("one"));
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(screen.getByText("three"));

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
