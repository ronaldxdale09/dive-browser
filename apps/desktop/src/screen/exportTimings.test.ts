import { afterEach, describe, expect, it } from "vitest";
import { ExportTimings, publishExportTimings } from "./exportTimings";

afterEach(() => {
  delete window.__diveUiInputTimingEnabled;
  delete window.__diveScreenExportTimings;
});

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}
const meta = { frames: 1, fps: 30, width: 2, height: 2, sourceWidth: 2, sourceHeight: 2, format: "mp4" as const };

describe("ExportTimings", () => {
  it("adds elapsed time to the named stage", async () => {
    const c = clock();
    const timings = new ExportTimings(c.now);
    await timings.time("seek", () => { c.advance(5); });
    await timings.time("seek", async () => { c.advance(7); });
    timings.timeSync("draw", () => { c.advance(3); });
    expect(timings.totals).toMatchObject({ seek: 12, draw: 3, upload: 0 });
  });

  it("still counts the time when the work throws", async () => {
    const c = clock();
    const timings = new ExportTimings(c.now);
    await expect(timings.time("encode", () => { c.advance(4); throw new Error("boom"); })).rejects.toThrow("boom");
    expect(() => timings.timeSync("flush", () => { c.advance(2); throw new Error("bang"); })).toThrow("bang");
    expect(timings.totals.encode).toBe(4);
    expect(timings.totals.flush).toBe(2);
  });

  it("summarises totals, metadata and uploaded bytes as numbers and plain labels", () => {
    const timings = new ExportTimings(clock().now);
    timings.uploadBytes = 10;
    expect(timings.summary(meta)).toMatchObject({ ...meta, seek: 0, uploadBytes: 10 });
  });
});

describe("publishExportTimings", () => {
  const summary = () => new ExportTimings(clock().now).summary(meta);

  it("does nothing while the switch is off", () => {
    publishExportTimings(summary());
    expect(window.__diveScreenExportTimings).toBeUndefined();
  });

  it("keeps at most 8 entries", () => {
    window.__diveUiInputTimingEnabled = true;
    for (let i = 0; i < 11; i++) publishExportTimings({ ...summary(), frames: i });
    expect(window.__diveScreenExportTimings).toHaveLength(8);
    expect(window.__diveScreenExportTimings?.[0]?.frames).toBe(3);
    expect(window.__diveScreenExportTimings?.at(-1)?.frames).toBe(10);
  });
});
