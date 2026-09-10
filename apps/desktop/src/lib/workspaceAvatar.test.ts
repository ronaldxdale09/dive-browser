import { generateAvatar } from "./avatarGenerator";
import { describe, expect, it } from "vitest";
import { AVATAR_SEEDS, seedFromName } from "./workspaceAvatar";
import { WORKSPACE_MARKS } from "./workspaceMarks";

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

describe("workspace marks", () => {
  it("offers one distinct pictogram per swatch", () => {
    // Two seeds landing on the same icon would give the picker duplicates.
    expect(new Set(AVATAR_SEEDS).size).toBe(AVATAR_SEEDS.length);
    expect(AVATAR_SEEDS).toEqual([...WORKSPACE_MARKS]);
  });

  it("draws every offered mark, with motion and a reduced-motion escape", async () => {
    const { renderWorkspaceMark } = await import("./workspaceMarks");
    for (const name of WORKSPACE_MARKS) {
      const svg = renderWorkspaceMark(name, "#7FD8C8", "#111111");
      // A mark that drew nothing would be an empty tile, hard to spot by eye.
      expect(svg, name).toMatch(/<(path|circle|rect|ellipse)/);
      expect(svg, name).toContain("#7FD8C8");
      expect(svg, name).toContain("#111111");
      expect(svg, name).toMatch(/@keyframes/);
      expect(svg, name).toContain("prefers-reduced-motion");
    }
  });

  it("gives any older seed a mark rather than an empty tile", async () => {
    const { markFor, WORKSPACE_MARKS: all } = await import("./workspaceMarks");
    for (const legacy of ["aurora", "atlas", "cobalt", "layers-old", ""]) {
      expect(all).toContain(markFor(legacy));
    }
    // The same seed always lands on the same mark.
    expect(markFor("aurora")).toBe(markFor("aurora"));
    // A seed that names a mark gets exactly that one.
    expect(markFor("compass")).toBe("compass");
  });


});
