import { describe, expect, it } from "vitest";
import type { RecordedStep } from "../lib/ipc";
import { appendStep, STEP_CAP } from "./recorder";

const step = (i: number): RecordedStep => ({ kind: "click", role: "button", name: `b${i}`, value: "", at: i });

describe("appendStep", () => {
  it("keeps the newest steps once the host's cap is reached", () => {
    let steps: RecordedStep[] = [];
    for (let i = 0; i < STEP_CAP + 3; i += 1) steps = appendStep(steps, step(i));
    expect(steps).toHaveLength(STEP_CAP);
    expect(steps[0]?.name).toBe("b3");
    expect(steps.at(-1)?.name).toBe(`b${STEP_CAP + 2}`);
  });
});
