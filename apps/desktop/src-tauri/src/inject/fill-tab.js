// Fill the tab with a video without leaving the window: hover a video for a
// small "Fill tab" control; one click makes its player cover the tab's
// content area, Escape or the control brings the page back. The player
// container (YouTube's #movie_player and the like) is preferred over the bare
// <video> so the site's own controls keep working while it is filled.
if (window.__diveFillTab) return;

const TARGET = "dive-fill-target";
const CHAIN = "dive-fill-chain";
const FILLING = "dive-filling";
const Z = 2147483645;

const style = document.createElement("style");
style.setAttribute("data-dive", "fill-tab");
style.textContent = `
html.${FILLING}, html.${FILLING} body { overflow: hidden !important; }
.${TARGET} {
  position: fixed !important; inset: 0 !important;
  width: 100vw !important; height: 100vh !important;
  max-width: none !important; max-height: none !important;
  margin: 0 !important; padding: 0 !important;
  z-index: ${Z} !important; background: #000 !important;
  transform: none !important; border-radius: 0 !important;
}
.${TARGET} .${CHAIN} {
  position: absolute !important; inset: 0 !important;
  width: 100% !important; height: 100% !important;
  max-width: none !important; max-height: none !important;
  margin: 0 !important; padding: 0 !important; transform: none !important;
}
.${TARGET} video {
  position: absolute !important; left: 0 !important; top: 0 !important;
  width: 100% !important; height: 100% !important;
  max-width: none !important; max-height: none !important;
  object-fit: contain !important;
}`;

// The control lives in a shadow root so page CSS cannot restyle it.
const host = document.createElement("div");
host.setAttribute("data-dive", "fill-tab-control");
host.style.cssText = `position:fixed;left:0;top:0;z-index:${Z + 2};pointer-events:none;`;
const shadow = host.attachShadow({ mode: "closed" });
// Built with DOM calls, never HTML strings: sites that enforce Trusted
// Types (YouTube among them) reject innerHTML from any script.
const controlStyle = document.createElement("style");
controlStyle.textContent = `
  :host { all: initial; }
  button {
    all: initial; pointer-events: auto; cursor: pointer; position: fixed;
    display: inline-flex; align-items: center; gap: 6px;
    height: 28px; padding: 0 10px 0 8px; border-radius: 999px;
    font: 500 12px/1 -apple-system, "Segoe UI", system-ui, sans-serif;
    color: #ececec; background: rgba(17, 17, 17, 0.86);
    border: 1px solid rgba(236, 236, 236, 0.18);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
    opacity: 0; transform: translateY(-4px);
    transition: opacity 140ms ease, transform 140ms ease;
  }
  button.show { opacity: 1; transform: none; }
  button:hover { background: rgba(38, 38, 38, 0.92); border-color: rgba(236, 236, 236, 0.32); }
  button:focus-visible { outline: 2px solid #7fd8c8; outline-offset: 2px; }
  svg { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  @media (prefers-reduced-motion: reduce) { button { transition: none; } }`;
const button = document.createElement("button");
button.type = "button";
const label = document.createElement("span");
const SVG = "http://www.w3.org/2000/svg";
function icon(paths) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  for (const d of paths) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}
const ICON_FILL = ["M15 3h6v6", "M9 21H3v-6", "m21 3-7 7", "m3 21 7-7"];
const ICON_EXIT = ["M4 14h6v6", "M20 10h-6V4", "m14 10 7-7", "m3 21 7-7"];
shadow.appendChild(controlStyle);
shadow.appendChild(button);

let hovered = null;
let target = null;
let filledVideo = null;
let chain = [];
let hideTimer = 0;
let mounted = false;

// Registered for new documents, this runs before the DOM exists, so nothing
// touches the tree until a video is actually hovered or toggled.
function mount() {
  if (mounted) return;
  const root = document.body || document.documentElement;
  if (!root) return;
  (document.head || root).appendChild(style);
  root.appendChild(host);
  mounted = true;
}

function playerFor(video) {
  // Walk up a few levels: the first ancestor that wraps the video tightly
  // and carries controls is the player; otherwise the video itself.
  const v = video.getBoundingClientRect();
  const area = Math.max(1, v.width * v.height);
  let node = video.parentElement;
  for (let depth = 0; node && depth < 6; depth++) {
    const r = node.getBoundingClientRect();
    const ratio = (r.width * r.height) / area;
    const controls = node.querySelector("button, [role=slider], [class*=control], [class*=Control]");
    if (ratio >= 0.9 && ratio <= 1.6 && controls) return node;
    if (ratio > 1.6) break;
    node = node.parentElement;
  }
  return video;
}

function place(video) {
  const r = video.getBoundingClientRect();
  if (r.width < 120 || r.height < 60) return false;
  const x = Math.min(window.innerWidth - 12, r.right - 12);
  const y = Math.max(8, r.top + 12);
  button.style.left = "auto";
  button.style.right = `${Math.max(8, window.innerWidth - x)}px`;
  button.style.top = `${y}px`;
  return true;
}

function show(video) {
  mount();
  const filling = Boolean(target);
  while (button.firstChild) button.removeChild(button.firstChild);
  button.appendChild(icon(filling ? ICON_EXIT : ICON_FILL));
  label.textContent = filling ? "Exit" : "Fill tab";
  button.appendChild(label);
  button.setAttribute("aria-label", filling ? "Exit filled video (Escape)" : "Fill the tab with this video");
  button.title = button.getAttribute("aria-label");
  if (filling) {
    button.style.left = "auto";
    button.style.right = "16px";
    button.style.top = "16px";
  } else if (!place(video)) {
    return;
  }
  button.classList.add("show");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hide, filling ? 2200 : 1600);
}

function hide() {
  clearTimeout(hideTimer);
  button.classList.remove("show");
}

function enter(video) {
  const node = playerFor(video);
  target = node;
  filledVideo = video;
  node.classList.add(TARGET);
  // Every wrapper between the player and the video is stretched too, or a
  // zero-height container (YouTube's video container) hides the picture.
  chain = [];
  for (let el = video.parentElement; el && el !== node; el = el.parentElement) {
    el.classList.add(CHAIN);
    chain.push(el);
  }
  document.documentElement.classList.add(FILLING);
  window.dispatchEvent(new Event("resize"));
  try { video.focus({ preventScroll: true }); } catch (_) { /* not focusable */ }
  show(video);
}

function exit() {
  if (!target) return;
  target.classList.remove(TARGET);
  for (const el of chain) el.classList.remove(CHAIN);
  chain = [];
  document.documentElement.classList.remove(FILLING);
  target = null;
  filledVideo = null;
  hide();
  window.dispatchEvent(new Event("resize"));
}

function toggle(video) {
  if (target) {
    exit();
    return "exited";
  }
  const pick = video || hovered || largestVideo();
  if (!pick) return "no-video";
  enter(pick);
  return "filled";
}

function largestVideo() {
  let best = null;
  let bestArea = 0;
  for (const v of document.querySelectorAll("video")) {
    const r = v.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) { best = v; bestArea = area; }
  }
  return best;
}

button.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  toggle(hovered);
});
button.addEventListener("mouseenter", () => clearTimeout(hideTimer));
button.addEventListener("mouseleave", () => { hideTimer = setTimeout(hide, 900); });

document.addEventListener("mouseover", (e) => {
  const video = e.target instanceof Element ? e.target.closest("video") : null;
  if (target) {
    if (video) hovered = video;
    return;
  }
  if (!video) return;
  hovered = video;
  show(video);
}, true);

document.addEventListener("mousemove", (e) => {
  if (!target) return;
  // While filled, a nudge near the top edge brings the exit control back.
  if (e.clientY < 80) show(filledVideo);
}, true);

document.addEventListener("mouseout", (e) => {
  if (target) return;
  const video = e.target instanceof Element ? e.target.closest("video") : null;
  if (video && video === hovered) {
    hideTimer = setTimeout(hide, 900);
  }
}, true);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && target) {
    e.preventDefault();
    e.stopPropagation();
    exit();
  }
}, true);

// The page's own fullscreen wins; ours gets out of its way.
document.addEventListener("fullscreenchange", () => { if (document.fullscreenElement && target) exit(); });

// If the filled player leaves the document (navigation within a single-page
// app), fall back to normal layout rather than leaving the body locked.
setInterval(() => { if (target && !target.isConnected) exit(); }, 1000);

window.__diveFillTab = Object.freeze({
  toggle: () => toggle(null),
  exit,
  filling: () => Boolean(target),
});
