// Form entries in the page: as the person types into a named text field,
// asks the host what it remembers for that field and shows the matches in
// a small list under the field; on submit, reports what was typed so the
// host can remember it. Passwords, cards and hidden fields never take part.
//
// The nonce lives in this closure; page script cannot forge a report or
// hand the list its own values.

(function () {
  if (window.top !== window) return; // main frame only
  if (window.__diveFormsInstalled) return;
  window.__diveFormsInstalled = true;
  const NONCE = __NONCE__;
  const send = (payload) => {
    try {
      payload.nonce = NONCE;
      window.__BINDING__(JSON.stringify(payload));
    } catch {
      // No binding: nothing to offer.
    }
  };
  const TYPES = /^(text|email|tel|url|search|)$/i;
  const SECRET = /pass|pwd|cvc|cvv|card|otp|token|secret|ssn/i;
  const fieldOf = (el) => {
    if (!(el instanceof HTMLInputElement) || !TYPES.test(el.type || "")) return "";
    if (el.readOnly || el.disabled || /^off$/i.test(el.autocomplete || "")) return "";
    const name = (el.name || el.id || "").trim().toLowerCase();
    if (!name || name.length > 100 || SECRET.test(name)) return "";
    return name;
  };
  const setValue = (el, value) => {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  // ---- the list ----
  let host = null;
  let listEl = null;
  let items = [];
  let target = null;
  let selected = -1;
  let token = 0;
  const ensure = () => {
    if (host && document.documentElement.contains(host)) return;
    host = document.createElement("dive-form-entries");
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;left:0;top:0;display:none;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent =
      ":host{all:initial}" +
      "ul{list-style:none;margin:0;padding:4px;min-width:160px;max-width:360px;box-sizing:border-box;" +
      "font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1c1e;" +
      "background:#fff;border:1px solid rgba(0,0,0,.14);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.16)}" +
      "li{padding:6px 10px;border-radius:5px;cursor:default;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      "li[aria-selected=true]{background:#2b6ef2;color:#fff}" +
      ":host([data-dark]) ul{background:#2a2a2e;color:#f2f2f2;border-color:rgba(255,255,255,.14)}";
    listEl = document.createElement("ul");
    listEl.setAttribute("role", "listbox");
    listEl.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the field
    listEl.addEventListener("click", (e) => {
      const li = e.target instanceof Element ? e.target.closest("li") : null;
      if (li) choose(Number(li.dataset.index));
    });
    root.append(style, listEl);
    document.documentElement.appendChild(host);
  };
  const hide = () => {
    if (host) host.style.display = "none";
    if (target) target.removeAttribute("aria-activedescendant");
    items = [];
    selected = -1;
  };
  // The list follows the page, not the OS: a light page gets a light list.
  const pageIsDark = (el) => {
    const scheme = getComputedStyle(el).colorScheme || "";
    if (/dark/.test(scheme) && !/light/.test(scheme)) return true;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(getComputedStyle(el).backgroundColor || "");
    if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) return false;
    return 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]) < 128;
  };
  const place = () => {
    if (!target || !host) return;
    if (pageIsDark(target)) host.setAttribute("data-dark", "");
    else host.removeAttribute("data-dark");
    const r = target.getBoundingClientRect();
    host.style.left = Math.max(0, r.left) + "px";
    host.style.top = r.bottom + 2 + "px";
    host.style.display = "block";
  };
  const render = () => {
    ensure();
    listEl.textContent = "";
    items.forEach((value, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === selected));
      li.dataset.index = String(i);
      li.textContent = value;
      listEl.appendChild(li);
    });
    place();
  };
  const choose = (i) => {
    const value = items[i];
    if (!target || value === undefined) return;
    setValue(target, value);
    send({ kind: "used", field: fieldOf(target), value });
    hide();
  };
  const select = (i) => {
    selected = (i + items.length) % items.length;
    render();
  };

  Object.defineProperty(window, "__diveFormsOffer", {
    configurable: false,
    enumerable: false,
    value: (nonce, forToken, list) => {
      if (nonce !== NONCE || forToken !== token || !Array.isArray(list)) return;
      if (!target || document.activeElement !== target) return;
      items = list.filter((v) => typeof v === "string").slice(0, 8);
      selected = -1;
      if (items.length === 0) return hide();
      render();
    },
  });

  let debounce = 0;
  const ask = (el) => {
    const field = fieldOf(el);
    if (!field) return hide();
    target = el;
    token += 1;
    const forToken = token;
    clearTimeout(debounce);
    debounce = setTimeout(() => send({ kind: "query", field, prefix: el.value.slice(0, 200), token: forToken }), 80);
  };
  // Typing asks; plain focus after a click asks too, with an empty prefix,
  // so an empty field shows what is remembered for it.
  let lastInteraction = 0;
  const noteInteraction = () => {
    lastInteraction = Date.now();
  };
  document.addEventListener("pointerdown", noteInteraction, true);
  document.addEventListener("keydown", noteInteraction, true);
  document.addEventListener(
    "input",
    (e) => {
      if (e.target instanceof HTMLInputElement) ask(e.target);
    },
    true,
  );
  document.addEventListener(
    "focusin",
    (e) => {
      if (e.target instanceof HTMLInputElement && Date.now() - lastInteraction < 1500 && !e.target.value) ask(e.target);
    },
    true,
  );
  document.addEventListener(
    "focusout",
    (e) => {
      if (e.target === target) hide();
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (!target || items.length === 0 || e.target !== target) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        select(selected + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        select(selected - 1);
      } else if (e.key === "Enter" && selected >= 0) {
        e.preventDefault();
        choose(selected);
      } else if (e.key === "Escape") {
        e.stopPropagation();
        hide();
      }
    },
    true,
  );
  window.addEventListener("scroll", () => (host && host.style.display !== "none" ? place() : null), true);
  window.addEventListener("resize", () => (host && host.style.display !== "none" ? place() : null));

  // ---- remembering ----
  const report = (form) => {
    const entries = [];
    for (const el of form.querySelectorAll("input")) {
      const field = fieldOf(el);
      const value = el.value.trim();
      if (!field || !value || value.length > 200) continue;
      if (el.form && [...el.form.querySelectorAll('input[type="password"]')].some((p) => p.value) && /user|login|email|account/i.test(field)) {
        continue; // a login's username is the credential store's business
      }
      entries.push({ field, value });
      if (entries.length >= 30) break;
    }
    if (entries.length) send({ kind: "submitted", entries });
  };
  document.addEventListener(
    "submit",
    (e) => {
      if (e.target instanceof HTMLFormElement) report(e.target);
    },
    true,
  );
})();
