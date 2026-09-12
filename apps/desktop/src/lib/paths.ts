/**
 * The file's own name, out of a path from either platform.
 *
 * Splitting on `/` alone is the obvious version and is wrong on Windows, where
 * the separator is `\` and nothing gets split off: the downloads list, the
 * "Saved …" toast and two other notices all showed
 * `C:\Users\you\Downloads\report.csv` where they meant `report.csv`.
 *
 * A backslash is a legal character in a macOS filename, so this is a trade:
 * `weird\name.txt` on a Mac is reported as `name.txt`. That is much rarer than
 * every Windows download, and it degrades to a shorter name rather than a
 * wrong one.
 */
export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part) return part;
  }
  return "";
}

/** `fileName`, or `fallback` when the path has nothing to give. */
export function fileNameOr(path: string, fallback: string): string {
  return fileName(path) || fallback;
}

/** "1.2 MB", "840 kB", "512 B" -- what a download row shows. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  // One decimal below ten so 1.4 MB does not read as 1 MB, none above it
  // where the extra digit is noise.
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
