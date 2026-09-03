import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Welcome } from "./Welcome";

// The feature reel is a Remotion Player with its own tests; jsdom cannot
// drive it and this test is about the background layer.
vi.mock("./FeatureReel", () => ({ FeatureReel: () => null }));

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

class IntersectionObserverStub {
  observe() {}
  disconnect() {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverStub);
vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);
vi.stubGlobal("matchMedia", (media: string) => ({
  matches: false,
  media,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => true,
}));
vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

afterEach(cleanup);

describe("Welcome", () => {
  it("renders its animated text background as a subtle decorative layer", () => {
    render(<Welcome />);

    const background = screen.getByTestId("character-background");
    expect(background.getAttribute("aria-hidden")).toBe("true");
    expect(background.style.opacity).toBe("0.04");
    expect(background.style.position).toBe("absolute");
  });
});
