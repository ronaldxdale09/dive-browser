import { describe, expect, it } from "vitest";
import { generateAvatar } from "./avatarGenerator";
import defaults from "./defaultAvatars.json";

describe("saved avatar compatibility", () => {
  it("ships exactly the current generator output for both standard default icons", () => {
    expect(defaults.map(({ input }) => input)).toEqual([
      { kind: "profile", seed: "personal", color: "#7FD8C8" },
      { kind: "workspace", seed: "layers", color: "#0F6E75" },
    ]);
    for (const { input, url } of defaults) {
      const kind = input.kind === "profile" ? "profile" : "workspace";
      expect(url).toBe(generateAvatar({ ...input, kind }));
    }
  });
  // Captured from the shipping generators, so a saved avatar never silently
  // changes. The two workspace hashes were renewed when workspaces moved from
  // DiceBear to Dive's own animated marks; the profile hashes did not move,
  // which is what proves that change was confined to workspaces.
  it.each([
    ["profile", "ada", "#7FD8C8", "4c044281a1f88e9abaf08163d38cda1fa8f5c49883c4353cbc8dff9c07ef2e61"],
    ["profile", "custom saved seed", "#F0B35E", "412c0183b9ae1dae9c6b58f3effd13579e94e8ef356be9d8264aa9274c24a96e"],
    ["workspace", "aurora", "#7FD8C8", "319fd8b62d5cb56f09c6294fb07c740f0d41e96d13ddb4c5ae5367632bd3d995"],
    ["workspace", "", "#F0B35E", "1e75ec48d7405356bffc239da4aefeb4c3e8aeb9d045d55e3c14a7be19300c05"],
  ] as const)("preserves %s artwork for %s", async (kind, seed, color, hash) => {
    const bytes = new TextEncoder().encode(generateAvatar({ kind, seed, color }));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    expect(Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(hash);
  });
});
