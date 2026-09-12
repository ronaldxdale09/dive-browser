import { describe, expect, it } from "vitest";
import { fold, foldProgress } from "./downloads";

const started = { tab: null, url: "https://cdn.example.com/report.pdf", path: "/dl/report.pdf", status: "started" };

describe("downloads fold", () => {
  it("adds a start and completes it in place", () => {
    const one = fold([], started, 1000);
    expect(one).toEqual([{ url: started.url, path: started.path, name: "report.pdf", status: "started", at: 1000, startedAt: 1000 }]);
    const done = fold(one, { ...started, status: "finished" }, 2000);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ status: "finished", at: 2000 });
  });

  it("matches a failure by URL when the engine has no path for it", () => {
    const one = fold([], started, 1000);
    const failed = fold(one, { tab: null, url: started.url, path: "", status: "failed" }, 3000);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ status: "failed", path: "/dl/report.pdf" });
  });

  it("keeps the newest first and caps the list", () => {
    let items = fold([], started, 1);
    for (let i = 0; i < 60; i++) items = fold(items, { tab: null, url: `https://x/${i}`, path: `/dl/${i}`, status: "finished" }, i + 2);
    expect(items).toHaveLength(50);
    expect(items[0]?.name).toBe("59");
  });
});

describe("a second finish for the same download", () => {
  it("updates the row instead of adding another", () => {
    // The engine reports `Finished` on every update once the download is
    // complete. Matching only rows still "started" let the second one through
    // as a new row -- and a second "Saved ..." toast with it.
    let items = fold([], started, 1000);
    items = fold(items, { ...started, status: "finished" }, 2000);
    items = fold(items, { ...started, status: "finished" }, 2100);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: "finished" });
  });
});

describe("download progress", () => {
  const update = {
    id: 7, url: started.url, path: started.path,
    received: 500_000, total: 2_000_000, speed: 250_000, paused: false,
  };

  it("fills in the numbers a bar needs, and the id a cancel needs", () => {
    const items = foldProgress(fold([], started, 1000), update, 1500);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 7, received: 500_000, total: 2_000_000, speed: 250_000 });
  });

  it("leaves `at` alone so the row neither re-keys nor resets its own age", () => {
    const items = foldProgress(fold([], started, 1000), update, 9999);
    expect(items[0]?.at).toBe(1000);
  });

  it("carries no total when the server sent none, so nothing invents a percentage", () => {
    const items = foldProgress(fold([], started, 1000), { ...update, total: null }, 1500);
    expect(items[0]?.total).toBeUndefined();
    expect(items[0]?.received).toBe(500_000);
  });

  it("treats a missing count as zero rather than NaN", () => {
    // f64 crosses as `number | null`, because NaN has no JSON form.
    const items = foldProgress(fold([], started, 1000), { ...update, received: null, speed: null }, 1500);
    expect(items[0]?.received).toBe(0);
    expect(items[0]?.speed).toBe(0);
  });

  it("opens a row for a download it never heard start", () => {
    const items = foldProgress([], update, 1500);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: "started", name: "report.pdf", id: 7 });
  });

  it("shows a finished download as whole, whatever the last report said", () => {
    let items = foldProgress(fold([], started, 1000), update, 1500);
    items = fold(items, { ...started, status: "finished" }, 2000);
    expect(items[0]).toMatchObject({ status: "finished", received: 2_000_000, speed: 0 });
  });
});
