/**
 * The palette probe, exercised against a DOM.
 *
 * It reads computed styles rather than the stylesheet, so what matters is
 * that it counts real paint: a transparent colour is not a colour, a border
 * colour with no border width paints nothing, and the ranking reflects use.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { buildInjected } from "./injected";

interface Entry { hex: string; alpha: number; count: number; role: string; sample: string }
interface Result { colors: Entry[]; theme_color: string; scanned: number }

function palette(html: string): Result {
  document.body.innerHTML = html;
  return eval(buildInjected("color.js", { __MODE__: '"palette"' })) as Result;
}
const hexes = (r: Result) => r.colors.map((c) => c.hex);

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("palette probe", () => {
  it("returns the exact field names the host deserializes into", () => {
    // The host parses this straight into `Palette` in color.rs, so a rename
    // on either side breaks the panel with "missing field". Naming the
    // contract here is what catches that without a running browser.
    const r = palette('<p style="color: rgb(1, 2, 3)">hi</p>');
    expect(Object.keys(r).sort()).toEqual(["colors", "scanned", "theme_color"]);
    expect(Object.keys(r.colors[0]!).sort()).toEqual(["alpha", "count", "hex", "role", "sample"]);
  });

  it("reports the colour a page paints, with its role", () => {
    const r = palette('<p style="color: rgb(255, 0, 0)">hi</p>');
    const red = r.colors.find((c) => c.hex === "#ff0000");
    expect(red).toBeTruthy();
    expect(red?.role).toBe("text");
    expect(r.scanned).toBeGreaterThan(0);
  });

  it("treats a fully transparent colour as no colour at all", () => {
    const r = palette('<p style="color: rgba(255, 0, 0, 0)">hi</p>');
    expect(hexes(r)).not.toContain("#ff0000");
  });

  it("ignores a border colour on an element with no border", () => {
    // The computed border-color is set, but nothing is painted.
    const r = palette('<div style="border-color: rgb(0, 0, 255); border-width: 0"></div>');
    expect(hexes(r)).not.toContain("#0000ff");
  });

  it("counts a border that is actually drawn", () => {
    const r = palette('<div style="border: 2px solid rgb(0, 0, 255)"></div>');
    const blue = r.colors.find((c) => c.hex === "#0000ff");
    expect(blue?.role).toBe("border");
  });

  it("ranks the most-used colour first, which is the page's real palette", () => {
    const many = Array.from({ length: 5 }, () => '<p style="color: rgb(0, 128, 0)">x</p>').join("");
    const r = palette(`${many}<p style="color: rgb(128, 0, 128)">y</p>`);
    expect(r.colors[0]?.hex).toBe("#008000");
    expect(r.colors[0]?.count).toBeGreaterThanOrEqual(5);
  });

  it("keeps a semi-transparent colour and records its alpha", () => {
    const r = palette('<p style="color: rgba(255, 0, 0, 0.5)">hi</p>');
    expect(r.colors.find((c) => c.hex === "#ff0000")?.alpha).toBe(0.5);
  });

  it("describes where a colour was used, so it can be found again", () => {
    const r = palette('<p id="lede" class="intro big" style="color: rgb(1, 2, 3)">hi</p>');
    expect(r.colors.find((c) => c.hex === "#010203")?.sample).toBe("p#lede.intro.big");
  });

  it("reads the declared theme colour", () => {
    document.head.innerHTML = '<meta name="theme-color" content="#101010">';
    expect(palette("<p>hi</p>").theme_color).toBe("#101010");
  });

  it("skips hidden elements, which paint nothing", () => {
    const r = palette('<p style="display: none; color: rgb(9, 9, 9)">hi</p>');
    expect(hexes(r)).not.toContain("#090909");
  });
});
