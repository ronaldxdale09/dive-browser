import { describe, expect, it } from "vitest";
import { compactNumber, describeStep, formatCost, shortModel } from "./agentSteps";
import type { Step } from "../store/agent";

const step = (name: string, input: Record<string, unknown>, over: Partial<Step> = {}): Step => ({ id: "s", name, input: JSON.stringify(input), action: false, ...over });

describe("describeStep", () => {
  it("says what the agent did in plain words", () => {
    expect(describeStep(step("page_click", { locator: 'role=button[name="Save"]' })).label).toBe('Clicked role=button[name="Save"]');
    expect(describeStep(step("page_type", { locator: "label=Search", text: "youtube favicon" })).label).toBe("Typed “youtube favicon” into label=Search");
    expect(describeStep(step("page_type", { locator: "label=Search", text: "" })).label).toBe("Cleared label=Search");
    expect(describeStep(step("page_press", { key: "Enter", modifiers: ["Meta"] })).label).toBe("Pressed Meta+Enter");
    expect(describeStep(step("tab_navigate", { url: "https://www.youtube.com/watch?v=1" })).label).toBe("Opened www.youtube.com");
    expect(describeStep(step("page_wait_for", { text: "Signed in" })).label).toBe("Waited for text “Signed in”");
    expect(describeStep(step("page_wait_for", { load: true })).label).toBe("Waited for the page to load");
    expect(describeStep(step("page_resize", { preset: "iPhone 15" })).label).toBe("Resized the viewport to iPhone 15");
    expect(describeStep(step("page_resize", { width: 390, height: 844 })).label).toBe("Resized the viewport to 390×844");
    expect(describeStep(step("page_appearance", { color_scheme: "dark" })).label).toBe("Emulated dark mode");
    expect(describeStep(step("page_throttle", { profile: "slow-3g" })).label).toBe("Throttled the network to slow-3g");
    expect(describeStep(step("page_inspect", {})).label).toBe("Inspected the page");
  });
  it("falls back to the host's resolved locator, then a ref, then coordinates", () => {
    expect(describeStep(step("page_click", { ref: "e4" }, { locator: "getByRole('link', { name: 'Docs' })" })).label).toBe("Clicked getByRole('link', { name: 'Docs' })");
    expect(describeStep(step("page_click", { ref: "e4" })).label).toBe("Clicked ref e4");
    expect(describeStep(step("page_click", { x: 10.4, y: 20.6 })).label).toBe("Clicked (10, 21)");
  });
  it("truncates long typed text and survives bad input JSON", () => {
    const long = "a".repeat(80);
    expect(describeStep(step("page_type", { locator: "css=input", text: long })).label).toMatch(/^Typed “a{39}…” into css=input$/);
    expect(describeStep({ id: "x", name: "page_click", input: "{not json", action: true }).label).toBe("Clicked the page");
    expect(describeStep({ id: "x", name: "some_new_tool", input: "{}", action: false }).label).toBe("some new tool");
  });
});

describe("number formatting", () => {
  it("compacts token counts", () => {
    expect(compactNumber(812)).toBe("812");
    expect(compactNumber(3200)).toBe("3.2k");
    expect(compactNumber(3000)).toBe("3k");
    expect(compactNumber(1_100_000)).toBe("1.1M");
  });
  it("formats cost to a useful precision", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.00004)).toBe("<$0.0001");
    expect(formatCost(0.0042)).toBe("$0.0042");
    expect(formatCost(0.12)).toBe("$0.120");
    expect(formatCost(2.5)).toBe("$2.50");
  });
});

describe("shortModel", () => {
  it("drops the provider prefix and leaves bare ids alone", () => {
    expect(shortModel("anthropic/claude-opus-5")).toBe("claude-opus-5");
    expect(shortModel("accounts/fireworks/models/kimi-k2-instruct")).toBe("kimi-k2-instruct");
    expect(shortModel("gpt-5")).toBe("gpt-5");
  });
});
