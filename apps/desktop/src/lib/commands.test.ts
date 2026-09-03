import { describe, expect, it } from "vitest";
import { SHORTCUTS, UI_COMMANDS, chordOf } from "./commands";

describe("command dispatch", () => {
  it("every shortcut points at a chrome-side handler", () => {
    for (const id of Object.values(SHORTCUTS)) expect(UI_COMMANDS[id], id).toBeTypeOf("function");
  });
  it("parses chords", () => {
    expect(chordOf(new KeyboardEvent("keydown", { key: "S", metaKey: true, shiftKey: true }))).toBe("mod+shift+s");
    expect(chordOf(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }))).toBe("mod+k");
    expect(chordOf(new KeyboardEvent("keydown", { key: "k" }))).toBeNull();
    expect(chordOf(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }))).toBeNull();
  });
});
