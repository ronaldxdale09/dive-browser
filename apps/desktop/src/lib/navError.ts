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

export function describeNavError(error: string, url: string): NavErrorText {
  const code = (error.match(/ERR_[A-Z0-9_]+/) ?? [error.replace(/^net::/, "")])[0] ?? error;
  const port = portOf(url);
  switch (code) {
    case "ERR_NAME_NOT_RESOLVED":
      return { title: "This site can't be reached", detail: "DNS lookup failed: the server's address could not be found.", hint: "Check the spelling of the host, or your DNS settings." };
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
    case "ERR_NETWORK_CHANGED":
      return { title: "Network changed", detail: "The connection changed while the page was loading.", hint: "Retry now that it has settled." };
    case "ERR_PROXY_CONNECTION_FAILED":
      return { title: "Proxy unreachable", detail: "The configured proxy did not answer.", hint: "Check the proxy in System Settings › Network." };
    case "ERR_FILE_NOT_FOUND":
      return { title: "File not found", detail: "There is no file at that path." };
    case "ERR_INVALID_URL":
      return { title: "That is not a valid address", detail: "The address could not be parsed.", hint: "Check for stray characters or a missing scheme." };
    case "ERR_CERT_DATE_INVALID":
      return { title: "Certificate expired", detail: "The site's certificate is past its dates, or not yet valid.", hint: "If the site is fine elsewhere, check this Mac's date and time." };
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
