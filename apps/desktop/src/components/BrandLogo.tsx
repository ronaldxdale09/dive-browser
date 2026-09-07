import { brandLogo } from "../lib/brandLogos";

/**
 * An official brand mark at `size` pixels. Marks that come in a light and a
 * dark drawing render both, and the stylesheet shows the one for the
 * current theme (`.brand-logo` in `styles.css`), so a theme change needs no
 * re-render. Returns `null` for an id without a mark, so callers can fall
 * back to their own drawing.
 */
export function BrandLogo({ id, size = 16, className = "", alt = "" }: { id: string; size?: number; className?: string; alt?: string }) {
  const logo = brandLogo(id);
  if (!logo) return null;
  const shared = { width: size, height: size, alt, draggable: false } as const;
  return (
    <span className={`brand-logo inline-grid shrink-0 place-items-center ${className}`} style={{ width: size, height: size }} data-brand={id}>
      <img {...shared} src={logo.light} data-variant={logo.dark ? "light" : "both"} className="max-h-full max-w-full object-contain" />
      {logo.dark && <img {...shared} src={logo.dark} data-variant="dark" className="max-h-full max-w-full object-contain" />}
    </span>
  );
}
