import { describe, expect, it } from "vitest";
import { textToHeaders } from "./ReplayEditor";

describe("textToHeaders", () => {
  it("parses name: value lines and skips junk", () => {
    expect(textToHeaders("Accept: */*\nX-Token:  abc: def\nnocolon\n: empty\n")).toEqual({ Accept: "*/*", "X-Token": "abc: def" });
  });
});
