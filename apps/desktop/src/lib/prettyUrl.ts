/**
 * The address the bar shows at rest: host and path for web pages, the bare
 * scheme and page for Dive's own pages ("dive://screen" says what it is).
 */
export function prettyUrl(url: string): string {
  if (url.startsWith("dive://")) return url.split("?")[0] ?? url;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return url;
    const path = u.pathname === "/" && !u.search ? "" : u.pathname + u.search;
    return u.host + path;
  } catch {
    return url;
  }
}
