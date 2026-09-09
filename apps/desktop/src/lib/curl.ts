import type { RequestDetail } from "./ipc";

/** Quote for a POSIX shell: single quotes, with any inner quote spliced in. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Headers the browser adds on its own; a cURL reproduction is cleaner without them. */
const BROWSER_ONLY = new Set(["content-length", "host", "connection", "accept-encoding", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user", "upgrade-insecure-requests"]);

/**
 * A cURL command that repeats the request: method, the headers the page
 * chose (not the ones the browser adds), and the body when there was one.
 * One header per line so it reads the way a person would type it.
 */
export function toCurl(detail: Pick<RequestDetail, "method" | "url" | "request_headers" | "request_body">): string {
  const lines = [`curl ${shellQuote(detail.url)}`];
  if (detail.method !== "GET") lines.push(`-X ${detail.method}`);
  for (const [name, value] of Object.entries(detail.request_headers)) {
    if (BROWSER_ONLY.has(name.toLowerCase())) continue;
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
