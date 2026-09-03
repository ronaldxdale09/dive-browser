// Playwright-style locators, resolved against the live DOM.
//
// Grammar (chain steps with `>>` to scope each one inside the last):
//   role=button[name="Save"]   also [exact] [checked] [selected] [disabled] [level=2]
//   text=Continue              substring, case-insensitive; text="Continue" is exact
//   testid=submit              [data-testid=...]
//   label=Email                accessible name of a form control
//   placeholder= / alt= / title=
//   css=.btn > span            also the default when no engine prefix is given
//   nth=0                      pick one match; nth=-1 is the last
//   visible=true               keep only rendered matches
//
// @dive-include role-name.js
// @dive-include actionability.js

(function () {
  if (window.__diveLocator && window.__diveLocator.version === 1) return true;

  const MAX_CANDIDATES = __MAX_CANDIDATES__;
  const ENGINES = ["css", "role", "text", "testid", "label", "placeholder", "alt", "title", "nth", "visible"];

  const norm = (s) => String(s == null ? "" : s).trim().replace(/\s+/g, " ");
  const fold = (s) => norm(s).toLowerCase();

  // `"Save"` is an exact, case-sensitive match; bare `Save` is a folded substring.
  const unquote = (raw) => {
    const s = raw.trim();
    const quoted =
      s.length >= 2 &&
      ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")));
    if (quoted) return { value: s.slice(1, -1).replace(/\\(.)/g, "$1"), exact: true };
    return { value: s, exact: false };
  };

  const textMatches = (haystack, want) =>
    want.exact ? norm(haystack) === norm(want.value) : fold(haystack).includes(fold(want.value));

  // Split on `>>` outside quotes and brackets, so `text="a >> b"` stays one step.
  const split = (selector) => {
    const parts = [];
    let depth = 0;
    let quote = null;
    let current = "";
    for (let i = 0; i < selector.length; i++) {
      const c = selector[i];
      if (quote) {
        current += c;
        if (c === quote && selector[i - 1] !== "\\") quote = null;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        current += c;
        continue;
      }
      if (c === "[") depth++;
      else if (c === "]") depth--;
      if (depth <= 0 && c === ">" && selector[i + 1] === ">") {
        parts.push(current);
        current = "";
        i++;
        continue;
      }
      current += c;
    }
    parts.push(current);
    return parts.map((p) => p.trim()).filter((p) => p.length > 0);
  };

  const parseStep = (raw) => {
    const s = raw.trim();
    const eq = s.indexOf("=");
    if (eq > 0) {
      const engine = s.slice(0, eq).trim().toLowerCase();
      if (ENGINES.includes(engine)) return { engine, body: s.slice(eq + 1).trim() };
    }
    return { engine: "css", body: s };
  };

  // `button[name="Save"][exact]` -> role plus attribute filters.
  const parseRole = (body) => {
    const m = /^([a-zA-Z][a-zA-Z-]*)/.exec(body);
    if (!m) throw new Error("role= needs a role name, for example role=button");
    const attrs = {};
    const rest = body.slice(m[0].length).trim();
    const re = /\[([a-zA-Z]+)(?:\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\]]*))?\]/g;
    let a;
    let consumed = 0;
    while ((a = re.exec(rest))) {
      consumed += a[0].length;
      attrs[a[1].toLowerCase()] = a[2] === undefined ? { flag: true } : unquote(a[2]);
    }
    if (consumed !== rest.length) {
      throw new Error("could not parse the role filters in " + JSON.stringify(body));
    }
    return { role: m[1].toLowerCase(), attrs };
  };

  // A tri-state filter: `[checked]` and `[checked=true]` want it on,
  // `[checked=false]` wants it off.
  const wants = (attr) => attr.flag === true || attr.value !== "false";

  // Every element under `scope`, piercing open shadow roots the way
  // Playwright's selectors do.
  const candidates = (scope) => {
    const out = [];
    const walk = (root) => {
      if (out.length >= MAX_CANDIDATES) return;
      for (const el of root.querySelectorAll("*")) {
        out.push(el);
        if (out.length >= MAX_CANDIDATES) return;
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(scope);
    return out;
  };

  const byAttribute = (attribute, body) => {
    const want = unquote(body);
    return (scope) =>
      candidates(scope).filter((el) => {
        const value = el.getAttribute(attribute);
        return value != null && textMatches(value, want);
      });
  };

  // Anything a <label> can be associated with. Deliberately not filtered by
  // editability: a readonly field still has a label, and reporting it as
  // "not found" would send the caller hunting for another locator instead of
  // telling it the field is locked.
  const LABELLABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "METER", "OUTPUT", "PROGRESS"]);
  const LABELLABLE_ROLES = new Set([
    "textbox", "searchbox", "combobox", "listbox", "checkbox", "radio",
    "switch", "slider", "spinbutton", "button",
  ]);
  const isLabellable = (el) =>
    LABELLABLE_TAGS.has(el.tagName) || LABELLABLE_ROLES.has(roleOf(el)) || isContentEditable(el);

  const matchers = {
    css: (body) => (scope) => {
      try {
        return Array.from(scope.querySelectorAll(body));
      } catch {
        throw new Error("not a valid CSS selector: " + body);
      }
    },
    role: (body) => {
      const { role, attrs } = parseRole(body);
      const wantName =
        attrs.name && attrs.name.flag !== true
          ? { value: attrs.name.value, exact: attrs.name.exact || attrs.exact !== undefined }
          : null;
      return (scope) =>
        candidates(scope).filter((el) => {
          if (roleOf(el) !== role) return false;
          if (wantName && !textMatches(nameOf(el), wantName)) return false;
          if (attrs.checked !== undefined) {
            const on = el.checked === true || el.getAttribute("aria-checked") === "true";
            if (on !== wants(attrs.checked)) return false;
          }
          if (attrs.selected !== undefined) {
            const on = el.selected === true || el.getAttribute("aria-selected") === "true";
            if (on !== wants(attrs.selected)) return false;
          }
          if (attrs.disabled !== undefined) {
            if (!isEnabled(el) !== wants(attrs.disabled)) return false;
          }
          if (attrs.level && attrs.level.flag !== true) {
            const heading = /^H([1-6])$/.exec(el.tagName);
            const level = el.getAttribute("aria-level") || (heading && heading[1]);
            if (String(level) !== String(attrs.level.value)) return false;
          }
          return true;
        });
    },
    text: (body) => {
      const want = unquote(body);
      return (scope) =>
        candidates(scope).filter((el) => {
          if (!textMatches(text(el), want)) return false;
          // Prefer the innermost element carrying the text: <body> matches
          // every string on the page but is useless as a click target.
          return !Array.from(el.children).some((child) => textMatches(text(child), want));
        });
    },
    testid: (body) => byAttribute("data-testid", body),
    placeholder: (body) => byAttribute("placeholder", body),
    alt: (body) => byAttribute("alt", body),
    title: (body) => byAttribute("title", body),
    label: (body) => {
      const want = unquote(body);
      return (scope) =>
        candidates(scope).filter((el) => isLabellable(el) && textMatches(nameOf(el), want));
    },
  };

  const resolveAll = (selector) => {
    const steps = split(String(selector == null ? "" : selector)).map(parseStep);
    if (!steps.length) throw new Error("empty locator");
    let current = [document];
    for (const step of steps) {
      if (step.engine === "nth") {
        const n = Number(step.body);
        if (!Number.isInteger(n)) {
          throw new Error("nth= needs an integer, for example nth=0 or nth=-1");
        }
        const picked = n < 0 ? current[current.length + n] : current[n];
        current = picked ? [picked] : [];
        continue;
      }
      if (step.engine === "visible") {
        const want = step.body !== "false";
        current = current.filter((el) => el.nodeType === 1 && isVisible(el) === want);
        continue;
      }
      const match = matchers[step.engine](step.body);
      const next = [];
      const seen = new Set();
      for (const scope of current) {
        for (const el of match(scope)) {
          if (seen.has(el)) continue;
          seen.add(el);
          next.push(el);
        }
      }
      current = next;
      if (!current.length) break;
    }
    return current.filter((el) => el.nodeType === 1);
  };

  const describe = (el, count) => {
    const rect = el.getBoundingClientRect();
    return {
      ok: true,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
      role: roleOf(el),
      name: nameOf(el).slice(0, 200),
      tag: el.tagName.toLowerCase(),
      count,
    };
  };

  const guard =
    (fn) =>
    (...args) => {
      try {
        return fn(...args);
      } catch (e) {
        return { error: "invalid", reason: String((e && e.message) || e) };
      }
    };

  // First match, scrolled into view, having passed the actionability checks.
  const actionable = (selector, requireEditable) => {
    const all = resolveAll(selector);
    if (!all.length) return { error: "not_found" };
    const el = all[0];
    if (!isVisible(el)) return { error: "not_visible" };
    if (!isEnabled(el)) return { error: "not_enabled" };
    if (requireEditable && !isEditable(el)) return { error: "not_editable" };
    if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center" });
    return { element: el, described: describe(el, all.length) };
  };

  window.__diveLocator = {
    version: 1,

    // Resolve to a click point.
    point: guard((selector) => {
      const found = actionable(selector, false);
      return found.error ? found : found.described;
    }),

    // Resolve, focus, and report the point; fails unless it can accept text.
    focus: guard((selector) => {
      const found = actionable(selector, true);
      if (found.error) return found;
      found.element.focus();
      const active = document.activeElement;
      if (active !== found.element && !found.element.contains(active)) {
        return { error: "not_editable" };
      }
      return found.described;
    }),

    // How many elements match, ignoring actionability. Zero is not an error.
    matches: guard((selector) => ({ ok: true, count: resolveAll(selector).length })),

    // Describe each match, for reporting an ambiguous locator back.
    all: guard((selector, limit) => ({
      ok: true,
      matches: resolveAll(selector)
        .slice(0, limit || 20)
        .map((el) => describe(el, 1)),
    })),

    // Resolve without requiring the element to be actionable.
    resolve: guard((selector) => {
      const all = resolveAll(selector);
      return all.length ? describe(all[0], all.length) : { error: "not_found" };
    }),

    // Everything on the page worth acting on, each with the locator that
    // addresses it. This is what makes one `page_inspect` enough to plan
    // from: a CSS path would go stale, a bare role/name pair would leave the
    // caller to guess the syntax.
    elements: guard((limit) => {
      const interactive =
        "a[href],button,input,textarea,select,summary,[role],[tabindex],[contenteditable]";
      const seen = new Set();
      const out = [];
      const cap = limit || 200;
      const collect = (root) => {
        for (const el of root.querySelectorAll(interactive)) {
          if (out.length >= cap) return;
          if (seen.has(el)) continue;
          seen.add(el);
          if (!isVisible(el)) continue;
          const role = roleOf(el);
          if (role === "presentation" || role === "none") continue;
          const name = nameOf(el).slice(0, 120);
          const rect = el.getBoundingClientRect();
          out.push({
            role,
            name,
            tag: el.tagName.toLowerCase(),
            // Ambiguity is reported rather than hidden: two "Save" buttons
            // get `>> nth=N` appended so each entry addresses one element.
            locator: null,
            enabled: isEnabled(el),
            editable: isEditable(el),
            value: isEditable(el) ? String(el.value == null ? "" : el.value).slice(0, 120) : null,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          });
        }
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) collect(el.shadowRoot);
        }
      };
      collect(document);

      // Assign each entry the cheapest locator that resolves to it alone.
      const counts = new Map();
      for (const entry of out) {
        const base =
          entry.role && entry.name
            ? "role=" + entry.role + '[name="' + entry.name.replace(/"/g, '\\"') + '"]'
            : entry.role
              ? "role=" + entry.role
              : "css=" + entry.tag;
        counts.set(base, (counts.get(base) || 0) + 1);
        entry.locator = base;
      }
      const used = new Map();
      for (const entry of out) {
        if (counts.get(entry.locator) > 1) {
          const index = used.get(entry.locator) || 0;
          used.set(entry.locator, index + 1);
          entry.locator = entry.locator + " >> nth=" + index;
        }
      }
      return { ok: true, elements: out, truncated: out.length >= cap };
    }),

    // The page itself: enough to know where you are and whether it settled.
    page: guard((textLimit) => ({
      ok: true,
      url: location.href,
      title: document.title,
      loading: document.readyState !== "complete",
      ready_state: document.readyState,
      // `text` falls back to textContent, which is what keeps this working
      // on hosts that do not implement innerText.
      visible_text: (document.body ? text(document.body) : "").slice(0, textLimit || 12000),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
      scroll_height: document.documentElement ? document.documentElement.scrollHeight : 0,
      // Reflects a page_appearance override, so a caller can confirm the
      // emulation took. Guarded because not every embedding has matchMedia.
      color_scheme:
        typeof window.matchMedia === "function"
          ? window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
          : null,
    })),

    // Set a node aside so a follow-up expression can read the same element.
    hold: guard((selector) => {
      const all = resolveAll(selector);
      if (!all.length) return { error: "not_found" };
      window.__diveHeld = all[0];
      return describe(all[0], all.length);
    }),
  };
  return true;
})();
