// Point at something on the page and hand the agent what it is: the DOM
// element, the React component that rendered it, and the source file that
// component came from.
//
// This is the step that closes the loop from "this button is the wrong
// colour" to a code edit. A screenshot annotation describes a picture; a pick
// describes `<SubmitButton>` at `src/components/Form.tsx:42`.
//
// The picker also records style experiments. Nudging a property applies it
// inline and remembers the previous value, so what reaches the agent is a
// before/after diff it can turn into a CSS change rather than a screenshot of
// the result.
//
// @dive-include role-name.js
// @dive-include actionability.js
// @dive-include react-context.js
// @dive-include css-path.js

(function () {
  if (
    window.__divePicker &&
    window.__divePicker.version === 1 &&
    typeof window.__divePicker.setNonce === "function"
  ) {
    window.__divePicker.setNonce(__NONCE__);
    return true;
  }

  const OVERLAY_ATTRIBUTE = "data-dive-picker";
  const Z_INDEX = 2147483646;
  const HTML_PREVIEW_MAX = 500;
  const STYLE_PROPERTIES_MAX = 40;

  const state = {
    nonce: __NONCE__,
    active: false,
    hovered: null,
    picked: null,
    styleChanges: [],
    box: null,
    label: null,
  };

  const send = (kind, payload) => {
    try {
      window.__BINDING__(JSON.stringify({ nonce: state.nonce, kind, payload }));
    } catch {
      // The host went away; nothing useful to do from inside the page.
    }
  };

  const isOverlay = (el) => Boolean(el && el.closest && el.closest("[" + OVERLAY_ATTRIBUTE + "]"));

  const ensureChrome = () => {
    if (state.box) return;
    const box = document.createElement("div");
    box.setAttribute(OVERLAY_ATTRIBUTE, "box");
    box.style.cssText = [
      "position:fixed",
      "pointer-events:none",
      "z-index:" + Z_INDEX,
      "border:1px solid rgba(96,165,250,0.9)",
      "background:rgba(96,165,250,0.12)",
      "border-radius:2px",
      "transition:all 60ms ease-out",
    ].join(";");
    const label = document.createElement("div");
    label.setAttribute(OVERLAY_ATTRIBUTE, "label");
    label.style.cssText = [
      "position:fixed",
      "pointer-events:none",
      "z-index:" + Z_INDEX,
      "padding:2px 6px",
      "border-radius:3px",
      "background:rgb(30,41,59)",
      "color:rgb(226,232,240)",
      "font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace",
      "white-space:nowrap",
      "box-shadow:0 1px 3px rgba(0,0,0,0.4)",
    ].join(";");
    document.documentElement.append(box, label);
    state.box = box;
    state.label = label;
  };

  const hideChrome = () => {
    if (state.box) state.box.style.display = "none";
    if (state.label) state.label.style.display = "none";
  };

  const describeShort = (el) => {
    const component = componentOf(el).componentName;
    if (component) return "<" + component + ">";
    const role = roleOf(el);
    const name = nameOf(el).slice(0, 40);
    if (role && name) return role + ' "' + name + '"';
    return el.tagName.toLowerCase() + (el.className && typeof el.className === "string"
      ? "." + el.className.trim().split(/\s+/)[0]
      : "");
  };

  const highlight = (el) => {
    ensureChrome();
    const rect = el.getBoundingClientRect();
    state.box.style.display = "block";
    state.box.style.left = rect.left + "px";
    state.box.style.top = rect.top + "px";
    state.box.style.width = rect.width + "px";
    state.box.style.height = rect.height + "px";
    state.label.style.display = "block";
    state.label.textContent =
      describeShort(el) + "  " + Math.round(rect.width) + "×" + Math.round(rect.height);
    // Above the box when there is room, inside its top edge otherwise.
    const above = rect.top >= 22;
    state.label.style.left = Math.max(2, rect.left) + "px";
    state.label.style.top = (above ? rect.top - 20 : rect.top + 2) + "px";
  };

  // The properties worth reporting: enough to explain a layout or colour
  // problem, few enough that the payload stays readable.
  const REPORTED_STYLES = [
    "display", "position", "width", "height", "margin", "padding",
    "color", "background-color", "font-size", "font-weight", "line-height",
    "border-radius", "border", "flex-direction", "gap", "align-items",
    "justify-content", "grid-template-columns", "opacity", "overflow", "z-index",
  ];

  const stylesOf = (el) => {
    const computed = getComputedStyle(el);
    const lines = [];
    for (const property of REPORTED_STYLES.slice(0, STYLE_PROPERTIES_MAX)) {
      const value = computed.getPropertyValue(property);
      if (value) lines.push(property + ": " + value.trim());
    }
    return lines.join("\n");
  };

  const capture = (el) => {
    const rect = el.getBoundingClientRect();
    const context = componentOf(el);
    return {
      pageUrl: location.href,
      pageTitle: document.title ? document.title.trim() : null,
      tagName: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: nameOf(el).slice(0, 200),
      selector: cssPathOf(el),
      // A role/name locator survives a re-render; the CSS path does not.
      locator: roleOf(el) && nameOf(el)
        ? "role=" + roleOf(el) + '[name="' + nameOf(el).slice(0, 80).replace(/"/g, '\\"') + '"]'
        : "css=" + cssPathOf(el),
      htmlPreview: el.outerHTML.slice(0, HTML_PREVIEW_MAX),
      styles: stylesOf(el),
      componentName: context.componentName,
      source: context.source,
      stack: context.stack,
      owners: context.owners,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      pickedAt: new Date().toISOString(),
    };
  };

  const onMove = (event) => {
    if (!state.active) return;
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (!el || isOverlay(el)) return;
    state.hovered = el;
    highlight(el);
  };

  const onClick = (event) => {
    if (!state.active) return;
    event.preventDefault();
    event.stopPropagation();
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (!el || isOverlay(el)) return;
    state.picked = el;
    state.styleChanges = [];
    stop();
    send("picked", capture(el));
  };

  const onKey = (event) => {
    if (!state.active) return;
    if (event.key === "Escape") {
      event.preventDefault();
      stop();
      send("cancelled", null);
    }
  };

  function start() {
    if (state.active) return true;
    state.active = true;
    ensureChrome();
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    return true;
  }

  function stop() {
    state.active = false;
    state.hovered = null;
    hideChrome();
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    return true;
  }

  window.__divePicker = {
    version: 1,
    setNonce: (nonce) => {
      state.nonce = nonce;
      return true;
    },
    start,
    cancel: () => {
      const was = state.active;
      stop();
      return was;
    },

    // Apply a style to the picked element and remember what it replaced, so
    // the agent receives a diff rather than a finished screenshot.
    setStyle: (property, value) => {
      const el = state.picked;
      if (!el || !el.isConnected) return { error: "nothing_picked" };
      const previous = el.style.getPropertyValue(property);
      const previousPriority = el.style.getPropertyPriority(property);
      const computed = getComputedStyle(el).getPropertyValue(property);
      el.style.setProperty(property, value);
      const existing = state.styleChanges.find((c) => c.property === property);
      if (existing) {
        existing.value = value;
      } else {
        state.styleChanges.push({
          selector: cssPathOf(el),
          locator: capture(el).locator,
          componentName: componentOf(el).componentName,
          property,
          previousValue: (previous || computed || "").trim(),
          previousInlineValue: previous,
          previousPriority,
          value,
        });
      }
      return { ok: true, changes: state.styleChanges.length };
    },

    // Put the picked element back the way it was found.
    revertStyles: () => {
      const el = state.picked;
      if (!el || !el.isConnected) return { error: "nothing_picked" };
      for (const change of state.styleChanges) {
        if (change.previousInlineValue) {
          el.style.setProperty(
            change.property,
            change.previousInlineValue,
            change.previousPriority || "",
          );
        }
        else el.style.removeProperty(change.property);
      }
      const count = state.styleChanges.length;
      state.styleChanges = [];
      return { ok: true, reverted: count };
    },

    // What the agent needs: the element, and every style experiment on it.
    report: () => {
      if (!state.picked || !state.picked.isConnected) return { error: "nothing_picked" };
      return {
        ok: true,
        element: capture(state.picked),
        styleChanges: state.styleChanges.slice(),
      };
    },
  };
  return true;
})();
