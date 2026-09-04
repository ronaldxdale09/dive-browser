import { describe, expect, it } from "vitest";
import { generateAvatar } from "./avatarGenerator";

describe("saved avatar compatibility", () => {
  // Captured from the shipping synchronous generators before moving them to a worker.
  it.each([
    ["profile", "ada", "#7FD8C8", "4c044281a1f88e9abaf08163d38cda1fa8f5c49883c4353cbc8dff9c07ef2e61"],
    ["profile", "custom saved seed", "#F0B35E", "412c0183b9ae1dae9c6b58f3effd13579e94e8ef356be9d8264aa9274c24a96e"],
    ["workspace", "aurora", "#7FD8C8", "844bc08b0b521fec4e96d1c3cd97ded8be207fa74e2398662d6fdac953b2c7f3"],
    ["workspace", "", "#F0B35E", "6b85be05b8f80232991dfc19cb6ed837858ceaec38b1919ba22687fa8e6a2322"],
  ] as const)("preserves %s artwork for %s", async (kind, seed, color, hash) => {
    const bytes = new TextEncoder().encode(generateAvatar({ kind, seed, color }));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    expect(Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(hash);
  });
});
