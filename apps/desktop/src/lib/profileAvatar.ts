import { notionists } from "@dicebear/collection";
import { createAvatar } from "@dicebear/core";

/**
 * Profile faces: DiceBear "notionists" avatars generated in-process.
 *
 * A profile is a person, so it gets a face where a workspace gets a shape.
 * "notionists" over the cartoon styles because it stays legible at 20px in
 * the title bar and does not clash with the chrome's flat, neutral look. The
 * library runs locally: the chrome's CSP is `default-src 'self'`, and the
 * browser's own chrome must not hit the network to paint itself.
 *
 * The stored `avatar` of a profile is the seed: the same seed always draws
 * the same face, so a picked face survives renames.
 */

/** Seeds offered in the picker, after the one derived from the name. */
export const PROFILE_SEEDS = ["ada", "blake", "casey", "devon", "eden", "finley", "harper", "indigo", "jules", "kai", "lane", "morgan", "noor", "oakley", "parker", "quinn", "reese", "sage", "tatum", "vale"];

const cache = new Map<string, string>();

/** A `data:` URL for the face of `seed` on `color`. Memoized: the chip and the switcher redraw often. */
export function profileAvatar(seed: string, color: string): string {
  const key = `${seed}|${color}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const svg = createAvatar(notionists, {
    seed,
    backgroundColor: [color.replace("#", "")],
    radius: 50,
    scale: 96,
  }).toString();
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  cache.set(key, url);
  return url;
}

/** The seed a name suggests before anyone picks a face. */
export function seedFromProfileName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  return trimmed || "someone";
}

/** Colours offered for a profile, chosen to read behind a face. */
export const PROFILE_COLORS = ["#7FD8C8", "#F0B35E", "#E58C8C", "#8FB8F0", "#B79CF0", "#9ED67B", "#F2A7C3", "#E9E9E9"];
