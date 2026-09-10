/**
 * The stack probe, exercised against a DOM.
 *
 * The probe's whole reason to exist is the version a URL cannot give you, so
 * the cases worth pinning are: a library that publishes its version is read
 * exactly, a production build with no global is still recognised, and a
 * hostile or half-loaded page cannot make the probe throw.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildInjected } from "./injected";

interface Hit { name: string; version: string | null; evidence: string }
interface Probe { technologies: Hit[]; generator: string; server_rendered: boolean }

function probe(): Probe {
  return eval(buildInjected("stack.js", {})) as Probe;
}
const names = (p: Probe) => p.technologies.map((t) => t.name);
const find = (p: Probe, name: string) => p.technologies.find((t) => t.name === name);

const added: string[] = [];
function global(key: string, value: unknown) {
  (window as unknown as Record<string, unknown>)[key] = value;
  added.push(key);
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-server-rendered");
});
afterEach(() => {
  for (const key of added.splice(0)) delete (window as unknown as Record<string, unknown>)[key];
});

describe("stack probe", () => {
  it("returns the exact field names the host deserializes into", () => {
    global("React", { version: "18.3.1" });
    const p = probe();
    // The host parses this into `PageProbe`/`ProbeHit` in stack.rs; a rename
    // on either side would silently drop every detection.
    expect(Object.keys(p).sort()).toEqual(["generator", "server_rendered", "technologies"]);
    expect(Object.keys(p.technologies[0]!).sort()).toEqual(["evidence", "name", "version"]);
  });

  it("reads a library's own version, which a URL cannot give", () => {
    global("React", { version: "18.3.1" });
    global("jQuery", { fn: { jquery: "3.7.1" } });
    const p = probe();
    expect(find(p, "React")).toMatchObject({ version: "18.3.1", evidence: "window.React.version" });
    expect(find(p, "jQuery")?.version).toBe("3.7.1");
  });

  it("recognises a production React build that exposes no global", () => {
    document.body.innerHTML = '<div id="__next"></div>';
    const host = document.querySelector("#__next") as unknown as Record<string, unknown>;
    // React tags the elements it owns with a randomly suffixed fibre key.
    host.__reactFiber$abc123 = {};
    const p = probe();
    expect(find(p, "React")).toMatchObject({ version: null });
    expect(find(p, "React")?.evidence).toMatch(/fibre/);
  });

  it("reports how a Next.js page was rendered, not just that it is Next.js", () => {
    global("__NEXT_DATA__", { gssp: true });
    const p = probe();
    expect(names(p)).toContain("Next.js");
    expect(names(p)).toContain("Next.js SSR");
    expect(names(p)).not.toContain("Next.js SSG");
    expect(p.server_rendered).toBe(true);
  });

  it("tells a static Next.js build from a server-rendered one", () => {
    global("__NEXT_DATA__", { gsp: true });
    const p = probe();
    expect(names(p)).toContain("Next.js SSG");
    expect(names(p)).not.toContain("Next.js SSR");
  });

  it("survives a global whose getter throws", () => {
    Object.defineProperty(window, "Vue", {
      configurable: true,
      get() { throw new Error("hostile"); },
    });
    added.push("Vue");
    expect(() => probe()).not.toThrow();
  });

  it("refuses a version that is not one, rather than reporting rubbish", () => {
    // A framework may put an object, or an injected string, where a version goes.
    global("Alpine", { version: { major: 3 } });
    global("htmx", { version: "<script>alert(1)</script>" });
    expect(find(probe(), "Alpine.js")?.version).toBeNull();
    expect(find(probe(), "htmx")?.version).toBeNull();
  });

  it("reads the generator meta tag and caps its length", () => {
    document.head.innerHTML = `<meta name="generator" content="${"x".repeat(200)}">`;
    expect(probe().generator).toHaveLength(120);
  });

  it("finds nothing on a bare page instead of guessing", () => {
    const p = probe();
    expect(p.technologies).toEqual([]);
    expect(p.generator).toBe("");
    expect(p.server_rendered).toBe(false);
  });

  it("spots frameworks by their DOM markers when no global is exposed", () => {
    document.body.innerHTML = '<astro-island></astro-island><div data-v-app></div>';
    const p = probe();
    expect(names(p)).toContain("Astro");
    expect(names(p)).toContain("Vue");
  });
});
