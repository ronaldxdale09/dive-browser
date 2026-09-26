import { describe, expect, it } from "vitest";
import { prettyUrl, splitAddress } from "./prettyUrl";

describe("prettyUrl", () => {
  it("trims the scheme and a bare trailing slash from web pages", () => {
    expect(prettyUrl("https://example.com/")).toBe("example.com");
    expect(prettyUrl("http://localhost:3000/app?x=1")).toBe("localhost:3000/app?x=1");
  });
  it("leaves other schemes and Dive pages readable", () => {
    expect(prettyUrl("about:blank")).toBe("about:blank");
    expect(prettyUrl("dive://screen?src=%2Ftmp%2Fa.mp4")).toBe("dive://screen");
    expect(prettyUrl("not a url")).toBe("not a url");
  });
});

describe("prettyUrl readability", () => {
  it("shows an internationalised host in its own letters", () => {
    expect(prettyUrl("https://xn--mnchen-3ya.de/")).toBe("münchen.de");
    expect(prettyUrl("https://xn--wgv71a119e.jp:8443/a")).toBe("日本語.jp:8443/a");
    const russian = new URL("https://россия.рф/").hostname;
    expect(russian).toMatch(/^xn--.*\.xn--p1ai$/);
    expect(prettyUrl(`https://${russian}/`)).toBe("россия.рф");
  });

  it("keeps punycode for a host whose letters mix scripts, as a lookalike would", () => {
    // "paypal" with a Cyrillic "а" in the middle.
    const spoof = new URL("https://p\u0430ypal.com/").hostname;
    expect(spoof.startsWith("xn--")).toBe(true);
    expect(prettyUrl(`https://${spoof}/login`)).toBe(`${spoof}/login`);
    expect(splitAddress(`https://${spoof}/login`)).toEqual({ host: spoof, rest: "/login" });
  });

  it("decodes a path's escapes, except those that would change what it says", () => {
    expect(prettyUrl("https://ja.wikipedia.org/wiki/%E6%97%A5%E6%9C%AC")).toBe("ja.wikipedia.org/wiki/日本");
    expect(prettyUrl("https://example.com/caf%C3%A9?q=cr%C3%A8me")).toBe("example.com/café?q=crème");
    expect(prettyUrl("https://example.com/a%20b%2Fc%3Fd%25e")).toBe("example.com/a%20b%2Fc%3Fd%25e");
    // A direction override or an invisible character is never drawn.
    expect(prettyUrl("https://example.com/%E2%80%AEtxt.exe")).toBe("example.com/%E2%80%AEtxt.exe");
    expect(prettyUrl("https://example.com/a%E2%80%8Bb")).toBe("example.com/a%E2%80%8Bb");
    // Bytes that are not UTF-8 are left as they came.
    expect(prettyUrl("https://example.com/%FF%FE")).toBe("example.com/%FF%FE");
  });

  it("splits a decoded host from its path", () => {
    expect(splitAddress("https://xn--mnchen-3ya.de/stadt")).toEqual({ host: "münchen.de", rest: "/stadt" });
  });
});

describe("splitAddress", () => {
  it("separates the host from the path so the bar can dim the path", () => {
    expect(splitAddress("https://www.youtube.com/watch?v=abc&list=x")).toEqual({ host: "www.youtube.com", rest: "/watch?v=abc&list=x" });
    expect(splitAddress("https://example.com/")).toEqual({ host: "example.com", rest: "" });
    expect(splitAddress("dive://screen?src=a")).toEqual({ host: "dive://screen", rest: "" });
    expect(splitAddress("not a url")).toEqual({ host: "not a url", rest: "" });
  });
});
