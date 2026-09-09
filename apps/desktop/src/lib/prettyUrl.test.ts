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

describe("splitAddress", () => {
  it("separates the host from the path so the bar can dim the path", () => {
    expect(splitAddress("https://www.youtube.com/watch?v=abc&list=x")).toEqual({ host: "www.youtube.com", rest: "/watch?v=abc&list=x" });
    expect(splitAddress("https://example.com/")).toEqual({ host: "example.com", rest: "" });
    expect(splitAddress("dive://screen?src=a")).toEqual({ host: "dive://screen", rest: "" });
    expect(splitAddress("not a url")).toEqual({ host: "not a url", rest: "" });
  });
});
