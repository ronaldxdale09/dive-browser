// This module belongs exclusively to the worker bundle, never browser chrome.
import { notionists, shapes } from "@dicebear/collection";
import { createAvatar } from "@dicebear/core";
import type { AvatarInput } from "./avatarCache";

/** Preserve the exact existing DiceBear styles/options and authoritative saved seeds. */
export function generateAvatar({ kind, seed, color }: AvatarInput): string {
  if (kind === "profile") {
    const svg = createAvatar(notionists, { seed, backgroundColor: [color.replace("#", "")], radius: 50, scale: 96 }).toString();
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }
  const inks = ["f4f4f4", "141414"];
  return createAvatar(shapes, { seed: seed || "dive", size: 64, backgroundColor: [color.replace("#", "")], shape1Color: inks, shape2Color: inks, shape3Color: inks }).toDataUri();
}
