// This module belongs exclusively to the worker bundle, never browser chrome.
import { notionists } from "@dicebear/collection";
import { createAvatar } from "@dicebear/core";
import type { AvatarInput } from "./avatarCache";
import { renderWorkspaceMark } from "./workspaceMarks";
import { accentInk } from "./theme";

/** Preserve the exact existing DiceBear style/options for profiles. */
export function generateAvatar({ kind, seed, color }: AvatarInput): string {
  if (kind === "profile") {
    const svg = createAvatar(notionists, { seed, backgroundColor: [color.replace("#", "")], radius: 50, scale: 96 }).toString();
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }
  // Workspaces wear Dive's own marks rather than a generated avatar: they
  // say what a workspace is for, and they move. The ink is whichever of
  // black or white wins on this colour, so every mark stays legible on
  // every swatch.
  const svg = renderWorkspaceMark(seed, color, accentInk(color));
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
