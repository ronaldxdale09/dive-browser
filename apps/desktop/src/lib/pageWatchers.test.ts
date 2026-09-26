import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import audioSource from "../../src-tauri/src/inject/audio.js?raw";
import credentialsSource from "../../src-tauri/src/inject/credentials.js?raw";

// Both scripts run in the top frame only; the tests host them in an iframe.
const mainFrameOnly = /if \(window\.top !== window\) return;[^\n]*\n/;

function frame() {
  const element = document.createElement("iframe");
  document.body.append(element);
  return element.contentWindow as Window & Record<string, unknown>;
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
});
