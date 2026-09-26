/**
 * The address the bar shows at rest: host and path for web pages, the bare
 * scheme and page for Dive's own pages ("dive://screen" says what it is).
 *
 * It is written the way a person reads it, as every browser does: an
 * internationalised host in its own letters rather than "xn--" punycode, and
 * a path's percent-escapes decoded. Two things stay encoded because decoding
 * them would change what the address says: a host whose letters mix scripts
 * (a Cyrillic "а" inside a Latin name is how a lookalike of a real site is
 * spelled), and escapes that stand for spaces, separators, invisible or
 * direction-changing characters.
 */
export function prettyUrl(url: string): string {
  if (url.startsWith("dive://")) return url.split("?")[0] ?? url;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return url;
    const path = u.pathname === "/" && !u.search ? "" : readablePath(u.pathname + u.search);
    return readableHost(u) + path;
  } catch {
    return url;
  }
}

/**
 * The resting address in two parts, so the bar can set the host in ink and
 * the path in a quieter tone: the site is what a glance should read.
 */
export function splitAddress(url: string): { host: string; rest: string } {
  const shown = prettyUrl(url);
  if (url.startsWith("dive://")) return { host: shown, rest: "" };
  try {
    const u = new URL(url);
    const host = readableHost(u);
    if ((u.protocol === "http:" || u.protocol === "https:") && shown.startsWith(host)) return { host, rest: shown.slice(host.length) };
  } catch {
    // Not a URL: shown whole.
  }
  return { host: shown, rest: "" };
}

/** `host[:port]` with punycode labels in their own letters, unless that would hide a lookalike. */
function readableHost(u: URL): string {
  const port = u.port ? `:${u.port}` : "";
  if (!u.hostname.includes("xn--")) return u.host;
  const labels = u.hostname.split(".").map((label) => (label.startsWith("xn--") ? decodePunycode(label.slice(4)) : label));
  if (labels.some((label) => label === null || mixesScripts(label))) return u.host;
  const decoded = labels.join(".");
  // The decoded name has to be the same host again; anything else is not
  // this address and is not shown for it.
  try {
    if (new URL(`http://${decoded}`).hostname !== u.hostname) return u.host;
  } catch {
    return u.host;
  }
  return decoded + port;
}

/** Characters whose escapes stay: separators, "%", spaces, controls, and invisible or bidi characters. */
const KEEP_ESCAPED = /[;/?:@&=+$,#%\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}]/u;

/** A path and query with its percent-escapes decoded wherever that changes nothing but the look. */
function readablePath(path: string): string {
  return path.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    let text: string;
    try {
      text = decodeURIComponent(run);
    } catch {
      // Not UTF-8: whatever it is, it is not text to show.
      return run;
    }
    return Array.from(text, (char) => (KEEP_ESCAPED.test(char) ? encodeURIComponent(char) : char)).join("");
  });
}

/**
 * Scripts that may share one label: Japanese writes Han with both kanas,
 * Chinese with Bopomofo, Korean with Hangul, and each alongside Latin.
 * Anything else that mixes scripts is shown as punycode.
 */
const SCRIPT_SETS = [
  ["Latin", "Han", "Hiragana", "Katakana"],
  ["Latin", "Han", "Bopomofo"],
  ["Latin", "Han", "Hangul"],
];

const SCRIPTS = ["Latin", "Cyrillic", "Greek", "Armenian", "Georgian", "Hebrew", "Arabic", "Devanagari", "Bengali", "Tamil", "Thai", "Han", "Hiragana", "Katakana", "Hangul", "Bopomofo"].map(
  (name) => [name, new RegExp(`\\p{Script=${name}}`, "u")] as const,
);
const SHARED = /[\p{Script=Common}\p{Script=Inherited}]/u;

function mixesScripts(label: string): boolean {
  const seen = new Set<string>();
  for (const char of label) {
    if (SHARED.test(char)) continue;
    seen.add(SCRIPTS.find(([, test]) => test.test(char))?.[0] ?? "Other");
  }
  return seen.size > 1 && !SCRIPT_SETS.some((set) => [...seen].every((script) => set.includes(script)));
}

/** RFC 3492 decoding of one label's punycode (without its "xn--"), or null when it is not valid. */
function decodePunycode(input: string): string | null {
  const base = 36;
  const tMin = 1;
  const tMax = 26;
  const digit = (code: number) => (code >= 48 && code <= 57 ? code - 22 : code >= 65 && code <= 90 ? code - 65 : code >= 97 && code <= 122 ? code - 97 : base);
  const adapt = (delta: number, points: number, first: boolean) => {
    let d = first ? Math.floor(delta / 700) : delta >> 1;
    d += Math.floor(d / points);
    let k = 0;
    for (; d > ((base - tMin) * tMax) >> 1; k += base) d = Math.floor(d / (base - tMin));
    return Math.floor(k + ((base - tMin + 1) * d) / (d + 38));
  };
  const basic = Math.max(input.lastIndexOf("-"), 0);
  const output: number[] = [];
  for (let j = 0; j < basic; j++) {
    const code = input.charCodeAt(j);
    if (code >= 0x80) return null;
    output.push(code);
  }
  let n = 128;
  let bias = 72;
  let i = 0;
  for (let index = basic > 0 ? basic + 1 : 0; index < input.length; ) {
    const old = i;
    for (let w = 1, k = base; ; k += base) {
      if (index >= input.length) return null;
      const value = digit(input.charCodeAt(index++));
      if (value >= base) return null;
      i += value * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (value < t) break;
      w *= base - t;
      if (i > 0x10ffff * (output.length + 1)) return null;
    }
    const points = output.length + 1;
    bias = adapt(i - old, points, old === 0);
    n += Math.floor(i / points);
    i %= points;
    if (n > 0x10ffff) return null;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}
