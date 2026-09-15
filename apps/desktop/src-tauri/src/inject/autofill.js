// Fill a checkout form with a saved address or card.
//
// Fields are matched on `autocomplete` first, which is what the standard is
// for, and on the shape of the name/id/placeholder otherwise, which is what
// most checkouts actually have. Nothing here reads a form or reports one: it
// only writes what the person picked, once, when they picked it.

(function () {
  if (window.__diveAutofillInstalled) return;
  window.__diveAutofillInstalled = true;

  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && !el.disabled && !el.readOnly;
  };

  const fields = () =>
    [...document.querySelectorAll("input, select, textarea")].filter(
      (el) => visible(el) && !/^(hidden|password|submit|button|checkbox|radio|file|image)$/i.test(el.type || ""),
    );

  /** Everything a field says about itself, lower-cased. */
  const marks = (el) =>
    [el.autocomplete, el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.labels?.[0]?.textContent]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

  // `autocomplete` token first; the patterns are the fallback for forms that
  // declare nothing, which is most of them.
  const MATCHERS = {
    name: [/\b(name|cc-name)\b/, /(full[\s_-]?name|your[\s_-]?name|recipient)/],
    "given-name": [/\bgiven-name\b/, /(first[\s_-]?name|forename|fname)/],
    "family-name": [/\bfamily-name\b/, /(last[\s_-]?name|surname|lname)/],
    organization: [/\borganization\b/, /(company|organisation|business)/],
    "address-line1": [/\b(address-line1|street-address)\b/, /(address[\s_-]?1|street|addr1|address$)/],
    "address-line2": [/\baddress-line2\b/, /(address[\s_-]?2|apartment|suite|unit|addr2)/],
    "address-level2": [/\baddress-level2\b/, /\b(city|town|suburb|locality)\b/],
    "address-level1": [/\baddress-level1\b/, /\b(state|province|region|county)\b/],
    "postal-code": [/\bpostal-code\b/, /(post(al)?[\s_-]?code|zip)/],
    country: [/\bcountry(-name)?\b/, /\bcountry\b/],
    tel: [/\btel\b/, /(phone|mobile|telephone)/],
    email: [/\bemail\b/, /e-?mail/],
    "cc-name": [/\bcc-name\b/, /(card[\s_-]?holder|name[\s_-]?on[\s_-]?card)/],
    "cc-number": [/\bcc-number\b/, /(card[\s_-]?number|cardnum|ccnum|creditcard)/],
    "cc-exp-month": [/\bcc-exp-month\b/, /(exp[\s_-]?month|expiry[\s_-]?month|exp-mm|month)/],
    "cc-exp-year": [/\bcc-exp-year\b/, /(exp[\s_-]?year|expiry[\s_-]?year|exp-yy|year)/],
    "cc-exp": [/\bcc-exp\b/, /(expiry|expiration|exp[\s_-]?date)/],
  };

  /** The first field that looks like `kind`, skipping ones already filled. */
  const find = (kind, used) => {
    const [token, pattern] = MATCHERS[kind];
    const candidates = fields().filter((el) => !used.has(el));
    return candidates.find((el) => token.test((el.autocomplete || "").toLowerCase())) || (pattern && candidates.find((el) => pattern.test(marks(el))));
  };

  /** Write a value the way a framework-backed input will notice. */
  const set = (el, value) => {
    if (value === undefined || value === null || value === "") return false;
    const text = String(value);
    if (el.tagName === "SELECT") {
      const wanted = text.toLowerCase();
      const option = [...el.options].find((o) => o.value.toLowerCase() === wanted || o.text.toLowerCase() === wanted || o.text.toLowerCase().startsWith(wanted));
      if (!option) return false;
      el.value = option.value;
    } else {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
      if (setter) setter.call(el, text);
      else el.value = text;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };

  const fill = (pairs) => {
    const used = new Set();
    let filled = 0;
    for (const [kind, value] of pairs) {
      if (!value) continue;
      const field = find(kind, used);
      if (!field) continue;
      if (set(field, value)) {
        used.add(field);
        filled += 1;
      }
    }
    return filled;
  };

  window.__diveFillAddress = (address) => {
    const [first, ...rest] = (address.name || "").split(/\s+/);
    const lines = (address.street || "").split(/\n+/);
    return {
      filled: fill([
        ["name", address.name],
        ["given-name", first],
        ["family-name", rest.join(" ")],
        ["organization", address.organization],
        ["address-line1", lines[0]],
        ["address-line2", lines.slice(1).join(" ")],
        ["address-level2", address.city],
        ["address-level1", address.region],
        ["postal-code", address.postal_code],
        ["country", address.country],
        ["tel", address.phone],
        ["email", address.email],
      ]),
    };
  };

  window.__diveFillCard = (card) => {
    const month = String(card.expiry_month).padStart(2, "0");
    const year = String(card.expiry_year);
    return {
      filled: fill([
        ["cc-name", card.cardholder],
        ["cc-number", card.number],
        ["cc-exp-month", month],
        ["cc-exp-year", year],
        ["cc-exp", `${month}/${year.slice(-2)}`],
      ]),
    };
  };
})();
