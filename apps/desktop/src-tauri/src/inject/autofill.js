// Fill a checkout form with a saved address or card.
//
// Fields are matched on `autocomplete` first, which is what the standard is
// for, and on the shape of the name/id/placeholder otherwise, which is what
// most checkouts actually have. Nothing here reads a form or reports one: it
// only writes what the person picked, once, when they picked it.
//
// It runs in Dive's isolated world (see page_world.rs). In the page's own
// world, a page could define `__diveFillCard` before this did, mark the
// script installed, and be handed the card. The host also asks first which
// kinds of field the page has, and sends only the values those take: a page
// with no card-number field is never sent a card number.

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

  // The field names the autofill standard defines. Anything else in an
  // `autocomplete` attribute ("nope", "false", a random string) is a site
  // trying to switch autofill off, and says nothing about what the field is.
  const FIELD_NAMES = new Set([
    "name", "honorific-prefix", "given-name", "additional-name", "family-name", "honorific-suffix", "nickname", "username", "new-password",
    "current-password", "one-time-code", "organization-title", "organization", "street-address", "address-line1", "address-line2", "address-line3",
    "address-level4", "address-level3", "address-level2", "address-level1", "country", "country-name", "postal-code", "cc-name", "cc-given-name",
    "cc-additional-name", "cc-family-name", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "cc-type", "transaction-currency",
    "transaction-amount", "language", "bday", "bday-day", "bday-month", "bday-year", "sex", "url", "photo", "tel", "tel-country-code",
    "tel-national", "tel-area-code", "tel-local", "tel-local-prefix", "tel-local-suffix", "tel-extension", "email", "impp"
  ]);

  /** The field name an `autocomplete` attribute declares, or "" for none ("on", "off", unknown words, absent). */
  const purpose = (el) => {
    const tokens = (el.getAttribute("autocomplete") || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
    const named = tokens.filter((t) => !t.startsWith("section-") && !["shipping", "billing", "home", "work", "mobile", "fax", "pager", "webauthn", "on", "off"].includes(t) && FIELD_NAMES.has(t));
    return named[named.length - 1] || "";
  };

  // Each kind lists the exact `autocomplete` field names it takes, then a
  // fallback pattern for forms that declare nothing, which is most of them.
  // A declared field name is matched whole, never as a piece of another one.
  const MATCHERS = {
    name: [["name"], /(full[\s_-]?name|your[\s_-]?name|recipient)/],
    "given-name": [["given-name"], /(first[\s_-]?name|forename|fname)/],
    "family-name": [["family-name"], /(last[\s_-]?name|surname|lname)/],
    organization: [["organization"], /(company|organisation|business)/],
    "address-line1": [["address-line1", "street-address"], /(address[\s_-]?1|street|addr1|address$)/],
    "address-line2": [["address-line2"], /(address[\s_-]?2|apartment|suite|unit|addr2)/],
    "address-level2": [["address-level2"], /\b(city|town|suburb|locality)\b/],
    "address-level1": [["address-level1"], /\b(state|province|region|county)\b/],
    "postal-code": [["postal-code"], /(post(al)?[\s_-]?code|zip)/],
    country: [["country", "country-name"], /\bcountry\b/],
    tel: [["tel", "tel-national"], /(phone|mobile|telephone)/],
    email: [["email"], /e-?mail/],
    "cc-name": [["cc-name"], /(card[\s_-]?holder|name[\s_-]?on[\s_-]?card)/],
    "cc-number": [["cc-number"], /(card[\s_-]?number|cardnum|ccnum|creditcard)/],
    "cc-exp-month": [["cc-exp-month"], /(exp[\s_-]?month|expiry[\s_-]?month|exp-mm|month)/],
    "cc-exp-year": [["cc-exp-year"], /(exp[\s_-]?year|expiry[\s_-]?year|exp-yy|year)/],
    "cc-exp": [["cc-exp"], /(expiry|expiration|exp[\s_-]?date)/],
  };

  /** The first field that looks like `kind`, skipping ones already filled. */
  const find = (kind, used) => {
    const [names, pattern] = MATCHERS[kind];
    const candidates = fields().filter((el) => !used.has(el));
    const declared = candidates.find((el) => names.includes(purpose(el)));
    if (declared) return declared;
    // The patterns are for fields that declare nothing. A field that says
    // what it is (given-name, bday-month, ...) is never taken for something else.
    return pattern ? candidates.find((el) => !purpose(el) && pattern.test(marks(el))) : undefined;
  };

  /** Write a value the way a framework-backed input will notice. */
  const set = (el, value) => {
    if (value === undefined || value === null || value === "") return false;
    const text = String(value);
    if (el.tagName === "SELECT") {
      const wanted = text.trim().toLowerCase();
      const options = [...el.options].filter((o) => !o.disabled);
      // An exact value or label anywhere in the list beats a prefix: "CA" is
      // Canada's code, not the start of "Cambodia".
      let option = options.find((o) => o.value.trim().toLowerCase() === wanted) || options.find((o) => o.text.trim().toLowerCase() === wanted);
      if (!option && wanted.length >= 3) {
        const prefixed = options.filter((o) => o.text.trim().toLowerCase().startsWith(wanted));
        if (prefixed.length === 1) option = prefixed[0];
      }
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

  // Which of `kinds` the page has a field for, by the same matching a fill
  // uses.
  window.__diveAutofillKinds = (kinds) =>
    (Array.isArray(kinds) ? kinds : []).filter((kind) => Object.hasOwn(MATCHERS, kind) && find(kind, new Set()));

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
    // The host sends only what the page has fields for, so the expiry may
    // not have come at all.
    const month = card.expiry_month ? String(card.expiry_month).padStart(2, "0") : "";
    const year = card.expiry_year ? String(card.expiry_year) : "";
    return {
      filled: fill([
        ["cc-name", card.cardholder],
        ["cc-number", card.number],
        ["cc-exp-month", month],
        ["cc-exp-year", year],
        ["cc-exp", month && year ? `${month}/${year.slice(-2)}` : ""],
      ]),
    };
  };
})();
