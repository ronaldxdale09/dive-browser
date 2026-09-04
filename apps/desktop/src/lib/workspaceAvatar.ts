/**
 * Workspace marks: DiceBear "shapes" avatars generated locally in a worker.
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
