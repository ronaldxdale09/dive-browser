import { describe, expect, it } from "vitest";
import { isImeComposing } from "./ime";

function withKeyCode(event: KeyboardEvent, keyCode: number) {
  Object.defineProperty(event, "keyCode", { value: keyCode });
  return event;
}

describe("isImeComposing", () => {
  it("is true for a key flagged isComposing", () => {
    expect(isImeComposing(new KeyboardEvent("keydown", { key: "Enter", isComposing: true }))).toBe(true);
  });

  it("is true for the legacy keyCode 229", () => {
    expect(isImeComposing(withKeyCode(new KeyboardEvent("keydown", { key: "Enter" }), 229))).toBe(true);
  });

  it("is false for a plain key press", () => {
    expect(isImeComposing(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(false);
  });

  it("reads the native event of a React event", () => {
    const nativeEvent = new KeyboardEvent("keydown", { key: "Escape", isComposing: true });
    const react = { nativeEvent } as unknown as Parameters<typeof isImeComposing>[0];
    expect(isImeComposing(react)).toBe(true);
  });
});
