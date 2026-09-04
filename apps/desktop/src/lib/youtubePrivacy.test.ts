import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import privacySource from "../../src-tauri/src/inject/youtube_privacy.js?raw";

interface DivePrivacy {
  install(): void;
  configure(options: { enabled: boolean; cosmeticCss?: string }): void;
  dispose(): void;
  sanitize(value: unknown): unknown;
}

declare global {
  interface Window {
    __divePrivacy?: DivePrivacy;
  }
}

const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function evaluate(): DivePrivacy {
  eval(privacySource);
  const privacy = window.__divePrivacy;
  if (!privacy) throw new Error("YouTube privacy script did not install its API");
  return privacy;
}

describe("YouTube privacy page script", () => {
  let nativeFetch: typeof window.fetch;
  let nativeOpen: typeof XMLHttpRequest.prototype.open;
  let nativeSend: typeof XMLHttpRequest.prototype.send;

  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    window.__divePrivacy?.dispose();
    delete window.__divePrivacy;
    nativeFetch = vi.fn(async () => new Response("{}")) as typeof window.fetch;
    Object.defineProperty(window, "fetch", {
      configurable: true,
      writable: true,
      value: nativeFetch,
    });
    nativeOpen = XMLHttpRequest.prototype.open;
    nativeSend = XMLHttpRequest.prototype.send;
  });

  afterEach(() => {
    window.__divePrivacy?.dispose();
    delete window.__divePrivacy;
    Object.defineProperty(window, "fetch", {
      configurable: true,
      writable: true,
      value: nativeFetch,
    });
    XMLHttpRequest.prototype.open = nativeOpen;
    XMLHttpRequest.prototype.send = nativeSend;
  });

  it("removes only YouTube ad metadata at every object depth", () => {
    const privacy = evaluate();

    expect(
      privacy.sanitize({
        adPlacements: [1],
        videoDetails: { videoId: "abc", playerAds: [2] },
        nested: [{ adSlots: [3], keep: true }],
      }),
    ).toEqual({
      videoDetails: { videoId: "abc" },
      nested: [{ keep: true }],
    });
    expect(privacy.sanitize("not-an-object")).toBe("not-an-object");
  });

  it("installs once and restores the captured browser functions on dispose", () => {
    const privacy = evaluate();
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    privacy.install();
    const wrappedFetch = window.fetch;
    const wrappedOpen = XMLHttpRequest.prototype.open;
    const wrappedSend = XMLHttpRequest.prototype.send;
    privacy.install();

    expect(window.fetch).toBe(wrappedFetch);
    expect(XMLHttpRequest.prototype.open).toBe(wrappedOpen);
    expect(XMLHttpRequest.prototype.send).toBe(wrappedSend);
    privacy.dispose();
    expect(window.fetch).toBe(nativeFetch);
    expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
    expect(XMLHttpRequest.prototype.send).toBe(originalSend);
  });

  it("owns one marked cosmetic style and removes it when disabled", () => {
    const privacy = evaluate();

    privacy.configure({ enabled: false, cosmeticCss: "#tads { display: none !important; }" });
    const style = document.querySelector("style[data-dive-privacy]");
    expect(style?.textContent).toBe("#tads { display: none !important; }");
    privacy.configure({ enabled: false });

    expect(document.querySelector("style[data-dive-privacy]")).toBeNull();
  });

  it("sanitizes only same-origin player fetch responses and fails open", async () => {
    const untouched = new Response("not json", { status: 200 });
    const delegated: Array<{ receiver: unknown; input: RequestInfo | URL; init?: RequestInit }> = [];
    nativeFetch = vi.fn(function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      delegated.push({ receiver: this, input, ...(init ? { init } : {}) });
      if (String(input).includes("invalid")) return Promise.resolve(untouched);
      return Promise.resolve(
        new Response(JSON.stringify({ adPlacements: [1], videoDetails: { videoId: "abc" } }), {
          status: 201,
          statusText: "Created",
          headers: { "content-type": "application/json", "x-test": "kept" },
        }),
      );
    }) as typeof window.fetch;
    window.fetch = nativeFetch;
    const privacy = evaluate();
    privacy.configure({ enabled: true });

    const init = { method: "POST" };
    const ordinary = await window.fetch("/browse", init);
    const player = await window.fetch("/youtubei/v1/player?prettyPrint=false", init);
    const invalid = await window.fetch("/youtubei/v1/player/invalid", init);

    expect(ordinary.status).toBe(201);
    expect(await ordinary.json()).toEqual({ adPlacements: [1], videoDetails: { videoId: "abc" } });
    expect(player.status).toBe(201);
    expect(player.statusText).toBe("Created");
    expect(player.headers.get("x-test")).toBe("kept");
    expect(await player.json()).toEqual({ videoDetails: { videoId: "abc" } });
    expect(invalid).toBe(untouched);
    expect(delegated).toEqual([
      { receiver: window, input: "/browse", init },
      { receiver: window, input: "/youtubei/v1/player?prettyPrint=false", init },
      { receiver: window, input: "/youtubei/v1/player/invalid", init },
    ]);
  });

  it("sanitizes a player XHR before page readystatechange listeners run", () => {
    const originalXhr = window.XMLHttpRequest;
    class FakeXhr extends EventTarget {
      readyState = 0;
      responseType: XMLHttpRequestResponseType = "";
      responseText = JSON.stringify({ adSlots: [1], videoDetails: { videoId: "abc" } });
      response: unknown = this.responseText;

      open(): void {}

      send(): void {
        this.readyState = 4;
        this.dispatchEvent(new Event("readystatechange"));
      }
    }
    Object.defineProperty(window, "XMLHttpRequest", {
      configurable: true,
      writable: true,
      value: FakeXhr,
    });

    let privacy: DivePrivacy | undefined;
    try {
      privacy = evaluate();
      privacy.configure({ enabled: true });
      const xhr = new window.XMLHttpRequest();
      let observed = "";
      xhr.addEventListener("readystatechange", () => {
        if (xhr.readyState === 4) observed = xhr.responseText;
      });
      xhr.open("POST", "/youtubei/v1/player");
      xhr.send("{}");

      expect(JSON.parse(observed)).toEqual({ videoDetails: { videoId: "abc" } });
    } finally {
      privacy?.dispose();
      delete window.__divePrivacy;
      Object.defineProperty(window, "XMLHttpRequest", {
        configurable: true,
        writable: true,
        value: originalXhr,
      });
    }
  });

  it("clicks a visible skip control and preserves media state when the ad ends", async () => {
    document.body.innerHTML = `
      <div class="html5-video-player ad-showing">
        <video></video>
        <button class="ytp-ad-skip-button-modern">Skip</button>
      </div>
    `;
    const video = document.querySelector("video")!;
    const skip = document.querySelector("button")!;
    const clicked = vi.fn();
    skip.addEventListener("click", clicked);
    video.volume = 0.4;
    video.muted = false;
    video.playbackRate = 1.25;

    const privacy = evaluate();
    privacy.configure({ enabled: true });
    await turn();
    document.querySelector(".html5-video-player")!.classList.remove("ad-showing");
    await turn();

    expect(clicked).toHaveBeenCalledOnce();
    expect(video.volume).toBe(0.4);
    expect(video.muted).toBe(false);
    expect(video.playbackRate).toBe(1.25);
  });

  it("accelerates only an unskippable ad and restores its media state", async () => {
    document.body.innerHTML = `
      <div class="html5-video-player ad-showing"><video></video></div>
    `;
    const player = document.querySelector(".html5-video-player")!;
    const video = document.querySelector("video")!;
    video.volume = 0.6;
    video.muted = false;
    video.playbackRate = 1.5;

    const privacy = evaluate();
    privacy.configure({ enabled: true });
    await turn();
    expect(video.muted).toBe(true);
    expect(video.playbackRate).toBeGreaterThan(1.5);

    player.classList.remove("ad-showing");
    await turn();
    expect(video.volume).toBe(0.6);
    expect(video.muted).toBe(false);
    expect(video.playbackRate).toBe(1.5);
  });
});
