import { Globe, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { useFaviconSrc } from "../lib/favicons";
import { Icon } from "./Icon";

/**
 * A site's icon, for anything that names a page: an open tab, a history row, a
 * bookmark. `src` is usually the key the host files the icon under, which
 * `useFaviconSrc` turns into the stored `data:` URL, so this never touches
 * the network; a URL works too.
 *
 * `fallback` is what shows when the site has no icon or the one it gave us
 * fails to decode. It defaults to the globe, but a list that means something
 * more specific -- a clock for history, a star for bookmarks -- should say so,
 * or a run of unresolved rows turns into a column of identical globes.
 */
export function Favicon({
  src,
  size = 14,
  className = "",
  fallback = Globe,
  fallbackClassName = "text-ink-3",
}: {
  src?: string | null;
  size?: number;
  className?: string;
  fallback?: LucideIcon;
  fallbackClassName?: string;
}) {
  const image = useFaviconSrc(src);
  // Keyed on the source: a new icon deserves a fresh attempt, and a row that
  // navigates away from a broken one shouldn't stay stuck on the fallback.
  const [broken, setBroken] = useState<string | null>(null);

  if (!image || broken === image) {
    return <Icon icon={fallback} size={size} className={`shrink-0 ${fallbackClassName} ${className}`} />;
  }
  return (
    <img
      src={image}
      alt=""
      width={size}
      height={size}
      onError={() => setBroken(image)}
      // Sites ship icons with their own padding and aspect ratio; `contain`
      // keeps a wide wordmark from being stretched into the square.
      className={`shrink-0 object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
