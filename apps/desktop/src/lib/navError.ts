import { isMac, isWindows } from "./commands";

/**
 * Friendly wording for Chromium's network error codes, the ones the page
 * itself never gets to render because the document request failed.
 */
export type NavErrorText = {
  /** Headline. */
  title: string;
  /** One line under it. */
  detail: string;
  /** What to try, when there is something specific. */
  hint?: string;
};

/** Where this OS lists the HTTP proxy. Windows: Settings › Network & internet › Proxy. */
export function proxySettingsPath(windows = isWindows()): string {
  return windows ? "Settings › Network & internet › Proxy" : "System Settings › Network";
}

/** Settings › Privacy hint for the System proxy mode. */
export function systemProxyHint(windows = isWindows()): string {
  return `System follows ${proxySettingsPath(windows)}.`;
}

export function describeNavError(error: string, url: string, windows = isWindows(), mac = isMac()): NavErrorText {
  const code = errorCode(error);
  const port = portOf(url);
  if (code.startsWith("ERR_DIVE_NATIVE_")) {
    return { title: "This tab could not start", detail: "Dive could not create the page's view in time; the rest of the window is unaffected.", hint: "Retry to create it again. If it keeps happening, close a few tabs first." };
  }
  switch (code) {
    case "ERR_DIVE_REQUEST_RECOVERY":
      return { title: "The page stopped responding", detail: "A page request could not be completed safely. Your protection settings are still enabled.", hint: "Retry to load the page again." };
    case "ERR_DIVE_PROTOCOL_OVERLOAD":
      return { title: "This tab became too busy", detail: "The browser stopped this tab's connection to keep the window responsive.", hint: "Retry to reconnect this tab." };
    case "ERR_NAME_NOT_RESOLVED":
      return { title: "This site can't be reached", detail: "DNS lookup failed: the server's address could not be found.", hint: "Check the spelling of the host, or your DNS settings." };
    case "ERR_NAME_RESOLUTION_FAILED":
      return { title: "Can't look up addresses", detail: "The DNS server did not answer, so no address could be looked up.", hint: "Check your connection or DNS settings; Dive retries when the network comes back." };
    case "ERR_CONNECTION_REFUSED":
      return { title: "Connection refused", detail: "Nothing is answering at that address.", hint: port ? `If this is your dev server, check it is running on port ${port}.` : "If this is your dev server, check it is running on that port." };
    case "ERR_CONNECTION_RESET":
      return { title: "Connection reset", detail: "The server closed the connection before it finished answering." };
    case "ERR_CONNECTION_TIMED_OUT":
    case "ERR_TIMED_OUT":
      return { title: "Took too long to respond", detail: "The server did not answer in time." };
    case "ERR_INTERNET_DISCONNECTED":
      return { title: "You're offline", detail: "There is no network connection.", hint: "Check Wi‑Fi or the cable, then retry." };
    case "ERR_ADDRESS_UNREACHABLE":
      return { title: "Address unreachable", detail: "There is no route to that address from this machine." };
    case "ERR_TOO_MANY_REDIRECTS":
      return { title: "Too many redirects", detail: "The page redirected in a loop." };
    case "ERR_UNSAFE_PORT":
      return { title: "That port is off limits", detail: port ? `Browsers refuse port ${port}: it belongs to another kind of service.` : "Browsers refuse this port: it belongs to another kind of service.", hint: "Run the server on a port above 1024, such as 3000 or 8080." };
    case "ERR_EMPTY_RESPONSE":
      return { title: "Empty response", detail: "The server accepted the connection but sent nothing back.", hint: "If this is your dev server, look at its terminal for a crash." };
    case "ERR_CONNECTION_CLOSED":
      return { title: "Connection closed", detail: "The server hung up before the page finished loading." };
    case "ERR_CONNECTION_ABORTED":
      return { title: "Connection aborted", detail: "The connection was cut off before the page arrived; the network may have dropped for a moment." };
    case "ERR_CACHE_MISS":
      return { title: "This page needs its form sent again", detail: "It was the answer to a form, and it is no longer kept. Sending the form again could repeat what it did, such as a purchase or a post.", hint: "Retry only if you mean to send it again." };
    case "ERR_BLOCKED_BY_RESPONSE":
      return { title: "The site refused to be shown here", detail: "The server's own headers forbid showing this page in this context (a cross-origin or framing policy).", hint: "Open the address in its own tab, or check the headers in the Network panel if this is your server." };
    case "ERR_ACCESS_DENIED":
      if (url.startsWith("file:")) {
        return mac
          ? { title: "Dive can't read that file", detail: "macOS keeps apps out of Desktop, Documents, Downloads and removable drives until they are allowed in.", hint: "Allow Dive in System Settings › Privacy & Security › Files and Folders, then retry." }
          : { title: "Dive can't read that file", detail: "This account is not allowed to read it.", hint: "Check the file's permissions, then retry." };
      }
      return { title: "Access denied", detail: "The request was refused before it left this machine." };
    case "ERR_SSL_PROTOCOL_ERROR":
      return { title: "Secure connection failed", detail: "The server's reply was not a secure connection Dive could use.", hint: port && port !== "443" ? `A server that speaks plain http on port ${port} does this; try http:// for a dev server.` : "A server that speaks plain http where https was asked for does this." };
    case "ERR_NETWORK_CHANGED":
      return { title: "Network changed", detail: "The connection changed while the page was loading.", hint: "Retry now that it has settled." };
    case "ERR_PROXY_CONNECTION_FAILED":
      return { title: "Proxy unreachable", detail: "The configured proxy did not answer.", hint: `Check the proxy in ${proxySettingsPath(windows)}.` };
    case "ERR_FILE_NOT_FOUND":
      return { title: "File not found", detail: "There is no file at that path." };
    case "ERR_INVALID_URL":
      return { title: "That is not a valid address", detail: "The address could not be parsed.", hint: "Check for stray characters or a missing scheme." };
    case "ERR_CERT_DATE_INVALID":
      return { title: "Certificate expired", detail: "The site's certificate is past its dates, or not yet valid.", hint: "If the site is fine elsewhere, check this computer's date and time." };
    case "ERR_CERT_COMMON_NAME_INVALID":
      return { title: "Certificate is for another site", detail: "The certificate the server sent does not name this host.", hint: "A dev server answering on a different hostname than its certificate does this." };
    case "ERR_HTTP_RESPONSE_CODE_FAILURE":
      return { title: "The server answered with an error", detail: "It replied with an error status and no page to show.", hint: "If this is your dev server, its terminal or log has the reason. The Network panel shows the status." };
    case "ERR_INVALID_RESPONSE":
    case "ERR_INVALID_HTTP_RESPONSE":
      return { title: "The server's reply made no sense", detail: "What came back was not a valid HTTP response.", hint: "A server speaking another protocol on that port, or a crash mid-reply, does this." };
    case "ERR_BLOCKED_BY_CLIENT":
      return { title: "Blocked by Dive", detail: "A request rule in this workspace, or DivePrivacy, stopped this page from loading.", hint: "Check the Rules panel in the developer dock, or pause protection for this site." };
    default:
      if (code.startsWith("ERR_CERT_") || code.startsWith("ERR_SSL_")) {
        return { title: "Certificate problem", detail: `The site's security certificate could not be verified (${code}).`, hint: "A dev server with a self-signed certificate does this; trust the certificate or use http://." };
      }
      return { title: "The page could not be loaded", detail: code || "Unknown error." };
  }
}

/** Chromium's code in an error text, such as `ERR_NAME_NOT_RESOLVED` from `net::ERR_NAME_NOT_RESOLVED`. */
export function errorCode(error: string): string {
  return (error.match(/ERR_[A-Z0-9_]+/) ?? [error.replace(/^net::/, "")])[0] ?? error;
}

/**
 * Failures that mean the network was not there, rather than that the site
 * said no. Only these are worth trying again on their own: the next attempt
 * has a real chance once the connection is back.
 */
const CONNECTIVITY = new Set([
  "ERR_INTERNET_DISCONNECTED",
  "ERR_NETWORK_CHANGED",
  "ERR_NAME_RESOLUTION_FAILED",
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_TIMED_OUT",
  "ERR_ADDRESS_UNREACHABLE",
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_ABORTED",
  "ERR_NETWORK_IO_SUSPENDED",
  "ERR_PROXY_CONNECTION_FAILED",
]);

/**
 * Failures that are usually the network being down, but are also what a
 * typo or a stopped dev server look like. Worth one retry when the system
 * says the network came back; not worth a retry on a timer, which would
 * reload a mistyped address three times for nothing.
 */
const ONLINE_ONLY = new Set(["ERR_NAME_NOT_RESOLVED"]);

/**
 * When a failed page may be tried again without being asked: `"backoff"`
 * once the network returns and then on a short timer, `"online"` only once
 * the network returns, `"never"` otherwise. A form's answer (`POST`) and a
 * certificate error are never retried: one could repeat a purchase, the
 * other is not the network's fault.
 */
export function retryPolicy(error: string, method?: string): "backoff" | "online" | "never" {
  if (method && method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD") return "never";
  const code = errorCode(error);
  if (code.startsWith("ERR_CERT_") || code.startsWith("ERR_SSL_")) return "never";
  if (CONNECTIVITY.has(code)) return "backoff";
  if (ONLINE_ONLY.has(code)) return "online";
  return "never";
}

/** Seconds between automatic retries of a page that failed for want of a network. */
export const RETRY_DELAYS = [2, 5, 15] as const;

function portOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : null);
  } catch {
    return null;
  }
}

/**
 * What to search for when a host does not resolve: its labels without the
 * top-level domain or a leading "www", joined with spaces so the address
 * bar treats it as a query, not another host. Empty when there is no host.
 */
export function searchTermFor(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return "";
  }
  const labels = host.replace(/^www\./, "").split(".").filter(Boolean);
  if (labels.length > 1) labels.pop();
  return labels.join(" ");
}
