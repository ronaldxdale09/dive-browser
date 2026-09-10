// The checks a synthetic click has to pass before it is worth dispatching.
//
// Clicking an invisible or disabled element silently does nothing, which an
// agent reads as "the click worked but the app is broken". Failing the call
// instead keeps the mistake attributable to the locator.

const isVisible = (el) => {
  if (!el || el.nodeType !== 1 || !el.isConnected) return false;
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.visibility === "collapse") return false;
  if (style.display === "none" || style.opacity === "0") return false;
  if (el.closest("[hidden]")) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  // An element with a box of its own can still be clipped away to nothing by
  // an ancestor that hides its overflow -- a collapsed accordion, a carousel
  // panel off to the side, a drawer with height zero. Its own rectangle says
  // nothing about that, so the ancestors have to be asked. This matters for
  // clicking as much as for reading: a click on a clipped element is
  // dispatched, does nothing a person can see, and reads back as success.
  const CLIPS = new Set(["hidden", "clip", "scroll", "auto"]);
  for (let node = el.parentElement; node && node.nodeType === 1; node = node.parentElement) {
    const parent = getComputedStyle(node);
    // Only an ancestor that actually clips is asked about. Testing for the
    // default instead would treat a style the host does not report -- jsdom
    // leaves the `overflow` shorthand empty -- as a clip, and hide the whole
    // page from every locator.
    if (!CLIPS.has(parent.overflow) && !CLIPS.has(parent.overflowX) && !CLIPS.has(parent.overflowY)) continue;
    const clip = node.getBoundingClientRect();
    if (clip.width <= 0 || clip.height <= 0) return false;
    const overlapX = Math.min(rect.right, clip.right) - Math.max(rect.left, clip.left);
    const overlapY = Math.min(rect.bottom, clip.bottom) - Math.max(rect.top, clip.top);
    if (overlapX <= 0 || overlapY <= 0) return false;
  }
  return true;
};

const isEnabled = (el) => {
  if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return false;
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    if (node.disabled === true) return false;
  }
  return true;
};

const NON_TEXT_INPUTS = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

// `isContentEditable` is a live computed property, so it is the right answer
// when the host implements it; the attribute is the fallback.
const isContentEditable = (el) => {
  if (el.isContentEditable === true) return true;
  const attribute = el.getAttribute && el.getAttribute("contenteditable");
  return attribute === "" || attribute === "true" || attribute === "plaintext-only";
};

const isEditable = (el) => {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  const textControl = tag === "TEXTAREA"
    || (tag === "INPUT" && !NON_TEXT_INPUTS.has((el.type || "text").toLowerCase()));
  if (!textControl && !isContentEditable(el)) return false;
  return !el.disabled && !el.readOnly;
};
