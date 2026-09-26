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
});
