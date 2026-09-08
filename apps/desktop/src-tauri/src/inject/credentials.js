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
  const send = (payload) => {
    try {
      payload.nonce = NONCE;
      window.__BINDING__(JSON.stringify(payload));
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
    },
  });
  let fillTarget = null;
  let lastPick = 0;
  // Focus that follows a click or a key press is the person's; focus that
  // arrives on its own (the chrome handing the page back after its card
  // closes) must not ask again, or the card would never stay closed.
  let lastInteraction = 0;
  const noteInteraction = () => {
    lastInteraction = Date.now();
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
  // Focus on a login field with several logins known: let the person pick.
  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLInputElement)) return;
      const password = el.type === "password" ? el : passwordFields().find((p) => usernameFor(p) === el);
      if (!password) return;
      ask();
      if (Date.now() - lastInteraction > 1500) return;
      if (!candidates || candidates.length === 0) return;
      if (candidates.length === 1) {
        if (!password.value) requestFill(password, candidates[0].id);
        return;
      }
      // One ask per focus burst: clicking the chrome's card refocuses the
      // page field, which must not open a second card.
      if (Date.now() - lastPick < 3000) return;
      lastPick = Date.now();
      fillTarget = password;
      send({ kind: "pick", url: location.href, usernames: candidates.map((c) => c.username) });
    },
    true,
  );
  // A submitted form with a password: the chrome may offer to save it.
  const report = (form) => {
    const password = [...form.querySelectorAll('input[type="password"]')].find((p) => p.value);
    if (!password) return;
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
  // the form's button is the next best signal.
  document.addEventListener(
    "click",
    (e) => {
      const button = e.target instanceof Element ? e.target.closest("button, input[type=submit]") : null;
      if (button && button.form) report(button.form);
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
