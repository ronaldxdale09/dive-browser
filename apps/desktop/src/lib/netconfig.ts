/**
 * The rules the host applies to the DNS and proxy settings before it hands
 * them to Chromium (netconfig.rs), mirrored so Settings can say at once when
 * a value will be ignored. The host drops what does not pass rather than
 * starting the engine in a state Settings does not describe; saying nothing
 * about it left the screen showing a setting that was not in force.
 */

/** Characters a proxy address may hold: anything else could smuggle in another switch. */
const AUTHORITY = /^[A-Za-z0-9.\-:_[\]/]+$/;

function parse(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Why a custom DoH template will be ignored, or null when it will be used. */
export function dnsTemplateProblem(template: string): string | null {
  const url = parse(template.trim());
  if (url && url.protocol === "https:" && url.hostname) return null;
  return template.trim()
    ? "Use an https:// address. Until then lookups go to the system resolver, unencrypted."
    : "Enter the resolver's https:// address. Until then lookups go to the system resolver, unencrypted.";
}

/** Whether one `host:port` (optionally with a scheme) would be passed on. */
export function isProxyAuthority(value: string): boolean {
  const v = value.trim();
  return v.length > 0 && v.length <= 255 && AUTHORITY.test(v);
}

/** Why a manual proxy address will be ignored, or null when it will be used. */
export function proxyServerProblem(server: string): string | null {
  if (isProxyAuthority(server)) return null;
  return server.trim()
    ? "Write it as host:port, with no spaces or quotes. Until then the system proxy settings are used."
    : "Enter the proxy's host:port. Until then the system proxy settings are used.";
}

/** Whether one bypass entry is kept: an address, `*.` and a host, or `<local>`. */
function isBypassEntry(entry: string): boolean {
  if (entry === "<local>") return true;
  const host = entry.startsWith("*.") ? entry.slice(2) : entry;
  return isProxyAuthority(host);
}

/** Entries of a bypass list the host will drop. */
export function ignoredBypass(list: string): string[] {
  return list
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry && !isBypassEntry(entry));
}

/** Why a PAC script address will be ignored, or null when it will be used. */
export function pacProblem(address: string): string | null {
  const v = address.trim();
  const url = parse(v);
  if (url && ["http:", "https:", "file:"].includes(url.protocol) && !/\s/.test(v)) return null;
  return v
    ? "Use the script's full address, such as http://wpad/proxy.pac. Until then the system proxy settings are used."
    : "Enter the script's address. Until then the system proxy settings are used.";
}
