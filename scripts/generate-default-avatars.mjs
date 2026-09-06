// Node 22.18+ (or Node 22 with --experimental-strip-types).
// Keep defaults byte-identical to the current worker generator. No artwork
// generator is imported into browser chrome just to display these assets.
import fs from "node:fs";
import { generateAvatar } from "../apps/desktop/src/lib/avatarGenerator.ts";

const defaults = [
  { kind: "profile", seed: "personal", color: "#7FD8C8" },
  { kind: "workspace", seed: "layers", color: "#0F6E75" },
];
const artwork = defaults.map((input) => ({ input, url: generateAvatar(input) }));
fs.writeFileSync(new URL("../apps/desktop/src/lib/defaultAvatars.json", import.meta.url), JSON.stringify(artwork, null, 2) + "\n");
