import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import audioSource from "../../src-tauri/src/inject/audio.js?raw";
import credentialsSource from "../../src-tauri/src/inject/credentials.js?raw";

// Both scripts run in the top frame only; the tests host them in an iframe.
const mainFrameOnly = /if \(window\.top !== window\) return;[^\n]*\n/;

type Page = Window & typeof globalThis & Record<string, unknown>;

function frame() {
  const element = document.createElement("iframe");
  document.body.append(element);
  return element.contentWindow as Page;
}

/**
 * The frame's document, as the scripts see it, with a way to mark an event
 * as the person's. jsdom makes every dispatched event untrusted, the way a
 * page's own are; a listener registered through this document sees an event
 * passed to `trust` with `isTrusted` true instead.
 */
function trusting(page: Page) {
  const trusted = new WeakSet<Event>();
  const bind = (target: object, value: unknown) => (typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value);
  const view = (event: Event) =>
    trusted.has(event) ? new Proxy(event, { get: (target, key) => (key === "isTrusted" ? true : bind(target, Reflect.get(target, key, target))) }) : event;
  const document = new Proxy(page.document, {
    get(target, key) {
      if (key === "addEventListener") {
        return (type: string, listener: (event: Event) => void, options?: AddEventListenerOptions | boolean) =>
          target.addEventListener(type, (event) => listener(view(event)), options);
      }
      return bind(target, Reflect.get(target, key, target));
    },
  });
  const trust = <E extends Event>(event: E) => {
    trusted.add(event);
    return event;
  };
  return { document, trust };
}

/** Everything a script reads from its window, taken from the frame's. */
function run(page: Page, source: string, document: Document) {
  const names = ["window", "document", "MutationObserver", "HTMLInputElement", "HTMLFormElement", "Element", "Node", "Event", "getComputedStyle", "innerWidth", "innerHeight", "addEventListener"];
  const values = [page, document, page.MutationObserver, page.HTMLInputElement, page.HTMLFormElement, page.Element, page.Node, page.Event, page.getComputedStyle.bind(page), 1024, 768, page.addEventListener.bind(page)];
  new Function(...names, source)(...values);
}

/** Fields that have a size, which jsdom's layout never gives them. */
function laidOut(page: Page) {
  page.HTMLElement.prototype.getBoundingClientRect = () => new page.DOMRect(10, 10, 200, 24);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("audible-tab watcher", () => {
  function install() {
    const page = frame();
    const sent: boolean[] = [];
    page.__diveAudio = (payload: string) => sent.push(JSON.parse(payload).audible);
    const source = audioSource
      .replace(mainFrameOnly, "")
      .replaceAll("__NONCE__", '"n"')
      .replaceAll("__BINDING__", "__diveAudio");
    new Function("window", "document", "addEventListener", source)(page, page.document, page.addEventListener.bind(page));
    return { page, sent };
  }

  it("hears a player through the document's media events, with no observer", () => {
    const { page, sent } = install();
    const video = page.document.createElement("video");
    page.document.body.append(video);
    let paused = true;
    Object.defineProperty(video, "paused", { get: () => paused });
    paused = false;
    video.dispatchEvent(new Event("play"));
    vi.advanceTimersByTime(300);
    expect(sent).toEqual([true]);
    // Once seen, the player is watched directly: it is still heard after it
    // has left the document.
    video.remove();
    paused = true;
    video.dispatchEvent(new Event("pause"));
    vi.advanceTimersByTime(300);
    expect(sent).toEqual([true, false]);
  });
});

describe("saved-login watcher", () => {
  it("asks about a login form once, and stops watching the page when the site has no logins", async () => {
    const page = frame();
    const sent: { kind: string }[] = [];
    page.__diveLogins = (payload: string) => sent.push(JSON.parse(payload));
    const Native = page.MutationObserver as typeof MutationObserver;
    let watching = 0;
    let batches = 0;
    class Counting extends Native {
      constructor(callback: MutationCallback) {
        super((records, observer) => {
          batches += 1;
          callback(records, observer);
        });
      }
      observe(target: Node, options?: MutationObserverInit) {
        watching += 1;
        super.observe(target, options);
      }
      disconnect() {
        watching = 0;
        super.disconnect();
      }
    }
    const source = credentialsSource
      .replace(mainFrameOnly, "")
      .replaceAll("__NONCE__", '"n"')
      .replaceAll("__BINDING__", "__diveLogins");
    new Function("window", "document", "MutationObserver", source)(page, page.document, Counting);
    expect(watching).toBe(1);
    // Unrelated changes are not a login form.
    page.document.body.append(page.document.createElement("div"));
    await Promise.resolve();
    expect(sent).toEqual([]);
    const form = page.document.createElement("form");
    form.innerHTML = '<input name="user"><input type="password">';
    page.document.body.append(form);
    await Promise.resolve();
    expect(sent.map((p) => p.kind)).toEqual(["query"]);
    (page.__diveCredentialsOffer as (nonce: string, list: unknown[]) => void)("n", []);
    expect(watching).toBe(0);
    const before = batches;
    page.document.body.append(page.document.createElement("div"));
    await Promise.resolve();
    expect(batches).toBe(before);
  });

  function logins(saved: { id: string; username: string }[]) {
    const page = frame();
    laidOut(page);
    const sent: { kind: string; id?: string }[] = [];
    page.__diveLogins = (payload: string) => sent.push(JSON.parse(payload));
    const { document, trust } = trusting(page);
    const source = credentialsSource.replace(mainFrameOnly, "").replaceAll("__NONCE__", '"n"').replaceAll("__BINDING__", "__diveLogins");
    page.document.body.innerHTML = '<form><input name="user" id="user"><input type="password" id="pass"></form>';
    run(page, source, document);
    expect(sent.map((p) => p.kind)).toEqual(["query"]);
    (page.__diveCredentialsOffer as (nonce: string, list: unknown[]) => void)("n", saved);
    const user = page.document.getElementById("user") as HTMLInputElement;
    const pass = page.document.getElementById("pass") as HTMLInputElement;
    const fills = () => sent.filter((p) => p.kind === "fill");
    return { page, sent, fills, trust, user, pass };
  }

  it("fills a lone login only after the person pressed on the field", () => {
    const { page, fills, trust, pass } = logins([{ id: "l1", username: "dale" }]);
    // The form is there and one login is saved: nothing happens on its own.
    expect(fills()).toEqual([]);
    // A press the page dispatched, then focus the page moved there itself.
    pass.dispatchEvent(new page.MouseEvent("pointerdown", { bubbles: true }));
    pass.focus();
    expect(fills()).toEqual([]);
    pass.blur();
    // The person's own press on the field.
    pass.dispatchEvent(trust(new page.MouseEvent("pointerdown", { bubbles: true })));
    pass.focus();
    expect(fills()).toEqual([{ kind: "fill", id: "l1", nonce: "n" }]);
  });

  it("does not fill a field the page focused after a press somewhere else", () => {
    const { page, fills, trust, pass } = logins([{ id: "l1", username: "dale" }]);
    page.document.body.dispatchEvent(trust(new page.MouseEvent("pointerdown", { bubbles: true })));
    pass.focus();
    expect(fills()).toEqual([]);
  });

  it("lets only the person's own keys pick from the list", () => {
    const { page, fills, trust, user } = logins([
      { id: "l1", username: "dale" },
      { id: "l2", username: "dee" },
    ]);
    user.dispatchEvent(trust(new page.MouseEvent("pointerdown", { bubbles: true })));
    user.focus();
    const list = page.document.querySelector("dive-saved-logins") as HTMLElement;
    expect(list.style.display).toBe("block");
    // Keys the page dispatched walk nothing and pick nothing.
    user.dispatchEvent(new page.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    user.dispatchEvent(new page.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(fills()).toEqual([]);
    user.dispatchEvent(trust(new page.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    user.dispatchEvent(trust(new page.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(fills()).toEqual([{ kind: "fill", id: "l1", nonce: "n" }]);
  });
});

