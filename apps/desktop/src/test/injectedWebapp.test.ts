/**
 * The web-app manifest probe, exercised against a DOM with a stubbed fetch.
 *
 * These are Chrome's installability rules, so the cases are the ones where a
 * near-miss manifest must be refused and a good one must resolve every URL
 * against the manifest rather than the page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildInjected } from "./injected";

interface Probe {
  installable: boolean;
  reason?: string;
  id?: string;
  name?: string;
  short_name?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  icon_url?: string;
  icon_size?: number;
  theme_color?: string | null;
}

const manifests = new Map<string, unknown>();

async function probe(html: string, minIcon = 192): Promise<Probe> {
  document.head.innerHTML = html;
  return (await eval(buildInjected("webapp.js", { __MIN_ICON__: String(minIcon) }))) as Probe;
}

const good = {
  name: "Example App",
  short_name: "Example",
  start_url: "/app/",
  scope: "/app/",
  display: "standalone",
  theme_color: "#123456",
  icons: [
    { src: "small.png", sizes: "96x96", type: "image/png" },
    { src: "big.png", sizes: "192x192 512x512", type: "image/png" },
  ],
};

describe("web app probe", () => {
  beforeEach(() => {
    manifests.clear();
    // jsdom's location is http://localhost:3000/, which counts as local.
    vi.stubGlobal("fetch", async (input: string) => {
      const url = String(input);
      if (!manifests.has(url)) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => manifests.get(url) };
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("refuses a page with no manifest link", async () => {
    expect(await probe("")).toMatchObject({ installable: false, reason: "no manifest" });
  });

  it("resolves start, scope and icon against the manifest's own URL", async () => {
    manifests.set("http://localhost:3000/static/m.json", good);
    const result = await probe('<link rel="manifest" href="/static/m.json">');
    expect(result).toMatchObject({
      installable: true,
      name: "Example App",
      short_name: "Example",
      start_url: "http://localhost:3000/app/",
      scope: "http://localhost:3000/app/",
      display: "standalone",
      theme_color: "#123456",
      icon_url: "http://localhost:3000/static/big.png",
      icon_size: 512,
    });
    // No manifest id: the start URL stands in, the way Chrome does it.
    expect(result.id).toBe("http://localhost:3000/app/");
  });

  it("requires a name, a non-browser display, and a large enough icon", async () => {
    manifests.set("http://localhost:3000/m.json", { ...good, name: "", short_name: "" });
    expect((await probe('<link rel="manifest" href="/m.json">')).reason).toBe("no name");
    manifests.set("http://localhost:3000/m.json", { ...good, display: "browser" });
    expect((await probe('<link rel="manifest" href="/m.json">')).reason).toBe("display is browser");
    manifests.set("http://localhost:3000/m.json", { ...good, icons: [{ src: "i.png", sizes: "96x96" }] });
    expect((await probe('<link rel="manifest" href="/m.json">')).reason).toMatch(/no icon/);
  });

  it("refuses a start URL outside its scope or on another origin", async () => {
    manifests.set("http://localhost:3000/m.json", { ...good, start_url: "/elsewhere/" });
    expect((await probe('<link rel="manifest" href="/m.json">')).reason).toBe("start_url outside scope");
    manifests.set("http://localhost:3000/m.json", { ...good, start_url: "https://other.example/app/" });
    expect((await probe('<link rel="manifest" href="/m.json">')).reason).toBe("start_url on another origin");
  });

  it("treats an SVG icon as large enough and prefers 'any' over 'maskable' at equal size", async () => {
    manifests.set("http://localhost:3000/m.json", {
      ...good,
      icons: [
        { src: "mask.png", sizes: "512x512", purpose: "maskable" },
        { src: "any.png", sizes: "512x512", purpose: "any" },
        { src: "logo.svg", sizes: "any", type: "image/svg+xml" },
      ],
    });
    const result = await probe('<link rel="manifest" href="/m.json">');
    // The SVG scores as 1024 and wins; among the 512s, "any" would beat "maskable".
    expect(result.icon_url).toBe("http://localhost:3000/logo.svg");
  });

  it("reports an unreadable manifest instead of throwing into the caller", async () => {
    const result = await probe('<link rel="manifest" href="/missing.json">');
    expect(result).toMatchObject({ installable: false, reason: "manifest 404" });
  });

  it("honours a manifest id and defaults scope to the start URL's directory", async () => {
    manifests.set("http://localhost:3000/m.json", { ...good, id: "/my-app", scope: undefined, start_url: "/app/index.html" });
    const result = await probe('<link rel="manifest" href="/m.json">');
    expect(result.id).toBe("http://localhost:3000/my-app");
    expect(result.scope).toBe("http://localhost:3000/app/");
  });
});
