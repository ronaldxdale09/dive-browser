import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { BOOT_CHECK_DELAY_MS, PROGRESS_INTERVAL_MS, reportUpdateProgress, resetBootCheck, scheduleBootCheck, useUpdates } from "./updates";

const initial = useUpdates.getState();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetBootCheck();
  useUpdates.setState(initial, true);
});

describe("useUpdates", () => {
  it("records an offered update", async () => {
    vi.spyOn(ipc, "updateCheck").mockResolvedValue({ version: "0.2.0", notes: "Faster." });
    await useUpdates.getState().check();
    expect(useUpdates.getState()).toMatchObject({ status: "available", update: { version: "0.2.0", notes: "Faster." } });
  });

  it("treats null as current", async () => {
    vi.spyOn(ipc, "updateCheck").mockResolvedValue(null);
    await useUpdates.getState().check();
    expect(useUpdates.getState()).toMatchObject({ status: "none", update: null });
  });

  it("keeps a failed check as an error, not a crash", async () => {
    vi.spyOn(ipc, "updateCheck").mockRejectedValue(new Error("offline"));
    await useUpdates.getState().check();
    expect(useUpdates.getState()).toMatchObject({ status: "error", error: "offline" });
  });

  it("installs once and reports a failure", async () => {
    const install = vi.spyOn(ipc, "updateInstall").mockRejectedValue(new Error("signature"));
    await useUpdates.getState().install();
    expect(install).toHaveBeenCalledTimes(1);
    expect(useUpdates.getState()).toMatchObject({ installing: false, error: "signature" });
  });
});

describe("reportUpdateProgress", () => {
  it("writes the store at most once per interval, keeps the latest count, and ends at once", () => {
    const writes = vi.fn();
    const unsubscribe = useUpdates.subscribe(writes);
    const progress = (received: number) => ({ received, total: 1000, done: false });

    // The first report shows straight away; the chunks behind it wait.
    reportUpdateProgress(progress(10));
    expect(writes).toHaveBeenCalledTimes(1);
    expect(useUpdates.getState()).toMatchObject({ received: 10, total: 1000 });
    for (const n of [20, 30, 40]) reportUpdateProgress(progress(n));
    expect(writes).toHaveBeenCalledTimes(1);
    expect(useUpdates.getState().received).toBe(10);

    // When the interval lapses the newest count lands, not the first one queued.
    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS);
    expect(writes).toHaveBeenCalledTimes(2);
    expect(useUpdates.getState().received).toBe(40);

    // The end of the download is not held back by the throttle.
    reportUpdateProgress(progress(50));
    reportUpdateProgress({ received: null, total: null, done: true });
    expect(useUpdates.getState().applying).toBe(true);
    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS);
    expect(useUpdates.getState()).toMatchObject({ applying: true, received: 40 });
    unsubscribe();
  });
});

describe("scheduleBootCheck", () => {
  it("checks once after the delay, however many times it is scheduled", async () => {
    const check = vi.spyOn(ipc, "updateCheck").mockResolvedValue(null);
    scheduleBootCheck();
    scheduleBootCheck();
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(BOOT_CHECK_DELAY_MS);
    expect(check).toHaveBeenCalledTimes(1);
    expect(useUpdates.getState().status).toBe("none");
  });

  it("can be cancelled before it fires", async () => {
    const check = vi.spyOn(ipc, "updateCheck").mockResolvedValue(null);
    const cancel = scheduleBootCheck(1000);
    cancel();
    await vi.advanceTimersByTimeAsync(2000);
    expect(check).not.toHaveBeenCalled();
  });
});
