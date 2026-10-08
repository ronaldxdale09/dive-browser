// Form entries in the page: as the person types into a named text field,
// asks the host what it remembers for that field on this site and shows the
// matches in a small list under the field; on submit, reports what was typed
// so the host can remember it for this site. Passwords, cards and hidden
// fields never take part.
//
// This runs in Dive's isolated world (see page_world.rs), so the page can
// neither call the binding nor replace anything this script calls, and the
// matches reach nothing but this closure and the closed shadow root below.
// Only the person's own typing, click or keys ask for or pick an entry:
// events page script dispatches are never `isTrusted`, so a page cannot
// open the list, walk it and pick a value to read back out of its field.
// The nonce lives in this closure as a second lock.

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
  let live = null; // the list's own live region
  let items = [];
  let target = null;
  let selected = -1;
  let token = 0;
  const ensure = () => {
    if (host && document.documentElement.contains(host)) return;
    host = document.createElement("dive-form-entries");
    // Only the list inside hides; the host, and the live region in it, stay
    // in the page so the region is being watched when the list next opens.
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;left:0;top:0;display:block;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent =
      ":host{all:initial}" +
      "ul{list-style:none;margin:0;padding:4px;min-width:160px;max-width:360px;box-sizing:border-box;" +
      "font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1c1e;" +
      "background:#fff;border:1px solid rgba(0,0,0,.14);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.16)}" +
      "li{padding:6px 10px;border-radius:5px;cursor:default;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      "li[aria-selected=true]{background:#2b6ef2;color:#fff}" +
      ":host([data-dark]) ul{background:#2a2a2e;color:#f2f2f2;border-color:rgba(255,255,255,.14)}" +
      ".live{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}";
    listEl = document.createElement("ul");
    listEl.setAttribute("role", "listbox");
    listEl.setAttribute("aria-label", "Earlier entries for this field");
    listEl.style.display = "none";
    live = document.createElement("span");
    live.className = "live";
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");
    listEl.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the field
    listEl.addEventListener("click", (e) => {
      const li = e.target instanceof Element ? e.target.closest("li") : null;
      if (li && e.isTrusted) choose(Number(li.dataset.index));
    });
    root.append(style, listEl, live);
    document.documentElement.appendChild(host);
  };
  // Said a moment after it is set, so a region added a moment ago is
  // already being watched when the words arrive.
  let saying = 0;
  const say = (text) => {
    if (!live) return;
    clearTimeout(saying);
    live.textContent = "";
    saying = setTimeout(() => {
      if (live) live.textContent = text;
    }, 50);
  };
  const shown = () => listEl !== null && listEl.style.display !== "none";
  // The field's own attributes are the page's and are left as they are: a
  // page that set aria-activedescendant for its own list had it taken away
  // every time this one closed.
  const hide = () => {
    if (listEl) listEl.style.display = "none";
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
    listEl.style.display = "block";
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
    say(items[selected] + ", " + (selected + 1) + " of " + items.length);
  };

  Object.defineProperty(window, "__diveFormsOffer", {
    configurable: false,
    enumerable: false,
    value: (nonce, forToken, list) => {
      if (nonce !== NONCE || forToken !== token || !Array.isArray(list)) return;
      if (!target || document.activeElement !== target) return;
      // The saved-login list already hangs under this field; two lists
      // stacked in one spot is one too many.
      const owns = window.__diveCredentialsOwns;
      if (typeof owns === "function" && owns(target)) return hide();
      items = list.filter((v) => typeof v === "string").slice(0, 8);
      selected = -1;
      if (items.length === 0) return hide();
      // Said when the list opens, not as it narrows with every letter typed.
      const opening = !shown();
      render();
      if (opening) say(items.length + (items.length === 1 ? " earlier entry" : " earlier entries") + ", use arrow keys");
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
  // Shared only inside Dive's isolated world. Account suggestions win
  // regardless of which binding answers first; invalidate late history replies.
  Object.defineProperty(window, "__diveFormsDismissFor", {
    configurable: false,
    enumerable: false,
    value: (field) => {
      if (field !== target) return;
      clearTimeout(debounce);
      token += 1;
      hide();
    },
  });
  // Typing asks; a click on an empty field asks too, with an empty prefix,
  // so it shows what is remembered for it. Both have to be the person's: an
  // `input` event the page (or this script's own fill) dispatches, or focus
  // the page moved there itself, asks nothing.
  let pressed = { at: 0, target: null };
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.isTrusted) pressed = { at: Date.now(), target: e.composedPath()[0] || e.target };
    },
    true,
  );
  const reaches = (from, el) =>
    from === el || (from instanceof Node && [...(el.labels || [])].some((label) => label.contains(from)));
  document.addEventListener(
    "input",
    (e) => {
      if (e.isTrusted && e.target instanceof HTMLInputElement) ask(e.target);
    },
    true,
  );
  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLInputElement) || el.value) return;
      if (Date.now() - pressed.at < 1500 && reaches(pressed.target, el)) ask(el);
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
      if (!e.isTrusted || !target || items.length === 0 || e.target !== target) return;
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
  window.addEventListener("scroll", () => (shown() ? place() : null), true);
  window.addEventListener("resize", () => (shown() ? place() : null));

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
