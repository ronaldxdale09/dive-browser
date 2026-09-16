import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Kbd } from "./primitives";

const platform = Object.getOwnPropertyDescriptor(navigator, "platform");

afterEach(() => {
  cleanup();
  if (platform) Object.defineProperty(navigator, "platform", platform);
});

describe("reel Kbd", () => {
  it("does not name ⌘ chords on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    render(<Kbd>⌘1 – ⌘9</Kbd>);
    expect(document.body.textContent).not.toMatch(/⌘/);
    expect(document.body.textContent).toMatch(/Ctrl\+1/);
  });
});
