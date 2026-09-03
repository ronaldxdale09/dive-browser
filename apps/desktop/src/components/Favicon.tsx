import { Globe } from "lucide-react";
import { useState } from "react";
import type { Tab } from "../lib/ipc";
import { Icon } from "./Icon";

/**
 * A tab's site icon, with the globe as the fallback whenever the page has no
 * icon yet or the one it gave us fails to decode. The backend hands over a
 * `data:` URL, so this never touches the network.
 */
export function Favicon({ tab, size = 14, className = "" }: { tab: Tab; size?: number; className?: string }) {
  // Keyed on the source: a new icon deserves a fresh attempt, and a tab that
  // navigates away from a broken one shouldn't stay stuck on the globe.
  const [broken, setBroken] = useState<string | null>(null);
  const src = tab.favicon;

  if (!src || broken === src) {
    return <Icon icon={Globe} size={size} className={`shrink-0 text-ink-3 ${className}`} />;
  }
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      onError={() => setBroken(src)}
      // Sites ship icons with their own padding and aspect ratio; `contain`
      // keeps a wide wordmark from being stretched into the square.
      className={`shrink-0 object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
