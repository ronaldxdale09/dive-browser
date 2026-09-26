import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe("chrome type follows the Interface size", () => {
  const files = sources(src).map((path) => ({ path, text: readFileSync(path, "utf8") }));

  it("sizes no text in px, which the Interface size could not enlarge", () => {
    const offenders = files.filter((f) => /\btext-\[\d+(?:\.\d+)?px\]/.test(f.text)).map((f) => f.path.slice(src.length + 1));
    expect(offenders).toEqual([]);
  });

  it("defines every text size the chrome uses, in rem", () => {
    const css = readFileSync(join(src, "styles.css"), "utf8");
    const used = new Set(files.flatMap((f) => [...f.text.matchAll(/\btext-(\d+(?:\.\d+)?)\b/g)].map((m) => m[1]!)));
    for (const size of used) {
      const token = new RegExp(`--text-${size.replace(".", "\\\\\\.")}: ([\\d.]+)rem;`);
      const match = css.match(token);
      expect(match, `--text-${size}`).not.toBeNull();
      // Named for its size at 100%: the rem value is that many px over 16.
      expect(Number(match![1]) * 16).toBeCloseTo(Number(size), 5);
    }
  });
});
