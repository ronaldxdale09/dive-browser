import { describe, expect, it } from "vitest";
import { errorKind, errorMessage, invalidField } from "./errors";

describe("errorMessage", () => {
  it("takes an Error's message and stringifies anything else", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});

describe("errorKind and invalidField", () => {
  it("read the host's kind, and nothing from the words", () => {
    const gone = Object.assign(new Error("whatever"), { kind: { type: "gone" } });
    expect(errorKind(gone)?.type).toBe("gone");
    expect(invalidField(gone)).toBeNull();
    const month = Object.assign(new Error("x"), { kind: { type: "invalid", field: "month" } });
    expect(invalidField(month)).toBe("month");
  });

  it("are null for errors the host gave no kind", () => {
    expect(errorKind(new Error("that dialog is no longer open"))).toBeNull();
    expect(errorKind(Object.assign(new Error("x"), { kind: null }))).toBeNull();
    expect(errorKind("text")).toBeNull();
    expect(errorKind(null)).toBeNull();
    expect(invalidField(undefined)).toBeNull();
  });
});
