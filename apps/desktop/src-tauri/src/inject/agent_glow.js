// What an agent is doing, drawn where it can actually be seen: in the page.
//
// The chrome is a sibling native view raised above the page, and where it is
// allowed to paint it paints opaquely -- a translucent band over the page
// composites against the chrome's own background, not the page. So neither
// the edge glow nor the cursor can come from out there. Inside the page they
// are ordinary fixed elements and both look right.
//
// Installs a controller rather than doing one thing, so the host can move the
// cursor with a small call per action instead of re-injecting a script. The
// element carries no text, no role and no pointer events, and lives in a
// shadow root, so page_text, page_markdown and the interactive-element
// listing never see it and the page's own CSS cannot reach it.
//
// `__ON__` turns the whole overlay on or off.

const ID = "__dive-agent-glow";

if (!__ON__) {
  const existing = document.getElementById(ID);
  if (existing) existing.remove();
  delete window.__diveAgentOverlay;
  return { overlay: false };
}

if (document.getElementById(ID) && window.__diveAgentOverlay) return { overlay: true };

const host = document.createElement("div");
host.id = ID;
host.setAttribute("aria-hidden", "true");
host.setAttribute("data-dive-agent", "overlay");
host.style.cssText = [
  "position:fixed",
  "inset:0",
  "pointer-events:none",
  // Above everything a page can reasonably stack, but below the picker.
  "z-index:2147483645",
].join(";");

const root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
const style = document.createElement("style");
style.textContent = [
  "@keyframes dive-agent-breathe{0%,100%{opacity:.62}50%{opacity:1}}",
  "@keyframes dive-agent-ripple{from{transform:translate(-50%,-50%) scale(.4);opacity:.85}to{transform:translate(-50%,-50%) scale(2.4);opacity:0}}",
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
  // The cursor. Transform-only movement, so it is composited rather than
  // laid out again on every frame of a drag.
  ".cursor{position:absolute;left:0;top:0;width:22px;height:22px;opacity:0;",
  "will-change:transform;transform:translate(-100px,-100px);",
  "transition:opacity 140ms ease}",
  ".cursor.on{opacity:1}",
  ".ripple{position:absolute;left:0;top:0;width:26px;height:26px;border-radius:50%;",
  "border:2px solid rgba(127,216,200,.95);opacity:0;pointer-events:none}",
  ".ripple.go{animation:dive-agent-ripple 420ms cubic-bezier(.2,.7,.3,1) 1}",
  ".label{position:absolute;left:0;top:0;max-width:280px;padding:3px 7px;border-radius:6px;",
  "background:rgba(17,24,28,.92);color:#d7f5ee;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;",
  "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0;",
  "transition:opacity 140ms ease;box-shadow:0 2px 8px rgba(0,0,0,.35)}",
  ".label.on{opacity:1}",
  "@media (prefers-reduced-motion:reduce){.ring{animation:none;opacity:.9}",
  ".cursor{transition:opacity 140ms ease}.ripple.go{animation-duration:1ms}}",
].join("");

const wash = document.createElement("div");
wash.className = "wash";
const ring = document.createElement("div");
ring.className = "ring";

const cursor = document.createElement("div");
cursor.className = "cursor";
// An arrow that is plainly not the person's own pointer: Dive's mint, with a
// dark outline so it reads on any page.
cursor.innerHTML =
  '<svg width="22" height="22" viewBox="0 0 22 22" fill="none">' +
  '<path d="M3.5 2.2 17 10.4l-5.7 1.2-2.6 5.4z" fill="#7fd8c8" stroke="#0d1b1a" stroke-width="1.4" stroke-linejoin="round"/>' +
  "</svg>";
const ripple = document.createElement("div");
ripple.className = "ripple";
const label = document.createElement("div");
label.className = "label";

root.append(style, wash, ring, cursor, ripple, label);
document.documentElement.appendChild(host);

const reduced =
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const state = { x: null, y: null, raf: 0, hide: 0 };

/** Put the cursor, its ripple and its label at a point without animating. */
const place = (x, y) => {
  state.x = x;
  state.y = y;
  cursor.style.transform = "translate(" + x + "px," + y + "px)";
  ripple.style.transform = "translate(" + x + "px," + y + "px)";
  // The label sits below and right, and flips when that would run it off the
  // edge -- a label that leaves the viewport says nothing.
  const flipX = x > window.innerWidth - 300;
  const flipY = y > window.innerHeight - 46;
  label.style.transform =
    "translate(" + (flipX ? x - 292 : x + 16) + "px," + (flipY ? y - 34 : y + 16) + "px)";
};

/**
 * Glide to a point, then settle.
 *
 * Movement is eased over a short, distance-scaled time rather than a fixed
 * one: a nudge across a form should not take as long as a jump across the
 * page, and a constant duration makes short moves feel sluggish and long ones
 * feel teleported. It is capped low, because this runs before every action an
 * agent takes and the watching is not the work.
 */
const glide = (x, y, done) => {
  cancelAnimationFrame(state.raf);
  if (state.x === null || reduced) {
    place(x, y);
    if (done) done();
    return;
  }
  const fromX = state.x;
  const fromY = state.y;
  const distance = Math.hypot(x - fromX, y - fromY);
  const duration = Math.min(260, Math.max(90, distance * 0.42));
  const started = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - started) / duration);
    // Ease out: quick away, gentle arrival, which is how a hand moves.
    const eased = 1 - Math.pow(1 - t, 3);
    place(fromX + (x - fromX) * eased, fromY + (y - fromY) * eased);
    if (t < 1) state.raf = requestAnimationFrame(step);
    else if (done) done();
  };
  state.raf = requestAnimationFrame(step);
};

window.__diveAgentOverlay = {
  /** Show the cursor at a point. `phase` is "move", "click" or "type". */
  cursor(x, y, phase, text) {
    clearTimeout(state.hide);
    cursor.classList.add("on");
    if (text) {
      label.textContent = String(text).slice(0, 120);
      label.classList.add("on");
    } else {
      label.classList.remove("on");
    }
    glide(x, y, () => {
      if (phase !== "click") return;
      // Restart the animation: removing and re-adding in one frame is
      // ignored, so the class comes off, layout is read, and it goes back on.
      ripple.classList.remove("go");
      void ripple.offsetWidth;
      ripple.classList.add("go");
    });
    // The cursor is about the action, not about the page, so it fades once
    // the run stops touching this tab.
    state.hide = setTimeout(() => {
      cursor.classList.remove("on");
      label.classList.remove("on");
    }, 2600);
  },
};

return { overlay: true };
