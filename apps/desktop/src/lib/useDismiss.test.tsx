import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useDismiss } from "./useDismiss";

function Popover() {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);
  useDismiss(root, open, () => setOpen(false));
  return (
    <div>
      <button type="button">Elsewhere</button>
      <div ref={root}>
        <button type="button" onClick={() => setOpen(true)}>Toggle</button>
        {open && (
          <div role="dialog" aria-label="Panel">
            <button type="button">Inside</button>
          </div>
        )}
      </div>
    </div>
  );
}

afterEach(cleanup);

describe("useDismiss", () => {
  it("stays open for clicks and focus inside, closes when focus moves elsewhere", () => {
    render(<Popover />);
    fireEvent.mouseDown(screen.getByText("Inside"));
    fireEvent.focusIn(screen.getByText("Inside"));
    expect(screen.queryByRole("dialog")).toBeTruthy();
    fireEvent.focusIn(screen.getByText("Elsewhere"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on a click outside and on Escape", () => {
    render(<Popover />);
    fireEvent.mouseDown(screen.getByText("Elsewhere"));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByText("Toggle"));
    expect(screen.queryByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
