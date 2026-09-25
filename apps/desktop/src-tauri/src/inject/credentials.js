// Saved logins in the page: notices login forms, asks the host whether it
// knows a login for this site, fills on request, and reports a submitted
// login so the chrome can offer to save it. Nothing here reads a saved
// password on its own: the host sends one only after a fill was asked for.
//
// The nonce is the only thing stopping page script from forging reports or
// asking for a fill; it lives in this closure, never on `window`.

(function () {
  if (window.top !== window) return; // main frame only
  if (window.__diveCredentialsInstalled) return;
  window.__diveCredentialsInstalled = true;
  const NONCE = __NONCE__;
  // Taken now, before any page script runs: a page that later replaced the
  // binding or JSON.stringify would otherwise be handed the nonce. The
  // payload has no prototype, so an Object.prototype.toJSON sees nothing.
  const bind = window.__BINDING__;
  const stringify = JSON.stringify;
  const send = (fields) => {
    try {
      const payload = Object.assign(Object.create(null), fields);
      payload.nonce = NONCE;
      bind(stringify(payload));
    } catch {
      // No binding, or a page that broke JSON: nothing to report.
    }
  };
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const passwordFields = () => [...document.querySelectorAll('input[type="password"]')].filter(isVisible);
  // The username is the closest text-like field before the password in the
  // same form, preferring one that says so.
  const usernameFor = (password) => {
    const scope = password.form || document;
    const inputs = [...scope.querySelectorAll("input")].filter(
      (el) => el !== password && /^(text|email|tel|)$/i.test(el.type || "") && isVisible(el),
    );
    const before = inputs.filter((el) => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
    return (
      before.find((el) => /username|email/i.test(el.autocomplete || "") || /user|email|login|account/i.test(el.name + " " + el.id + " " + el.placeholder)) ||
      before[before.length - 1] ||
      null
    );
  };
  const setValue = (el, value) => {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  let candidates = null; // [{id, username}] from the host, or null until asked
  let offerPending = () => {}; // set once the list below is defined
  let asked = false;
  const ask = () => {
    if (asked) return;
    asked = true;
    send({ kind: "query", url: location.href });
  };
  // The host answers through this accessor, never via a global the page
  // could call first with its own list.
  Object.defineProperty(window, "__diveCredentialsOffer", {
    configurable: false,
    enumerable: false,
    value: (nonce, list) => {
      if (nonce !== NONCE || !Array.isArray(list)) return;
      candidates = list.slice(0, 20);
      maybeFillIdle();
      offerPending();
    },
  });
  let fillTarget = null;
  // Focus that follows a click or a key press is the person's; focus that
  // arrives on its own (the chrome handing the page back after its card
  // closes) must not ask again, or the card would never stay closed.
  let lastInteraction = 0;
  const noteInteraction = (e) => {
    if (e.isTrusted) lastInteraction = Date.now();
  };
  document.addEventListener("pointerdown", noteInteraction, true);
  document.addEventListener("keydown", noteInteraction, true);
  Object.defineProperty(window, "__diveCredentialsFill", {
    configurable: false,
    enumerable: false,
    value: (nonce, login) => {
      if (nonce !== NONCE || !login) return;
      const password = fillTarget && document.contains(fillTarget) ? fillTarget : passwordFields()[0];
      if (!password) return;
      const user = usernameFor(password);
      if (user && login.username) setValue(user, login.username);
      setValue(password, login.password);
      send({ kind: "filled", id: login.id });
    },
  });
  const requestFill = (password, id) => {
    fillTarget = password;
    send({ kind: "fill", id });
  };
  // One saved login and untouched fields: fill as soon as the form is there,
  // the way every password manager does for a lone login.
  const maybeFillIdle = () => {
    if (!candidates || candidates.length !== 1) return;
    const password = passwordFields()[0];
    if (!password || password.value) return;
    const user = usernameFor(password);
    if (user && user.value) return;
    requestFill(password, candidates[0].id);
  };
  // ---- the saved-login list ----
  // Several logins known: the choice hangs under the field that was clicked,
  // the way every browser shows it, instead of in a card across the window.
  // It lives in a closed shadow root taken before any page script ran, and a
  // pick only asks the host to fill: the host checks the site again and the
  // password never passes through this list.
  const attachShadow = Element.prototype.attachShadow;
  let host = null;
  let listEl = null;
  let listFor = null; // the field the list hangs under
  let listPassword = null; // the password field a pick fills
  let selected = -1;
  const ensure = () => {
    if (host && document.documentElement.contains(host)) return;
    host = document.createElement("dive-saved-logins");
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;left:0;top:0;display:none;";
    const root = attachShadow.call(host, { mode: "closed" });
    const style = document.createElement("style");
    style.textContent =
      ":host{all:initial}" +
      "div{margin:0;padding:4px;min-width:200px;max-width:360px;max-height:240px;overflow-y:auto;box-sizing:border-box;" +
      "font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1c1e;" +
      "background:#fff;border:1px solid rgba(0,0,0,.14);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.16)}" +
      "p{margin:2px 8px 4px;font-size:11px;color:#6e6e73}" +
      "button{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border-radius:6px;cursor:default;" +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      "button span{overflow:hidden;text-overflow:ellipsis}" +
      "svg{flex:none;opacity:.6}" +
      "button[aria-selected=true],button:hover{background:#2b6ef2;color:#fff}" +
      "button[aria-selected=true] svg,button:hover svg{opacity:1}" +
      ":host([data-dark]) div{background:#2a2a2e;color:#f2f2f2;border-color:rgba(255,255,255,.14)}" +
      ":host([data-dark]) p{color:#98989d}";
    listEl = document.createElement("div");
    listEl.setAttribute("role", "listbox");
    listEl.setAttribute("aria-label", "Saved logins");
    // Keep focus in the field, so typing carries on if nothing is picked.
    listEl.addEventListener("mousedown", (e) => e.preventDefault());
    listEl.addEventListener("click", (e) => {
      const item = e.target instanceof Element ? e.target.closest("button") : null;
      // Only a real click: page script cannot pick a login on the person's behalf.
      if (item && e.isTrusted) choose(Number(item.dataset.index));
    });
    root.append(style, listEl);
    document.documentElement.appendChild(host);
  };
  const hideList = () => {
    if (host) host.style.display = "none";
    listFor = null;
    listPassword = null;
    selected = -1;
  };
  const listShown = () => host !== null && host.style.display !== "none" && listFor !== null;
  const pageIsDark = (el) => {
    const scheme = getComputedStyle(el).colorScheme || "";
    if (/dark/.test(scheme) && !/light/.test(scheme)) return true;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(getComputedStyle(document.body || el).backgroundColor || "");
    if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) return false;
    return 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]) < 128;
  };
  const place = () => {
    if (!listFor || !host) return;
    if (pageIsDark(listFor)) host.setAttribute("data-dark", "");
    else host.removeAttribute("data-dark");
    host.style.display = "block";
    const r = listFor.getBoundingClientRect();
    // At least as wide as the field it belongs to.
    listEl.style.minWidth = Math.min(Math.max(r.width, 200), 360) + "px";
    const box = host.getBoundingClientRect();
    // Under the field, or above it when the viewport has no room below.
    const below = r.bottom + 4;
    const top = below + box.height > innerHeight - 4 && r.top - 4 - box.height >= 4 ? r.top - 4 - box.height : below;
    host.style.left = Math.max(4, Math.min(r.left, innerWidth - box.width - 4)) + "px";
    host.style.top = top + "px";
  };
  const KEY =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/>' +
    '<circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg>';
  const render = () => {
    ensure();
    listEl.textContent = "";
    const caption = document.createElement("p");
    caption.textContent = "Saved logins";
    listEl.appendChild(caption);
    candidates.forEach((login, i) => {
      const item = document.createElement("button");
      item.type = "button";
      item.tabIndex = -1;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(i === selected));
      item.dataset.index = String(i);
      item.title = login.username;
      item.innerHTML = KEY;
      const name = document.createElement("span");
      name.textContent = login.username || "(no username)";
      item.appendChild(name);
      listEl.appendChild(item);
    });
    place();
  };
  const showList = (field, password) => {
    if (!candidates || candidates.length < 2) return;
    listFor = field;
    listPassword = password;
    selected = -1;
    render();
  };
  const choose = (i) => {
    const login = candidates && candidates[i];
    const password = listPassword;
    hideList();
    if (login && password) requestFill(password, login.id);
  };
  // The list stays out of the way of the page's own keys unless it is open.
  document.addEventListener(
    "keydown",
    (e) => {
      if (!listShown() || e.target !== listFor || !candidates) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = candidates.length;
        selected = e.key === "ArrowDown" ? (selected + 1) % n : (selected - 1 + n) % n;
        render();
      } else if (e.key === "Enter" && selected >= 0) {
        e.preventDefault();
        e.stopPropagation();
        choose(selected);
      } else if (e.key === "Escape") {
        e.stopPropagation();
        hideList();
      } else if (e.key.length === 1 || e.key === "Backspace") {
        // Typing a different login: get out of the way.
        hideList();
      }
    },
    true,
  );
  document.addEventListener(
    "focusout",
    (e) => {
      if (e.target === listFor) hideList();
    },
    true,
  );
  window.addEventListener("scroll", () => (listShown() ? place() : null), true);
  window.addEventListener("resize", () => (listShown() ? place() : null));
  // The form-entries list must not open under a field this list owns.
  Object.defineProperty(window, "__diveCredentialsOwns", {
    configurable: false,
    enumerable: false,
    value: (el) => listShown() && el === listFor,
  });

  // The login fields around `el`: the password a pick fills, or null.
  const passwordOf = (el) =>
    el.type === "password" ? el : passwordFields().find((p) => usernameFor(p) === el) || null;
  // Focus on a login field: fill a lone login, or offer the choice.
  const offerFor = (el) => {
    const password = passwordOf(el);
    if (!password || !candidates || candidates.length === 0) return;
    if (candidates.length === 1) {
      if (!password.value) requestFill(password, candidates[0].id);
      return;
    }
    showList(el, password);
  };
  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLInputElement) || !passwordOf(el)) return;
      ask();
      if (Date.now() - lastInteraction > 1500) return;
      offerFor(el);
    },
    true,
  );
  // The host's answer can land after the click that focused the field.
  offerPending = () => {
    const el = document.activeElement;
    if (el instanceof HTMLInputElement && Date.now() - lastInteraction <= 1500 && !listShown()) offerFor(el);
  };
  // A submitted form with a password: the chrome may offer to save it. On a
  // change-password form the new password is the one to keep: the field
  // that says so, else the last one filled in.
  let lastReport = { form: null, at: 0 };
  const report = (form) => {
    const filled = [...form.querySelectorAll('input[type="password"]')].filter((p) => p.value);
    const password = filled.find((p) => /new-password/i.test(p.autocomplete || "")) || filled[filled.length - 1];
    if (!password) return;
    // A real submit is both a click on its button and a submit event; one
    // report is enough.
    if (lastReport.form === form && Date.now() - lastReport.at < 1000) return;
    lastReport = { form, at: Date.now() };
    const user = usernameFor(password);
    send({ kind: "submitted", url: location.href, username: user ? user.value : "", password: password.value });
  };
  document.addEventListener(
    "submit",
    (e) => {
      if (e.target instanceof HTMLFormElement) report(e.target);
    },
    true,
  );
  // Many login pages submit from script without a submit event; a click on
  // the form's submit button is the next best signal. Only a submit button:
  // "show password" and "forgot password?" buttons live in the same form,
  // and a click on one of those half way through typing is not a login.
  document.addEventListener(
    "click",
    (e) => {
      const button = e.target instanceof Element ? e.target.closest("button, input[type=submit]") : null;
      if (e.isTrusted && button && button.form && button.type === "submit") report(button.form);
    },
    true,
  );
  const observer = new MutationObserver(() => {
    if (passwordFields().length) {
      ask();
      maybeFillIdle();
    }
  });
  const start = () => {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    if (passwordFields().length) {
      ask();
      maybeFillIdle();
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
