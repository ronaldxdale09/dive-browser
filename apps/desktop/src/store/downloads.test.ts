import { describe, expect, it } from "vitest";
import { fold } from "./downloads";

const started = { tab: null, url: "https://cdn.example.com/report.pdf", path: "/dl/report.pdf", status: "started" };

describe("downloads fold", () => {
  it("adds a start and completes it in place", () => {
    const one = fold([], started, 1000);
    expect(one).toEqual([{ url: started.url, path: started.path, name: "report.pdf", status: "started", at: 1000 }]);
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
