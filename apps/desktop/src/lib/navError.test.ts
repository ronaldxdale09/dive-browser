import { describe, expect, it } from "vitest";
import { describeNavError, retryPolicy, searchTermFor, systemProxyHint } from "./navError";

describe("describeNavError", () => {
  it("names the common failures", () => {
    expect(describeNavError("net::ERR_NAME_NOT_RESOLVED", "https://nope.test/").title).toBe("This site can't be reached");
    expect(describeNavError("net::ERR_INTERNET_DISCONNECTED", "https://x").title).toBe("You're offline");
    expect(describeNavError("net::ERR_CERT_AUTHORITY_INVALID", "https://x").title).toBe("Certificate problem");
    // Not a certificate at all: usually https asked of a port that speaks plain http.
    expect(describeNavError("net::ERR_SSL_PROTOCOL_ERROR", "https://localhost:3000/")).toMatchObject({ title: "Secure connection failed", hint: expect.stringContaining("port 3000") });
    expect(describeNavError("net::ERR_SOMETHING_ODD", "https://x")).toEqual({ title: "The page could not be loaded", detail: "ERR_SOMETHING_ODD" });
    expect(describeNavError("net::ERR_UNSAFE_PORT", "http://127.0.0.1:9/")).toMatchObject({ title: "That port is off limits", detail: expect.stringContaining("port 9") });
    expect(describeNavError("net::ERR_EMPTY_RESPONSE", "http://localhost:3000/").title).toBe("Empty response");
    expect(describeNavError("net::ERR_INVALID_URL", "nope").title).toBe("That is not a valid address");
    expect(describeNavError("net::ERR_CERT_DATE_INVALID", "https://expired.badssl.com/").title).toBe("Certificate expired");
    expect(describeNavError("net::ERR_CERT_COMMON_NAME_INVALID", "https://x").title).toBe("Certificate is for another site");
    // An error status with an empty body: Chromium has no page to show, so this one says what happened.
    expect(describeNavError("net::ERR_HTTP_RESPONSE_CODE_FAILURE", "http://localhost:3000/api")).toMatchObject({ title: "The server answered with an error", hint: expect.stringContaining("Network panel") });
    expect(describeNavError("net::ERR_INVALID_HTTP_RESPONSE", "http://localhost:5432/").title).toBe("The server's reply made no sense");
  });

  it("points a refused connection at the port in the URL", () => {
    expect(describeNavError("net::ERR_CONNECTION_REFUSED", "http://localhost:5173/app").hint).toContain("port 5173");
    expect(describeNavError("net::ERR_CONNECTION_REFUSED", "https://example.com/").hint).toContain("port 443");
    expect(describeNavError("net::ERR_CONNECTION_REFUSED", "not a url").hint).toContain("that port");
  });

  it("explains a block as Dive's own doing", () => {
    expect(describeNavError("net::ERR_BLOCKED_BY_CLIENT", "https://httpbin.org/api/ping").title).toBe("Blocked by Dive");
  });

  it("does not send Windows to this Mac's network settings for the system proxy", () => {
    expect(systemProxyHint(true)).not.toMatch(/Mac/);
    expect(systemProxyHint(true)).toMatch(/Settings › Network & internet › Proxy/);
    expect(systemProxyHint(false)).toMatch(/System Settings › Network/);
    expect(systemProxyHint(false)).not.toMatch(/Mac/);
  });

  it("points a failed proxy at this OS's Settings page, not System Settings on Windows", () => {
    const windows = describeNavError("net::ERR_PROXY_CONNECTION_FAILED", "https://x", true).hint;
    expect(windows).not.toMatch(/System Settings/);
    expect(windows).toMatch(/Settings › Network & internet › Proxy/);
    const other = describeNavError("net::ERR_PROXY_CONNECTION_FAILED", "https://x", false).hint;
    expect(other).toMatch(/System Settings › Network/);
  });

  it("points a date-invalid certificate at this computer's clock, not this Mac", () => {
    const hint = describeNavError("net::ERR_CERT_DATE_INVALID", "https://expired.badssl.com/").hint;
    expect(hint).not.toMatch(/this Mac/);
    expect(hint).toMatch(/this computer/);
  });

  it("turns an unresolved host into a search term without its domain suffix", () => {
    expect(searchTermFor("http://nonexistent-host-dive.invalid/page")).toBe("nonexistent-host-dive");
    expect(searchTermFor("https://www.docs.example.com/")).toBe("docs example");
    expect(searchTermFor("https://intranet/")).toBe("intranet");
    expect(searchTermFor("not a url")).toBe("");
  });
});

describe("the failures Dive now names", () => {
  it("tells a DNS server that did not answer apart from a host that does not exist", () => {
    expect(describeNavError("net::ERR_NAME_RESOLUTION_FAILED", "https://x").title).toBe("Can't look up addresses");
  });

  it("points a refused local file at the macOS privacy setting", () => {
    const mac = describeNavError("net::ERR_ACCESS_DENIED", "file:///Users/me/Desktop/a.html", false, true);
    expect(mac.hint).toContain("Files and Folders");
    expect(describeNavError("net::ERR_ACCESS_DENIED", "file:///home/me/a.html", false, false).hint).not.toContain("Files and Folders");
    expect(describeNavError("net::ERR_ACCESS_DENIED", "https://x").title).toBe("Access denied");
  });

  it("names a form that has to be sent again, an aborted connection and a refusing site", () => {
    expect(describeNavError("net::ERR_CACHE_MISS", "https://shop.example/checkout").title).toBe("This page needs its form sent again");
    expect(describeNavError("net::ERR_CONNECTION_ABORTED", "https://x").title).toBe("Connection aborted");
    expect(describeNavError("net::ERR_BLOCKED_BY_RESPONSE", "https://x").title).toBe("The site refused to be shown here");
  });

  it("says a tab that could not be created is Dive's problem, not the site's", () => {
    expect(describeNavError("ERR_DIVE_NATIVE_CREATION_TIMEOUT", "https://x").title).toBe("This tab could not start");
    expect(describeNavError("ERR_DIVE_NATIVE_PENDING_OVERFLOW", "https://x").title).toBe("This tab could not start");
  });
});

describe("retryPolicy", () => {
  it("retries a page that failed for want of a network", () => {
    expect(retryPolicy("net::ERR_INTERNET_DISCONNECTED")).toBe("backoff");
    expect(retryPolicy("net::ERR_NETWORK_CHANGED", "GET")).toBe("backoff");
    expect(retryPolicy("net::ERR_NAME_RESOLUTION_FAILED")).toBe("backoff");
  });

  it("waits for the network to come back before retrying what could be a typo", () => {
    expect(retryPolicy("net::ERR_NAME_NOT_RESOLVED")).toBe("online");
  });

  it("never repeats a form or argues with a certificate", () => {
    expect(retryPolicy("net::ERR_INTERNET_DISCONNECTED", "POST")).toBe("never");
    expect(retryPolicy("net::ERR_CERT_AUTHORITY_INVALID")).toBe("never");
    expect(retryPolicy("net::ERR_SSL_PROTOCOL_ERROR")).toBe("never");
    expect(retryPolicy("net::ERR_CONNECTION_REFUSED")).toBe("never");
    expect(retryPolicy("net::ERR_BLOCKED_BY_CLIENT")).toBe("never");
  });
});
