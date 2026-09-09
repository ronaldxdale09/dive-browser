import { describe, expect, it } from "vitest";
import { prettyJson, shellQuote, toCurl } from "./curl";

describe("toCurl", () => {
  it("repeats a GET with the page's own headers and quotes safely", () => {
    const cmd = toCurl({ method: "GET", url: "https://a.dev/api?q=it's", request_headers: { Accept: "application/json", "sec-ch-ua": '"Chromium";v="151"', "X-Trace": "abc" }, request_body: null });
    expect(cmd).toBe(`curl 'https://a.dev/api?q=it'\\''s' \\\n  -H 'Accept: application/json' \\\n  -H 'X-Trace: abc'`);
  });

  it("adds the method and body for a POST", () => {
    const cmd = toCurl({ method: "POST", url: "https://a.dev/api", request_headers: { "Content-Type": "application/json" }, request_body: '{"q":"hello"}' });
    expect(cmd).toBe(`curl 'https://a.dev/api' \\\n  -X POST \\\n  -H 'Content-Type: application/json' \\\n  --data-raw '{"q":"hello"}'`);
  });

  it("quotes for a POSIX shell", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("prettyJson", () => {
  it("indents JSON and leaves other text alone", () => {
    expect(prettyJson('{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(prettyJson("<html>")).toBe("<html>");
  });
});
