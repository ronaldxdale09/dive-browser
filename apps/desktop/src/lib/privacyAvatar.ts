import { createAvatar } from "@dicebear/core";
import { botttsNeutral } from "@dicebear/collection";

let guardian: string | null = null;

/** A deterministic, bundled privacy guardian avatar. */
export function privacyGuardian(): string {
  guardian ??= createAvatar(botttsNeutral, {
    seed: "Dive Privacy",
    size: 96,
    backgroundColor: ["transparent"],
  }).toDataUri();
  return guardian;
}
