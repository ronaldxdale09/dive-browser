/**
 * What the glyph at the front of the address bar says about the page, by
 * scheme. Only http is "not secure": a page of Dive's own, a file on this
 * computer or a blank page never crossed a network, and calling them plain
 * http told people their settings page was being read on the wire.
 */
export type AddressSecurity = "none" | "failed" | "secure" | "plain" | "internal" | "file" | "local";

export function addressSecurity(url: string, { failed = false, hasTab = true }: { failed?: boolean; hasTab?: boolean } = {}): AddressSecurity {
  if (!hasTab) return "none";
  // A load that failed is not secure whatever its scheme says; the bar shows
  // a warning instead of a lock so a certificate error is not dressed up as a
  // safe page.
  if (failed) return "failed";
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  switch (scheme) {
    case "https":
    case "wss":
      return "secure";
    case "http":
    case "ws":
      return "plain";
    case "about":
      // A blank tab is somewhere to type, not a page to vouch for.
      return url.toLowerCase() === "about:blank" ? "none" : "internal";
    case "dive":
    case "chrome":
    case "devtools":
      return "internal";
    case "file":
      return "file";
    case undefined:
      // Nothing loaded yet: the bar is a place to type.
      return "none";
    default:
      // data:, blob: and the like are made on this machine; there is no
      // connection to vouch for either way.
      return "local";
  }
}

/** The glyph's hover text and accessible name for each kind. */
export const ADDRESS_SECURITY_MEANING: Record<AddressSecurity, string> = {
  none: "Search or enter an address",
  failed: "This page could not be loaded",
  secure: "Secure connection",
  plain: "Not secure: this page uses plain http",
  internal: "A page of Dive's own",
  file: "A file on this computer",
  local: "No connection to check: this page came from its own address",
};
