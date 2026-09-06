import { afterEach, expect, it } from "vitest";
import { selectAllInChromeField } from "./chromeEditing";

const stops: (() => void)[] = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); document.body.replaceChildren(); });
function setup(element: HTMLInputElement | HTMLTextAreaElement, mac = true) {
  element.value = "previous query";
  document.body.appendChild(element);
  element.focus();
  element.setSelectionRange(element.value.length, element.value.length);
  const handler = (event: KeyboardEvent) => selectAllInChromeField(event, mac);
  window.addEventListener("keydown", handler);
  stops.push(() => window.removeEventListener("keydown", handler));
  return element;
}
function chord(element: HTMLElement, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true, cancelable: true, ...extra });
  element.dispatchEvent(event);
  return event;
}

it("selects before dispatch returns and suppresses native fallback before the first replacement character", () => {
  const input = setup(document.createElement("input"));
  expect(chord(input).defaultPrevented).toBe(true);
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
  input.setRangeText("h", input.selectionStart!, input.selectionEnd!, "end");
  expect(input.value).toBe("h");
});

it("selects a focused textarea and password field using their normal text selection", () => {
  const textarea = setup(document.createElement("textarea"));
  expect(chord(textarea).defaultPrevented).toBe(true);
  expect(textarea.selectionStart).toBe(0);
  const password = document.createElement("input"); password.type = "password";
  setup(password);
  expect(chord(password).defaultPrevented).toBe(true);
  expect(password.selectionEnd).toBe(password.value.length);
});

it("leaves composition, other platforms, extra modifiers and nonmatching keys untouched", () => {
  const input = setup(document.createElement("input"));
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { metaKey: false, ctrlKey: true }, { key: "x" }]) {
    expect(chord(input, extra).defaultPrevented).toBe(false);
    expect(input.selectionStart).toBe(input.value.length);
  }

});

it("respects a component's prevented event or changed focus", () => {
  const input = setup(document.createElement("input"));
  input.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
  chord(input);
  expect(input.selectionStart).toBe(input.value.length);
  const replacement = document.createElement("input"); document.body.appendChild(replacement);
  input.addEventListener("keydown", () => replacement.focus(), { once: true });
  expect(chord(input).defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(replacement);
});

it("leaves non-text controls and contenteditable handling to Chromium", () => {
  const handler = (event: KeyboardEvent) => selectAllInChromeField(event, true);
  window.addEventListener("keydown", handler); stops.push(() => window.removeEventListener("keydown", handler));
  const input = document.createElement("input"); input.type = "number";
  const editable = document.createElement("div"); editable.contentEditable = "true"; editable.tabIndex = 0;
  for (const element of [input, editable]) {
    document.body.appendChild(element); element.focus();
    expect(chord(element).defaultPrevented).toBe(false);
  }
});

it("does not intercept editing on other platforms", () => {
  const input = setup(document.createElement("input"), false);
  expect(chord(input).defaultPrevented).toBe(false);
  expect(input.selectionStart).toBe(input.value.length);
});
