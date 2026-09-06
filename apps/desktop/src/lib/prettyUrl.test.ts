import { describe, expect, it } from "vitest";
import { prettyUrl } from "./prettyUrl";

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
