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
