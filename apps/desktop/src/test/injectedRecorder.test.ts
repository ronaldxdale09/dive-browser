// Behavioural test of the flow recorder against a DOM. Its own file: the
// recorder defines a non-configurable `window.__diveRecorderNonce` and
// installs once per window, and each test file gets a fresh jsdom.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildInjected } from "./injected";

interface Sent {
  kind: string;
  role: string;
  name: string;
  value: string;
  masked?: boolean;
}

const sent: Sent[] = [];

beforeAll(() => {
  Reflect.set(window, "__diveTest", (raw: string) => {
    sent.push(JSON.parse(raw) as Sent);
  });
  eval(buildInjected("recorder.js", { __NONCE__: '"n1"', __BINDING__: "__diveTest", __MAX_FIELD__: "4096" }));
});

beforeEach(() => {
  sent.length = 0;
  document.body.innerHTML = "";
});

function change(el: Element) {
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("recorder", () => {
  it("records a checkbox toggle once", () => {
    document.body.innerHTML = `<label><input type="checkbox"> Remember me</label>`;
    document.querySelector("input")!.click();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "click", role: "checkbox" });
  });

  it("records a radio choice once", () => {
    document.body.innerHTML = `<label><input type="radio" name="plan"> Monthly</label>`;
    document.querySelector("input")!.click();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "click", role: "radio" });
  });

  it("records a dropdown choice as one select step with the option text", () => {
    document.body.innerHTML = `<label>Country <select><option value="kh">Cambodia</option><option value="ca">Canada</option></select></label>`;
    const select = document.querySelector("select")!;
    select.value = "ca";
    change(select);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "select", role: "combobox", value: "Canada" });
  });

  it("records every selected option of a multi-select, and no clicks on its options", () => {
    document.body.innerHTML = `<select multiple aria-label="Letters"><option>A</option><option>B</option><option>C</option></select>`;
    const select = document.querySelector("select")!;
    select.options[0]!.selected = true;
    select.options[1]!.selected = true;
    select.options[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(sent).toHaveLength(0);
    change(select);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "select", role: "listbox", value: "A\nB" });
  });

  it("records committed text as a type step", () => {
    document.body.innerHTML = `<label>Search <input type="text"></label>`;
    const input = document.querySelector("input")!;
    input.value = "dive";
    change(input);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "type", value: "dive" });
  });

  it("masks a password", () => {
    document.body.innerHTML = `<label>Password <input type="password"></label>`;
    const input = document.querySelector("input")!;
    input.value = "hunter2";
    change(input);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "type", masked: true, value: "" });
  });
});
