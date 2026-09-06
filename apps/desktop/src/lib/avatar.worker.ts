import { generateAvatar } from "./avatarGenerator";
import type { AvatarInput } from "./avatarCache";

self.onmessage = ({ data }: MessageEvent<AvatarInput & { key: string }>) => {
  try { self.postMessage({ key: data.key, url: generateAvatar(data) }); }
  catch { self.postMessage({ key: data.key }); }
};
