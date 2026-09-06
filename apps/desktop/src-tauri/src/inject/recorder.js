// Reports the person's own clicks and committed text input, so a manual flow
// can become a Playwright test or a macro.
//
// Steps are described by role and accessible name, which is also how the
// locator engine addresses elements. Sharing role-name.js is what makes a
// recorded step replayable as `role=button[name="Save"]`.
//
// @dive-include role-name.js

(function () {
  if (window.top !== window) return; // main frame only: never read inside cross-origin iframes
  const NONCE = __NONCE__;
  // The nonce never sits on `window` where page script could read it and
  // forge steps. `window.__diveRecorderNonce` is an accessor owned by the
  // first install: the host writes a new nonce through it on restart and
  // `null` to stop, and reading it only says whether recording is armed.
  let nonce = null;
  const armed = Object.getOwnPropertyDescriptor(window, "__diveRecorderNonce");
  if (!armed || armed.configurable) {
    try {
      Object.defineProperty(window, "__diveRecorderNonce", {
        configurable: false,
        enumerable: false,
        get: () => (nonce ? true : null),
        set: (value) => {
          nonce = typeof value === "string" && value ? value : null;
        },
      });
    } catch {
      return; // the page pinned the name first; do not hand it a nonce
    }
  } else if (!window.__diveRecorderInstalled) {
    return; // a non-configurable property that is not ours: page interference
  }
  window.__diveRecorderNonce = NONCE;
  if (window.__diveRecorderInstalled) return;
  window.__diveRecorderInstalled = true;

  const send = (payload) => {
    try {
      if (!nonce) return;
      payload.nonce = nonce;
      window.__BINDING__(JSON.stringify(payload));
    } catch {
      // A page that has broken JSON or the binding is not worth a step.
    }
  };

  const secret = (el) =>
    el.type === "password" || /password|cc-|one-time-code/i.test(el.autocomplete || "");

  // Roles worth a step. `roleOf` also names landmarks, headings and list
  // items, which are not things a person clicks on purpose, so the walk up
  // the tree keeps going past them instead of recording the container.
  const INTERACTIVE = new Set([
    "link", "button", "checkbox", "radio", "switch", "searchbox", "textbox",
    "combobox", "listbox", "option", "tab", "menuitem", "menuitemcheckbox",
    "menuitemradio", "slider", "spinbutton",
  ]);

  const target = (el) => {
    while (el && el !== document.body) {
      if (INTERACTIVE.has(roleOf(el))) return el;
      el = el.parentElement;
    }
    return null;
  };

  document.addEventListener(
    "click",
    (e) => {
      const el = target(e.target);
      if (!el) return;
      const role = roleOf(el);
      // Focusing a field is not a step; the committed value is, via `change`.
      if (role === "textbox" || role === "searchbox" || role === "combobox") return;
      send({ kind: "click", role, name: nameOf(el), value: "", at: Date.now() });
    },
    true,
  );

  document.addEventListener(
    "change",
    (e) => {
      const el = e.target;
      const role = roleOf(el);
      if (!INTERACTIVE.has(role)) return;
      if (role === "checkbox" || role === "radio" || role === "switch") {
        send({ kind: "click", role, name: nameOf(el), value: "", at: Date.now() });
        return;
      }
      send({
        kind: "type",
        role,
        name: nameOf(el),
        value: secret(el) ? "" : String(el.value || "").slice(0, __MAX_FIELD__),
        masked: secret(el),
        at: Date.now(),
      });
    },
    true,
  );
})();
