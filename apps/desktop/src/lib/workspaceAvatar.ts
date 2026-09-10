/**
 * Workspace marks.
 *
 * The drawings live in `workspaceMarks.ts`; this module owns the seeds the
 * picker offers and the seed a name suggests. Profiles still use DiceBear
 * (notionists); workspaces do not, because a workspace is a thing you do
 * rather than a person, and none of DiceBear's sets both say that and move.
 *
 * The stored `icon` of a workspace is the seed, so the same name always draws
 * the same mark. A seed written before this — a shapes seed like "aurora", or
 * an older glyph name — still resolves, deterministically, to one of the marks.
 */

import { WORKSPACE_MARKS } from "./workspaceMarks";

/** Marks offered in the picker, after the one derived from the name. */
export const AVATAR_SEEDS: string[] = [...WORKSPACE_MARKS];

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
