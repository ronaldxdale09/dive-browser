// ARIA role and accessible name, following the heuristics Playwright's
// `getByRole` resolves against.
//
// Shared by the locator engine, the recorder and the element picker so all
// three agree on what a button is called. When they disagree, a flow
// recorded as `role=button[name="Save"]` stops replaying and an agent's
// locator stops matching the step the person recorded.

const text = (el) => (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");

const nameOf = (el) => {
  if (!el || !el.getAttribute) return "";
  const aria = el.getAttribute("aria-label") || "";
  if (aria) return aria.trim();
  const labelled = el.getAttribute("aria-labelledby");
  if (labelled) {
    const parts = labelled.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean);
    if (parts.length) return parts.map(text).join(" ").trim();
  }
  if (el.labels && el.labels.length) return text(el.labels[0]);
  if (el.tagName === "INPUT" && (el.type === "submit" || el.type === "button" || el.type === "reset")) {
    return (el.value || "").trim();
  }
  if (el.tagName === "IMG") return (el.alt || "").trim();
  const placeholder = el.getAttribute("placeholder");
  if (placeholder && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return placeholder.trim();
  const own = text(el).slice(0, 200);
  if (own) return own;
  const title = el.getAttribute("title");
  return title ? title.trim() : "";
};

const roleOf = (el) => {
  if (!el || !el.getAttribute) return "";
  const explicit = el.getAttribute("role");
  if (explicit) return explicit.trim().split(/\s+/)[0].toLowerCase();
  const t = el.tagName;
  const type = (el.type || "").toLowerCase();
  if (t === "A" && el.hasAttribute("href")) return "link";
  if (t === "BUTTON" || (t === "INPUT" && (type === "submit" || type === "button" || type === "reset"))) return "button";
  if (t === "INPUT" && type === "checkbox") return "checkbox";
  if (t === "INPUT" && type === "radio") return "radio";
  if (t === "INPUT" && type === "search") return "searchbox";
  if (t === "TEXTAREA") return "textbox";
  if (t === "INPUT" && !["hidden", "file", "image", "color", "range", "date", "time"].includes(type)) return "textbox";
  if (t === "SELECT") return el.multiple || el.size > 1 ? "listbox" : "combobox";
  if (t === "OPTION") return "option";
  if (t === "IMG") return el.alt === "" ? "presentation" : "img";
  if (t === "NAV") return "navigation";
  if (t === "MAIN") return "main";
  if (t === "HEADER") return "banner";
  if (t === "FOOTER") return "contentinfo";
  if (t === "ASIDE") return "complementary";
  if (t === "FORM") return "form";
  if (t === "TABLE") return "table";
  if (t === "UL" || t === "OL") return "list";
  if (t === "LI") return "listitem";
  if (t === "DIALOG") return "dialog";
  if (t === "SUMMARY") return "button";
  if (/^H[1-6]$/.test(t)) return "heading";
  return "";
};
