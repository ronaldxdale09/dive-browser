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

/**
 * The resting address in two parts, so the bar can set the host in ink and
 * the path in a quieter tone: the site is what a glance should read.
 */
export function splitAddress(url: string): { host: string; rest: string } {
  const shown = prettyUrl(url);
  if (url.startsWith("dive://")) return { host: shown, rest: "" };
  try {
    const u = new URL(url);
    if ((u.protocol === "http:" || u.protocol === "https:") && shown.startsWith(u.host)) return { host: u.host, rest: shown.slice(u.host.length) };
  } catch {
    // Not a URL: shown whole.
  }
  return { host: shown, rest: "" };
}
