import { describe, expect, it } from "vitest";
import { isSensitiveKey, prettyJson, shellQuote, toCurl } from "./curl";

describe("toCurl", () => {
  it("repeats a GET with the page's own headers and quotes safely", () => {
    const cmd = toCurl({ method: "GET", url: "https://a.dev/api?q=it's", request_headers: { Accept: "application/json", "sec-ch-ua": '"Chromium";v="151"', "X-Trace": "abc" }, request_body: null });
    expect(cmd).toBe(`curl 'https://a.dev/api?q=it'\\''s' \\\n  -H 'Accept: application/json' \\\n  -H 'X-Trace: abc'`);
  });

  it("adds the method and body for a POST", () => {
    const cmd = toCurl({ method: "POST", url: "https://a.dev/api", request_headers: { "Content-Type": "application/json" }, request_body: '{"q":"hello"}' });
    expect(cmd).toBe(`curl 'https://a.dev/api' \\\n  -X POST \\\n  -H 'Content-Type: application/json' \\\n  --data-raw '{"q":"hello"}'`);
  });

  it("quotes a method that is not a plain upper-case token", () => {
    const base = { url: "https://a.dev/", request_headers: {}, request_body: null };
    expect(toCurl({ ...base, method: "CUSTOM METHOD" })).toContain("-X 'CUSTOM METHOD'");
    expect(toCurl({ ...base, method: "post" })).toContain("-X 'post'");
    expect(toCurl({ ...base, method: "PATCH" })).toContain("-X PATCH");
  });

  const secretHeaders = { Accept: "application/json", Cookie: "sid=1", Authorization: "Bearer t", "X-Api-Key": "k", "X-CSRF-Token": "c" };

  it("leaves credentials out by default", () => {
    const cmd = toCurl({ method: "GET", url: "https://a.dev/", request_headers: secretHeaders, request_body: null });
    expect(cmd).toContain("-H 'Accept: application/json'");
    for (const name of ["Cookie", "Authorization", "X-Api-Key", "X-CSRF-Token"]) expect(cmd).not.toContain(name);
  });

  it("keeps credentials when asked", () => {
    const cmd = toCurl({ method: "GET", url: "https://a.dev/", request_headers: secretHeaders, request_body: null }, { credentials: true });
    for (const name of ["Cookie", "Authorization", "X-Api-Key", "X-CSRF-Token"]) expect(cmd).toContain(name);
  });

  it("quotes for a POSIX shell", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("isSensitiveKey", () => {
  it("flags secret names and spares look-alikes", () => {
    for (const name of ["access_token", "X-Api-Key", "code", "Authorization", "session_id"]) expect(isSensitiveKey(name)).toBe(true);
    for (const name of ["author", "postcode", "accept", "content-type", "zipcode"]) expect(isSensitiveKey(name)).toBe(false);
  });
});

describe("prettyJson", () => {
  it("indents JSON and leaves other text alone", () => {
    expect(prettyJson('{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(prettyJson("<html>")).toBe("<html>");
  });
});
