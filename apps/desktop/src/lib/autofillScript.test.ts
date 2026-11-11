import { afterEach, describe, expect, it } from "vitest";
import source from "../../src-tauri/src/inject/autofill.js?raw";

type Page = Window &
  typeof globalThis & {
    __diveAutofillKinds: (kinds: unknown) => string[];
    __diveFillCard: (card: Record<string, unknown>) => { filled: number };
    __diveFillAddress: (address: Record<string, unknown>) => { filled: number };
  };

/** The fill script in a frame of its own, over `html`, with every field given a size. */
function install(html: string) {
  const element = document.createElement("iframe");
  document.body.append(element);
  const page = element.contentWindow as Page;
  page.HTMLElement.prototype.getBoundingClientRect = () => new page.DOMRect(0, 0, 200, 24);
  page.document.body.innerHTML = html;
  new Function("window", "document", "Event", source)(page, page.document, page.Event);
  return page;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("checkout fill script", () => {
  it("says which kinds of field the page has, so the host sends only those", () => {
    const page = install('<input autocomplete="postal-code"><input name="cardnumber" placeholder="Card number"><input type="password" name="cc-number">');
    expect(page.__diveAutofillKinds(["postal-code", "cc-number", "cc-exp", "email", "not-a-kind"])).toEqual(["postal-code", "cc-number"]);
    expect(page.__diveAutofillKinds("postal-code")).toEqual([]);
  });

  it("fills the fields it was sent and leaves the rest alone", () => {
    const page = install('<input id="name" autocomplete="cc-name"><input id="exp" autocomplete="cc-exp">');
    // Sent without its expiry, as the host sends a card to a page it was
    // told has no expiry field, the card must not write "undefined" into one.
    expect(page.__diveFillCard({ cardholder: "Dale" })).toEqual({ filled: 1 });
    expect((page.document.getElementById("name") as HTMLInputElement).value).toBe("Dale");
    expect((page.document.getElementById("exp") as HTMLInputElement).value).toBe("");
    expect(page.__diveFillCard({ expiry_month: 9, expiry_year: 2030 })).toEqual({ filled: 1 });
    expect((page.document.getElementById("exp") as HTMLInputElement).value).toBe("09/30");
  });

  const valueOf = (page: Page, id: string) => (page.document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value;
  const SPLIT_NAME = '<input id="f" autocomplete="given-name"><input id="l" autocomplete="family-name">';
  const COUNTRY = '<select id="c" autocomplete="country"><option value="KH">Cambodia</option><option value="CA">Canada</option></select>';
  const REGION =
    '<select id="s" autocomplete="address-level1"><option value="">Choose</option><option value="california">California</option><option value="colorado">Colorado</option></select>';

  it("puts the first and last name in their own fields", () => {
    const page = install(SPLIT_NAME);
    expect(page.__diveFillAddress({ name: "Ada Lovelace" })).toEqual({ filled: 2 });
    expect(valueOf(page, "f")).toBe("Ada");
    expect(valueOf(page, "l")).toBe("Lovelace");
  });

  it("reads the field name out of a sectioned autocomplete", () => {
    const page = install('<input id="f" autocomplete="shipping given-name"><input id="l" autocomplete="section-a billing family-name">');
    expect(page.__diveFillAddress({ name: "Ada Lovelace" })).toEqual({ filled: 2 });
    expect(valueOf(page, "f")).toBe("Ada");
    expect(valueOf(page, "l")).toBe("Lovelace");
  });

  it("still fills a full name field", () => {
    const page = install('<input id="n" autocomplete="name">');
    page.__diveFillAddress({ name: "Ada Lovelace" });
    expect(valueOf(page, "n")).toBe("Ada Lovelace");
  });

  it("does not put a whole phone number in a part of one", () => {
    const page = install('<input id="cc" autocomplete="tel-country-code"><input id="t" autocomplete="tel">');
    page.__diveFillAddress({ phone: "+1 555 0100" });
    expect(valueOf(page, "t")).toBe("+1 555 0100");
    expect(valueOf(page, "cc")).toBe("");
  });

  it("never takes a field that declares another purpose for a pattern match", () => {
    const page = install('<input id="b" autocomplete="bday-month" name="month"><input id="m" name="exp-month">');
    page.__diveFillCard({ expiry_month: 9, expiry_year: 2030 });
    expect(valueOf(page, "b")).toBe("");
    expect(valueOf(page, "m")).toBe("09");
  });

  it("matches undeclared fields by their names, and fields set to autocomplete off", () => {
    const page = install('<input id="first" name="first_name"><input id="last" name="last_name" autocomplete="off">');
    page.__diveFillAddress({ name: "Ada Lovelace" });
    expect(valueOf(page, "first")).toBe("Ada");
    expect(valueOf(page, "last")).toBe("Lovelace");
  });

  it("ignores autocomplete words that are not field names, and leaves password fields alone", () => {
    const page = install('<input id="first" autocomplete="nope" name="first_name"><input id="last" autocomplete="new-password" name="last_name">');
    expect(page.__diveFillAddress({ name: "Ada Lovelace" })).toEqual({ filled: 1 });
    expect(valueOf(page, "first")).toBe("Ada");
    expect(valueOf(page, "last")).toBe("");
  });

  it("prefers an exact option over an earlier prefix match", () => {
    const page = install(COUNTRY);
    expect(page.__diveFillAddress({ country: "CA" })).toEqual({ filled: 1 });
    expect(valueOf(page, "c")).toBe("CA");
  });

  it("matches an option by its exact label", () => {
    const page = install(COUNTRY);
    page.__diveFillAddress({ country: "Canada" });
    expect(valueOf(page, "c")).toBe("CA");
  });

  it("uses a prefix only when it names one option", () => {
    const page = install(REGION);
    expect(page.__diveFillAddress({ region: "Calif" })).toEqual({ filled: 1 });
    expect(valueOf(page, "s")).toBe("california");
    const short = install(REGION);
    expect(short.__diveFillAddress({ region: "Ca" })).toEqual({ filled: 0 });
    expect(valueOf(short, "s")).toBe("");
  });

  it("fills nothing when a prefix fits several options", () => {
    const page = install('<select id="s" autocomplete="address-level1"><option value="">Choose</option><option value="nm">New Mexico</option><option value="ny">New York</option></select>');
    expect(page.__diveFillAddress({ region: "New" })).toEqual({ filled: 0 });
    expect(valueOf(page, "s")).toBe("");
  });

  it("reports a declared first name field as a first name, not a full name", () => {
    const page = install(SPLIT_NAME);
    expect(page.__diveAutofillKinds(["given-name", "name"])).toEqual(["given-name"]);
  });
});
