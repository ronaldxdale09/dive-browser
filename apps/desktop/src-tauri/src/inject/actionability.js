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
  return rect.width > 0 && rect.height > 0;
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
