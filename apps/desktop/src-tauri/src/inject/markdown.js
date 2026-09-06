// The page as Markdown, for agents that need structure and not just words.
//
// `page_text` is `document.body.innerText`: cheaper, but it throws away every
// link target, heading level and cell boundary — exactly what an agent reads
// to decide where to go next. Markdown keeps those at roughly the same token
// cost, so a model can answer "which link do I click" without a screenshot.
//
// Adapted from Obscura's `LP.getMarkdown` (Apache-2.0,
// https://github.com/h4ckf0r0day/obscura). Changed here: link and image
// targets are resolved absolute so the agent can navigate them directly,
// nested lists indent, ordered lists count, tables get the header separator
// that makes them valid Markdown, hidden subtrees are skipped, and the result
// is capped the way `page_text` is.

const CAP = __MARKDOWN_CAP__;

// Elements with no textual content, plus the ones whose text is machinery
// rather than page content.
const SKIP = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE",
  "SVG", "CANVAS", "IFRAME", "OBJECT", "EMBED", "AUDIO", "VIDEO", "MAP",
]);

// Block-level containers that contribute a paragraph break but no marker of
// their own. Anything not listed here and not handled explicitly is treated
// as inline, which is the right default for spans and custom elements.
const BLOCK = new Set([
  "DIV", "SECTION", "ARTICLE", "MAIN", "ASIDE", "NAV", "HEADER", "FOOTER",
  "FORM", "FIELDSET", "FIGURE", "FIGCAPTION", "ADDRESS", "DETAILS", "DD", "DT",
]);

// `display: none` content is not on the page as far as a reader is concerned,
// and menus keep entire duplicate navigations in there. Deliberately does not
// use actionability.js's `isVisible`: that needs a layout rect, which is the
// expensive part and is meaningless for text.
const isHidden = (el) => {
  if (el.hidden === true) return true;
  if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return true;
  let style = null;
  try {
    style = getComputedStyle(el);
  } catch {
    return false;
  }
  return !!style && (style.display === "none" || style.visibility === "hidden");
};

// Absolute where the DOM will give it to us: `el.href` and `el.src` are
// already resolved against the base URI, the attribute is not.
const urlOf = (el, property, attribute) => {
  const resolved = el[property];
  if (typeof resolved === "string" && resolved) return resolved;
  const raw = el.getAttribute(attribute) || "";
  if (!raw) return "";
  try {
    return new URL(raw, document.baseURI).href;
  } catch {
    return raw;
  }
};

// Markdown's block syntax is line-anchored, so a `|` or a newline inside a
// cell would end the row early.
const cell = (value) => value.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();

const listPrefix = (li) => {
  const parent = li.parentNode;
  const ordered = parent && parent.tagName && parent.tagName.toUpperCase() === "OL";
  if (!ordered) return "- ";
  let index = 1;
  for (let sibling = li.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
    if (sibling.tagName.toUpperCase() === "LI") index += 1;
  }
  const start = Number(parent.getAttribute("start"));
  return (Number.isFinite(start) && start > 0 ? start + index - 1 : index) + ". ";
};

// A table is walked directly rather than through the generic recursion,
// because the header separator depends on which row came first.
const renderTable = (table) => {
  const rows = table.querySelectorAll ? table.querySelectorAll("tr") : [];
  const lines = [];
  let headerDone = false;
  for (const row of rows) {
    if (isHidden(row)) continue;
    const cells = [];
    let isHeader = false;
    for (const child of row.children || []) {
      const tag = child.tagName.toUpperCase();
      if (tag !== "TD" && tag !== "TH") continue;
      if (tag === "TH") isHeader = true;
      cells.push(cell(render(child)));
    }
    if (cells.length === 0) continue;
    lines.push("| " + cells.join(" | ") + " |");
    if (!headerDone && (isHeader || lines.length === 1)) {
      lines.push("| " + cells.map(() => "---").join(" | ") + " |");
      headerDone = true;
    }
  }
  return lines.length ? "\n" + lines.join("\n") + "\n\n" : "";
};

const children = (el) => {
  let out = "";
  for (const child of el.childNodes || []) out += render(child);
  return out;
};

function render(node) {
  if (!node) return "";
  if (node.nodeType === 3) return node.textContent || "";
  if (node.nodeType !== 1) return "";

  const tag = (node.tagName || "").toUpperCase();
  if (SKIP.has(tag)) return "";
  if (isHidden(node)) return "";

  switch (tag) {
    case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": {
      const text = children(node).replace(/\s+/g, " ").trim();
      return text ? "\n" + "#".repeat(Number(tag[1])) + " " + text + "\n\n" : "";
    }
    case "P": {
      const text = children(node).trim();
      return text ? "\n" + text + "\n\n" : "";
    }
    case "BR":
      return "\n";
    case "HR":
      return "\n---\n\n";
    case "STRONG": case "B": {
      const text = children(node).trim();
      return text ? "**" + text + "**" : "";
    }
    case "EM": case "I": {
      const text = children(node).trim();
      return text ? "*" + text + "*" : "";
    }
    case "DEL": case "S": {
      const text = children(node).trim();
      return text ? "~~" + text + "~~" : "";
    }
    case "CODE": {
      // A `code` inside a `pre` is the fence's content, not an inline span.
      if (node.parentNode && node.parentNode.tagName
        && node.parentNode.tagName.toUpperCase() === "PRE") {
        return children(node);
      }
      const text = children(node).replace(/\s+/g, " ").trim();
      return text ? "`" + text + "`" : "";
    }
    case "PRE": {
      const text = (node.textContent || "").replace(/\n+$/, "");
      return text ? "\n```\n" + text + "\n```\n\n" : "";
    }
    case "BLOCKQUOTE": {
      const text = children(node).trim();
      return text ? "\n> " + text.replace(/\n/g, "\n> ") + "\n\n" : "";
    }
    case "A": {
      const text = children(node).replace(/\s+/g, " ").trim();
      const href = urlOf(node, "href", "href");
      if (!text) return "";
      // A javascript: or empty target is not somewhere the agent can go, so
      // the link decoration would only cost tokens.
      if (!href || href.toLowerCase().startsWith("javascript:")) return text;
      return "[" + text + "](" + href + ")";
    }
    case "IMG": {
      const alt = (node.getAttribute("alt") || "").replace(/\s+/g, " ").trim();
      const src = urlOf(node, "src", "src");
      if (!src) return "";
      return "![" + alt + "](" + src + ")";
    }
    case "UL": case "OL":
      return "\n" + children(node) + "\n";
    case "LI": {
      const body = children(node)
        .replace(/\n{2,}/g, "\n")
        .trim();
      if (!body) return "";
      // Every continuation line has to clear the marker or it closes the
      // list. A nested list is just such a continuation, so indenting here is
      // also what makes nesting deepen by one level per ancestor item —
      // tracking a depth as well would count each level twice.
      return listPrefix(node) + body.replace(/\n/g, "\n  ") + "\n";
    }
    case "TABLE":
      return renderTable(node);
    case "THEAD": case "TBODY": case "TFOOT": case "TR": case "TH": case "TD":
      // Reached only when a cell is rendered directly by `renderTable`.
      return children(node);
    case "INPUT": {
      // Form state is page content to an agent: it needs to know the box is
      // already filled before it types into it.
      const type = (node.getAttribute("type") || "text").toLowerCase();
      if (type === "hidden") return "";
      const label = node.getAttribute("aria-label") || node.getAttribute("placeholder")
        || node.getAttribute("name") || type;
      if (type === "checkbox" || type === "radio") {
        return "[" + (node.checked ? "x" : " ") + "] " + label + "\n";
      }
      if (type === "submit" || type === "button") {
        return "[" + (node.value || label) + "]";
      }
      const value = node.value ? ": " + node.value : "";
      return "[" + label + value + "]";
    }
    case "BUTTON": {
      const text = children(node).replace(/\s+/g, " ").trim();
      return text ? "[" + text + "]" : "";
    }
    case "TEXTAREA":
      return "[" + (node.getAttribute("aria-label") || node.getAttribute("name") || "textarea")
        + (node.value ? ": " + node.value : "") + "]";
    case "SELECT": {
      const selected = node.selectedOptions && node.selectedOptions.length
        ? node.selectedOptions[0].textContent
        : "";
      return "[" + (node.getAttribute("aria-label") || node.getAttribute("name") || "select")
        + (selected ? ": " + selected.trim() : "") + "]";
    }
    default:
      return BLOCK.has(tag)
        ? "\n" + children(node) + "\n"
        : children(node);
  }
}

return (function () {
  if (!document.body) return { markdown: "", truncated: false };
  const markdown = render(document.body)
    // Collapse the runs of blank lines the block rules leave behind, and the
    // trailing spaces that make diffs noisy.
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    markdown: markdown.slice(0, CAP),
    truncated: markdown.length > CAP,
  };
})();
