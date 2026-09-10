import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DrivingMark } from "./DrivingMark";

afterEach(cleanup);

describe("DrivingMark", () => {
  it("says what it means, so it is not motion and colour alone", () => {
    render(<DrivingMark />);
    expect(screen.getByRole("img", { name: "An agent is working in this tab" })).toBeTruthy();
  });

  it("stops moving when the person has asked for less motion", () => {
    // The mark still has to read as "not a favicon" without the animation,
    // which is why the motion is an addition to the shape rather than the
    // whole of it.
    const { container } = render(<DrivingMark />);
    for (const el of container.querySelectorAll("[class*=animate]")) {
      expect(el.getAttribute("class")).toContain("motion-reduce:animate-none");
    }
  });
});
