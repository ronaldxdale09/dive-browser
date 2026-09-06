import { generateAvatar } from "./avatarGenerator";
import { describe, expect, it } from "vitest";
import { seedFromName } from "./workspaceAvatar";

const workspaceAvatar = (seed: string, color: string) => generateAvatar({ kind: "workspace", seed, color });

describe("workspaceAvatar", () => {
  it("draws an inline SVG, so nothing is fetched to paint the rail", () => {
    const uri = workspaceAvatar("aurora", "#7FD8C8");
    expect(uri.startsWith("data:image/svg+xml")).toBe(true);
  });

  it("is stable per seed and colour, and differs across seeds", () => {
    expect(workspaceAvatar("aurora", "#7FD8C8")).toBe(workspaceAvatar("aurora", "#7FD8C8"));
    expect(workspaceAvatar("aurora", "#7FD8C8")).not.toBe(workspaceAvatar("ember", "#7FD8C8"));
    expect(workspaceAvatar("aurora", "#7FD8C8")).not.toBe(workspaceAvatar("aurora", "#F0B35E"));
  });
});

describe("seedFromName", () => {
  it("slugs a name and falls back when there is nothing to slug", () => {
    expect(seedFromName("  Client Work ")).toBe("client-work");
    expect(seedFromName("Ünïcode!!")).toBe("unicode");
    expect(seedFromName("   ")).toBe("dive");
  });
});
