import { shapes } from "@dicebear/collection";
import { createAvatar } from "@dicebear/core";

/**
 * Workspace marks: DiceBear "shapes" avatars generated in-process.
 *
 * "shapes" over the character styles because a workspace is a place, not a
 * person, and its geometry still reads at 24px in the rail. The library runs
 * locally rather than through api.dicebear.com: the chrome's CSP is
 * `default-src 'self'`, and a browser's own chrome must not hit the network to
 * paint itself.
 *
 * The stored `icon` of a workspace is the seed, so the same name always draws
 * the same mark, and values written before this (plain glyph names) simply
 * seed an avatar of their own instead of breaking.
 */

/** Marks are drawn on the workspace color, in one of these two inks. */
const INKS = ["f4f4f4", "141414"];

/** Seeds offered in the picker, after the one derived from the name. */
export const AVATAR_SEEDS = [
  "aurora",
  "atlas",
  "cobalt",
  "ember",
  "fern",
  "harbor",
  "juno",
  "koda",
  "lumen",
  "nimbus",
  "onyx",
  "quartz",
  "slate",
];

const cache = new Map<string, string>();

/** A `data:` URL for the mark of `seed` drawn on `color`. Memoized: the rail
 * re-renders on every tab change and generation is pure CPU. */
export function workspaceAvatar(seed: string, color: string): string {
  const key = `${seed}|${color}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const uri = createAvatar(shapes, {
    seed: seed || "dive",
    size: 64,
    backgroundColor: [color.replace("#", "")],
    shape1Color: INKS,
    shape2Color: INKS,
    shape3Color: INKS,
  }).toDataUri();
  cache.set(key, uri);
  return uri;
}

/** The seed a name suggests, so a workspace has a mark before one is picked. */
export function seedFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    // Fold accents first, so "Café" seeds "cafe" rather than losing the vowel.
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  return slug || "dive";
}
