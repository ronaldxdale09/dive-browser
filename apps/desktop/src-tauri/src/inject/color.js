// The colours a page actually uses.
//
// ColorZilla and its kin read colours out of the DOM, which means they can
// tell you about a `background-color` but not about a pixel inside a canvas,
// a video frame or an image. Picking a pixel is the system eyedropper's job
// (see `eyedropper.rs`); this script answers the other half of the question —
// which colours the page leans on, and for what.
//
// The palette is gathered from computed styles rather than the stylesheet, so
// a custom property that resolves at runtime is reported as the colour it
// actually paints, and each colour carries how often it is used and what for.
//
// `return` carries the answer out.

const MAX_ELEMENTS = 4000;

/** `rgb()`/`rgba()` as 8-bit channels, or null when it paints nothing. */
const parse = (value) => {
  if (typeof value !== "string") return null;
  const m = /^rgba?\(([^)]+)\)$/.exec(value.trim());
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  const [r, g, b] = parts;
  const a = parts.length > 3 ? parts[3] : 1;
  if ([r, g, b].some((n) => !Number.isFinite(n))) return null;
  // Fully transparent is the absence of a colour, not a colour.
  if (a === 0) return null;
  return { r, g, b, a: Number.isFinite(a) ? a : 1 };
};

const hex = ({ r, g, b }) => "#" + [r, g, b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");

// --- palette ---------------------------------------------------------------

/** Where a colour was used, so the panel can group by role. */
const roles = [
  ["color", "text"],
  ["background-color", "background"],
  ["border-top-color", "border"],
  ["border-bottom-color", "border"],
  ["border-left-color", "border"],
  ["border-right-color", "border"],
  ["outline-color", "border"],
];

const tally = new Map();

const note = (colour, role, sample) => {
  if (!colour) return;
  const key = hex(colour) + (colour.a < 1 ? `@${colour.a}` : "");
  const entry = tally.get(key) ?? { hex: hex(colour), alpha: colour.a, count: 0, roles: {}, sample: "" };
  entry.count += 1;
  entry.roles[role] = (entry.roles[role] ?? 0) + 1;
  if (!entry.sample && sample) entry.sample = sample;
  tally.set(key, entry);
};

const describe = (el) => {
  const tag = el.tagName ? el.tagName.toLowerCase() : "";
  const id = el.id ? `#${el.id}` : "";
  const cls = typeof el.className === "string" && el.className.trim()
    ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
    : "";
  return (tag + id + cls).slice(0, 60);
};

const elements = Array.from(document.querySelectorAll("*")).slice(0, MAX_ELEMENTS);
for (const el of elements) {
  let style;
  try {
    style = getComputedStyle(el);
  } catch {
    continue;
  }
  if (!style || style.display === "none" || style.visibility === "hidden") continue;
  const where = describe(el);
  for (const [property, role] of roles) {
    // A border colour on an element with no border paints nothing.
    if (role === "border") {
      const side = property.replace("-color", "-width").replace("outline-width", "outline-width");
      const width = parseFloat(style.getPropertyValue(side));
      if (!Number.isFinite(width) || width === 0) continue;
    }
    note(parse(style.getPropertyValue(property)), role, where);
  }
}

// The most-used colours first: that is the page's palette, and a colour used
// once is usually an accident rather than a decision.
const colors = Array.from(tally.values())
  .sort((a, b) => b.count - a.count)
  .slice(0, 48)
  .map((entry) => ({
    hex: entry.hex,
    alpha: entry.alpha,
    count: entry.count,
    role: Object.entries(entry.roles).sort((a, b) => b[1] - a[1])[0][0],
    sample: entry.sample,
  }));

// The page's own declared theme colour, when it has one.
const themeColor = document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? "";

// Field names match `Palette` in color.rs exactly: the host deserializes
// this straight into it, so a rename on either side has to be a rename on
// both. injectedColor.test.ts asserts the shape for that reason.
return { colors, theme_color: themeColor.slice(0, 32), scanned: elements.length };
