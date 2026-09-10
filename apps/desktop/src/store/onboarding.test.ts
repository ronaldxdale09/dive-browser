import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { STAGES, shouldOnboard, useOnboarding, STEPS } from "./onboarding";
import { DEFAULT_PREFS, usePrefs } from "./prefs";

afterEach(() => {
  useOnboarding.setState({ stage: null });
  usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: false });
  vi.restoreAllMocks();
});

describe("onboarding flow", () => {
  it("opens only once the preferences and the store are ready and say it never ran", () => {
    expect(shouldOnboard(false, false, true)).toBe(false);
    expect(shouldOnboard(true, false, false)).toBe(false);
    expect(shouldOnboard(true, true, true)).toBe(false);
    expect(shouldOnboard(true, false, true)).toBe(true);
    // A private window has a fresh in-memory profile every time; it never onboards.
    expect(shouldOnboard(true, false, true, true)).toBe(false);
  });

  it("walks the intro, the start screen and every setup step, then records itself done", async () => {
    const write = vi.spyOn(ipc, "prefsSet").mockImplementation(async (p) => p);
    usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });
    const { begin, next, skipIntro, back } = useOnboarding.getState();
    begin();
    expect(useOnboarding.getState().stage).toBe("intro");
    skipIntro();
    expect(useOnboarding.getState().stage).toBe("start");
    // Skipping only applies to the intro; from anywhere else it is a no-op.
    skipIntro();
    expect(useOnboarding.getState().stage).toBe("start");
    for (const stage of STAGES.slice(2)) {
      next();
      expect(useOnboarding.getState().stage).toBe(stage);
    }
    // Back through the steps in order, whatever they are, so adding one to
    // the flow does not need this walk rewritten.
    for (const step of [...STEPS].reverse().slice(1)) {
      back();
      expect(useOnboarding.getState().stage).toBe(step);
    }
    // The first step is the floor: Back there does nothing.
    back();
    expect(useOnboarding.getState().stage).toBe(STEPS[0]);
    // Forward through every step, and once more off the end to finish.
    for (let i = 0; i < STEPS.length; i++) next();
    await vi.waitFor(() => expect(usePrefs.getState().prefs.onboarded).toBe(true));
    expect(useOnboarding.getState().stage).toBeNull();
    expect(write).toHaveBeenLastCalledWith(expect.objectContaining({ onboarded: true }));
  });

  it("replays from the intro and forgets that it was done", async () => {
    vi.spyOn(ipc, "prefsSet").mockImplementation(async (p) => p);
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, onboarded: true }, loaded: true });
    await useOnboarding.getState().replay();
    expect(useOnboarding.getState().stage).toBe("intro");
    expect(usePrefs.getState().prefs.onboarded).toBe(false);
  });
});
