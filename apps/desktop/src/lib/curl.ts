import type { RequestDetail } from "./ipc";

/** Quote for a POSIX shell: single quotes, with any inner quote spliced in. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Headers the browser adds on its own; a cURL reproduction is cleaner without them. */
const BROWSER_ONLY = new Set(["content-length", "host", "connection", "accept-encoding", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user", "upgrade-insecure-requests"]);

/** Headers that carry a credential; left out of the command unless the person asks for them. */
const CREDENTIAL_HEADERS = new Set(["cookie", "set-cookie", "authorization", "proxy-authorization"]);

/**
 * Whether a header, query, form or JSON key names a secret. Mirrors
 * `is_sensitive_key` in `src-tauri/src/har.rs`; the two must change together.
 */
export function isSensitiveKey(name: string): boolean {
  const key = name.toLowerCase();
  if (["code", "sig", "key", "otp"].includes(key)) return true;
  if (["token", "secret", "password", "passwd", "pwd", "apikey", "api_key", "api-key", "session", "signature", "credential", "csrf", "xsrf"].some((word) => key.includes(word))) return true;
  // "author" and "authored" are not secrets, but "authorization" is.
  return key.includes("auth") && (!key.includes("author") || key.includes("authoriz"));
}

/**
 * A cURL command that repeats the request: method, the headers the page
 * chose (not the ones the browser adds), and the body when there was one.
 * One header per line so it reads the way a person would type it. Cookies,
 * auth and other secret-named headers are left out unless `credentials` is set.
 */
export function toCurl(detail: Pick<RequestDetail, "method" | "url" | "request_headers" | "request_body">, options: { credentials?: boolean } = {}): string {
  const lines = [`curl ${shellQuote(detail.url)}`];
  // The method comes from the page, so it is quoted unless it is a plain token.
  const method = /^[A-Z]+$/.test(detail.method) ? detail.method : shellQuote(detail.method);
  if (detail.method !== "GET") lines.push(`-X ${method}`);
  for (const [name, value] of Object.entries(detail.request_headers)) {
    const lower = name.toLowerCase();
    if (BROWSER_ONLY.has(lower)) continue;
    if (options.credentials !== true && (CREDENTIAL_HEADERS.has(lower) || isSensitiveKey(name))) continue;
    lines.push(`-H ${shellQuote(`${name}: ${value}`)}`);
  }
  if (detail.request_body) lines.push(`--data-raw ${shellQuote(detail.request_body)}`);
  return lines.join(" \\\n  ");
}

/** JSON laid out with two-space indents, or the text unchanged when it is not JSON. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
