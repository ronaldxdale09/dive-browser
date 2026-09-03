import { cleanup, render, screen } from "@testing-library/react";
import { Camera } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import { IconButton } from "./Icon";

afterEach(cleanup);

describe("IconButton", () => {
  it("connects its button to a visible custom tooltip instead of a native title", () => {
    render(<IconButton icon={Camera} label="Capture full page" />);

    const button = screen.getByRole("button", { name: "Capture full page" });
    const tooltip = screen.getByRole("tooltip", { hidden: true });
    expect(tooltip.textContent).toBe("Capture full page");
    expect(button.getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(button.getAttribute("title")).toBeNull();
  });
});
