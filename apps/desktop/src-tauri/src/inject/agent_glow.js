// The edge glow that says an agent is driving this page.
//
// It has to be drawn by the page rather than by the chrome. The chrome is a
// sibling native view raised above the page, and where it is allowed to paint
// it paints opaquely -- a translucent band over the page composites against
// the chrome's own background, not against the page, so a glow that fades
// into the content is not possible from out there. Inside the page it is an
// ordinary fixed element and the fade is real.
//
// `__ON__` turns it on or off. The element carries no text, no role and no
// pointer events, so page_text, page_markdown and the interactive-element
// listing never see it.

const ID = "__dive-agent-glow";
const existing = document.getElementById(ID);
if (!__ON__) {
  if (existing) existing.remove();
  return { glow: false };
}
if (existing) return { glow: true };
const host = document.createElement("div");
host.id = ID;
host.setAttribute("aria-hidden", "true");
host.setAttribute("data-dive-agent", "glow");
host.style.cssText = [
  "position:fixed",
  "inset:0",
  "pointer-events:none",
  // Above everything a page can reasonably stack, but below the picker.
  "z-index:2147483645",
  "contain:strict",
].join(";");
// A shadow root keeps the page's own stylesheets from reaching in and the
// keyframes from leaking out.
const root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
const style = document.createElement("style");
style.textContent = [
  "@keyframes dive-agent-breathe{0%,100%{opacity:.62}50%{opacity:1}}",
  ".ring{position:absolute;inset:0;border-radius:12px;",
  // Three shadows, tight to wide: a bright line at the very edge, a close
  // band, then a broad wash. One shadow alone reads as a border; the stack
  // is what falls off into the page and reads as light.
  "box-shadow:",
  "inset 0 0 0 2px rgba(127,216,200,.95),",
  "inset 0 0 18px 2px rgba(127,216,200,.75),",
  "inset 0 0 64px 16px rgba(127,216,200,.42);",
  "animation:dive-agent-breathe 2.4s ease-in-out infinite}",
  // A second, wider wash behind it. Kept separate so the breathing of the
  // ring does not take the whole tint with it, which flickers on a light
  // page; this one holds steady and gives the edge something to sit on.
  ".wash{position:absolute;inset:0;border-radius:12px;",
  "box-shadow:inset 0 0 120px 30px rgba(127,216,200,.22)}",
  "@media (prefers-reduced-motion:reduce){.ring{animation:none;opacity:.9}}",
].join("");
const wash = document.createElement("div");
wash.className = "wash";
const ring = document.createElement("div");
ring.className = "ring";
root.append(style, wash, ring);
document.documentElement.appendChild(host);
return { glow: true };
