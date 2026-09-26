import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Row, Segmented, Switch } from "../components/SettingsFields";
import { radioStep } from "./useRovingRadio";

afterEach(cleanup);

describe("radioStep", () => {
  it("moves forward and back with wrapping, and jumps with Home and End", () => {
    expect(radioStep(3, 0, "ArrowRight")).toBe(1);
    expect(radioStep(3, 2, "ArrowDown")).toBe(0);
    expect(radioStep(3, 0, "ArrowLeft")).toBe(2);
    expect(radioStep(3, 1, "ArrowUp")).toBe(0);
    expect(radioStep(3, 1, "Home")).toBe(0);
    expect(radioStep(3, 1, "End")).toBe(2);
    expect(radioStep(3, 1, "a")).toBeNull();
    expect(radioStep(0, 0, "ArrowRight")).toBeNull();
  });

  it("starts from an end when nothing is checked", () => {
    expect(radioStep(3, -1, "ArrowRight")).toBe(0);
    expect(radioStep(3, -1, "ArrowLeft")).toBe(2);
  });
});

function Sizes() {
  const [value, setValue] = useState<"s" | "m" | "l">("m");
  return (
    <Segmented
      label="Size"
      value={value}
      onChange={setValue}
      options={[
        { value: "s", label: "Small" },
        { value: "m", label: "Medium" },
        { value: "l", label: "Large" },
      ]}
    />
  );
}

describe("Segmented", () => {
  it("is one Tab stop, and the arrows move the choice and focus together", () => {
    render(<Sizes />);
    const [small, medium, large] = screen.getAllByRole("radio") as [HTMLElement, HTMLElement, HTMLElement];
    expect([small.tabIndex, medium.tabIndex, large.tabIndex]).toEqual([-1, 0, -1]);
    medium.focus();
    fireEvent.keyDown(medium, { key: "ArrowRight" });
    expect(large.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(large);
    expect(large.tabIndex).toBe(0);
    fireEvent.keyDown(large, { key: "ArrowRight" });
    expect(small.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(small);
  });
});

describe("Row", () => {
  it("describes its control by its hint", () => {
    render(<Row label="Sleep tabs" hint="Tabs you have not looked at in a while let go of their memory." control={<Switch label="Sleep tabs" checked onChange={() => undefined} />} />);
    const control = screen.getByRole("switch", { name: "Sleep tabs" });
    const hint = document.getElementById(control.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toMatch(/let go of their memory/);
  });

  it("keeps a control's own description first", () => {
    render(<Row label="Folder" hint="Where files go." control={<Switch label="Folder" checked={false} onChange={() => undefined} describedBy="folder-problem" />} />);
    expect(screen.getByRole("switch").getAttribute("aria-describedby")).toMatch(/^folder-problem \S+$/);
  });
});
