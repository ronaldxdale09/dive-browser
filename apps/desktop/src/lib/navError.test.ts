import { describe, expect, it } from "vitest";
import { describeNavError } from "./navError";

describe("describeNavError", () => {
  it("names the common failures", () => {
    expect(describeNavError("net::ERR_NAME_NOT_RESOLVED", "https://nope.test/").title).toBe("This site can't be reached");
    expect(describeNavError("net::ERR_INTERNET_DISCONNECTED", "https://x").title).toBe("You're offline");
    expect(describeNavError("net::ERR_CERT_AUTHORITY_INVALID", "https://x").title).toBe("Certificate problem");
    expect(describeNavError("net::ERR_SSL_PROTOCOL_ERROR", "https://x").title).toBe("Certificate problem");
    expect(describeNavError("net::ERR_SOMETHING_ODD", "https://x")).toEqual({ title: "The page could not be loaded", detail: "ERR_SOMETHING_ODD" });
  });

  it("points a refused connection at the port in the URL", () => {
    expect(describeNavError("net::ERR_CONNECTION_REFUSED", "http://localhost:5173/app").hint).toContain("port 5173");
    expect(describeNavError("net::ERR_CONNECTION_REFUSED", "https://example.com/").hint).toContain("port 443");
    expect(describeNavError("net::ERR_CONNECTION_REFUSED", "not a url").hint).toContain("that port");
  });

  it("explains a block as Dive's own doing", () => {
    expect(describeNavError("net::ERR_BLOCKED_BY_CLIENT", "https://httpbin.org/api/ping").title).toBe("Blocked by Dive");
  });
});
