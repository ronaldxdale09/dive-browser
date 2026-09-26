import { describe, expect, it } from "vitest";
import { dnsTemplateProblem, ignoredBypass, isProxyAuthority, pacProblem, proxyServerProblem } from "./netconfig";

describe("network settings the host would ignore", () => {
  it("takes only an https resolver address", () => {
    expect(dnsTemplateProblem("https://dns.example.com/dns-query")).toBeNull();
    expect(dnsTemplateProblem("http://dns.example.com/dns-query")).toMatch(/https:\/\//);
    expect(dnsTemplateProblem("")).toMatch(/Enter/);
  });

  it("takes a proxy as host:port, with a scheme if wanted, and nothing that could be another switch", () => {
    expect(isProxyAuthority("10.0.0.2:8080")).toBe(true);
    expect(isProxyAuthority("socks5://10.0.0.2:1080")).toBe(true);
    expect(proxyServerProblem("10.0.0.2:8080")).toBeNull();
    expect(proxyServerProblem("10.0.0.2:8080 --flag")).toMatch(/host:port/);
    expect(proxyServerProblem("")).toMatch(/Enter/);
    expect(ignoredBypass("localhost, 127.0.0.1, bad entry, *.internal, <local>, *")).toEqual(["bad entry", "*"]);
  });

  it("takes a PAC script over http, https or file, never a bare word", () => {
    expect(pacProblem("http://wpad/proxy.pac")).toBeNull();
    expect(pacProblem("file:///etc/proxy.pac")).toBeNull();
    expect(pacProblem("wpad")).toMatch(/full address/);
  });
});
