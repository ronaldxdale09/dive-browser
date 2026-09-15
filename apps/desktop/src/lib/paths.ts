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

/**
 * Whether Dive shows this file better than the system does.
 *
 * A PDF handed to the system opens in a document app, which is the wrong
 * place for something that was just downloaded from the web: the browser has
 * a PDF viewer, and the page it came from is a tab away. Everything else is
 * the system's job -- Dive is not a spreadsheet.
 */
export function opensInTab(path: string): boolean {
  return /\.pdf$/i.test(fileName(path));
}

/**
 * A local path as an address the engine will load.
 *
 * Each segment is encoded separately, so a space or a `#` in a name survives
 * -- a downloaded "ICLR 2026 #3.pdf" would otherwise load as far as the hash
 * and stop. Windows paths take the extra slash their drive letter needs.
 */
export function fileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${absolute.split("/").map(encodeURIComponent).join("/")}`;
}
