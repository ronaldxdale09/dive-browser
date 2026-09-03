// A short, stable-ish CSS selector for an element.
//
// Used as a fallback identifier when an element has no role or accessible
// name to address it by. Prefers ids and test ids, then a bounded
// `:nth-of-type` path, so the result stays readable instead of becoming a
// forty-step chain of divs.

// `CSS.escape` is standard but not present in every embedding, and a picker
// that throws is worse than one that emits a slightly uglier selector.
const escapeIdent = (value) => {
  if (typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function") return CSS.escape(value);
  return String(value).replace(/[^\w-]/g, (c) => "\\" + c);
};

const cssPathOf = (el) => {
  if (!el || el.nodeType !== 1) return "";
  if (el.id) return "#" + escapeIdent(el.id);
  for (const attribute of ["data-testid", "data-test-id", "name"]) {
    const value = el.getAttribute(attribute);
    if (value) {
      return el.tagName.toLowerCase() + "[" + attribute + "=" + JSON.stringify(value) + "]";
    }
  }
  const parts = [];
  for (let node = el; node && node.nodeType === 1 && parts.length < 8; node = node.parentElement) {
    if (node.id) {
      parts.unshift("#" + escapeIdent(node.id));
      break;
    }
    const parent = node.parentElement;
    const tag = node.tagName.toLowerCase();
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const twins = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
    parts.unshift(twins.length > 1 ? tag + ":nth-of-type(" + (twins.indexOf(node) + 1) + ")" : tag);
  }
  return parts.join(" > ");
};
