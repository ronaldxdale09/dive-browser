import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { traceInputCommand, tracePaletteLifecycle } from "./inputTimingProbe";

const probe = () => window.__diveInputTimingProbe!;

beforeEach(() => {
  probe().stop();
  delete window.__diveUiInputTimingEnabled;
});
afterEach(() => {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  probe().stop();
  delete window.__diveUiInputTimingEnabled;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("input timing probe", () => {
  it("captures selection replacement order using numeric metadata without text", () => {
    window.__diveUiInputTimingEnabled = true;
    probe().start();
    const input = document.createElement("input");
    input.value = "private";
    document.body.appendChild(input);
    input.focus();
    input.setSelectionRange(0, 7);
    document.dispatchEvent(new Event("selectionchange"));
    input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "sensitive", bubbles: true }));
    input.value = "x";
    input.setSelectionRange(1, 1);
    input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "sensitive", bubbles: true }));
    const snapshot = probe().snapshot();
    expect(snapshot.events.slice(-3)).toMatchObject([
      { kind: "selectionchange", selection: { length: 7, start: 0, end: 7 } },
      { kind: "beforeinput", selection: { length: 7, start: 0, end: 7 }, inputType: "insertText" },
      { kind: "input", selection: { length: 1, start: 1, end: 1 }, inputType: "insertText" },
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/private|sensitive/);
    snapshot.events.at(-1)!.selection!.length = 99;
    expect(probe().snapshot().events.at(-1)!.selection!.length).toBe(1);
  });

  it("omits password metadata and rejects arbitrary input types", () => {
    window.__diveUiInputTimingEnabled = true;
    probe().start();
    const input = document.createElement("input");
    input.type = "password";
    Object.defineProperty(input, "value", { get: () => { throw new Error("must not read passwords"); } });
    document.body.appendChild(input);
    input.dispatchEvent(new InputEvent("input", { inputType: "secret-type", data: "secret-data", bubbles: true }));
    expect(probe().snapshot().events.at(-1)).toMatchObject({ selection: null, inputType: "other" });
    expect(JSON.stringify(probe().snapshot())).not.toContain("secret");
  });

  it("does not install listeners or collect events without explicit admission", () => {
    const listen = vi.spyOn(window, "addEventListener");
    expect(probe().start()).toBe(false);
    traceInputCommand("tab.new", "keyboard");
    tracePaletteLifecycle("palette-mounted", null);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "secret" }));
    expect(listen).not.toHaveBeenCalled();
    expect(probe().snapshot().events).toEqual([]);
  });

  it("records ordered targets and dispatch sources without input contents or arbitrary attributes", () => {
    window.__diveUiInputTimingEnabled = true;
    expect(probe().start()).toBe(true);
    probe().start();
    const input = document.createElement("input");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-label", "secret-label");
    input.value = "secret-value";
    document.body.appendChild(input);
    traceInputCommand("tab.new", "native-menu");
    tracePaletteLifecycle("palette-mounted", input);
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "secret-key", bubbles: true }));
    input.dispatchEvent(new InputEvent("beforeinput", { data: "secret-data", bubbles: true }));
    input.dispatchEvent(new InputEvent("input", { data: "secret-data", bubbles: true }));
    const paste = new Event("paste", { bubbles: true });
    Object.defineProperty(paste, "clipboardData", { get: () => { throw new Error("must not inspect clipboard"); } });
    input.dispatchEvent(paste);
    input.setAttribute("role", "secret-role");
    traceInputCommand("secret-command", "command");
    tracePaletteLifecycle("palette-unmounted", input);
    const snapshot = probe().snapshot();
    expect(snapshot.events.map((event) => event.kind)).toEqual(["command", "palette-mounted", "focusin", "keydown", "beforeinput", "input", "paste", "palette-unmounted"]);
    expect(snapshot.events[0]).toMatchObject({ command: "tab.new", source: "native-menu" });
    expect(snapshot.events[2]).toMatchObject({ target: { tag: "INPUT", role: "combobox" }, active: { tag: "INPUT", role: "combobox" } });
    expect(snapshot.events.at(-1)?.target).toEqual({ tag: "INPUT", role: null });
    expect(JSON.stringify(snapshot)).not.toContain("secret");
    expect(snapshot.events.every((event, i) => i === 0 || event.at >= snapshot.events[i - 1]!.at)).toBe(true);
  });

  it("bounds retained events and stops collecting when revoked", () => {
    window.__diveUiInputTimingEnabled = true;
    probe().start();
    for (let i = 0; i < 300; i++) traceInputCommand("tab.new", "keyboard");
    const snapshot = probe().snapshot();
    expect(snapshot.events).toHaveLength(256);
    expect(snapshot.dropped).toBe(44);
    expect(snapshot.events[0]?.sequence).toBe(45);
    snapshot.events[0]!.kind = "paste";
    expect(probe().snapshot().events[0]?.kind).toBe("command");
    delete window.__diveUiInputTimingEnabled;
    traceInputCommand("tab.new", "keyboard");
    expect(probe().snapshot().dropped).toBe(44);
    probe().stop();
    expect(probe().snapshot().events).toEqual([]);
  });
});
