import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Wordmark } from "./Wordmark";

afterEach(cleanup);

describe("Wordmark", () => {
  it("names the app with its mark, as a label rather than a control", () => {
    const { container } = render(<Wordmark />);
    expect(screen.getByText("Dive")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    // The mark is decorative (empty alt, so no img role); the name is the accessible text.
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("");
  });
});
