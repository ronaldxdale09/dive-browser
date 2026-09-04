import { afterEach, describe, expect, it } from "vitest";
import source from "../../src-tauri/src/inject/activity-guard.js?raw";

type Snapshot = { known: boolean; reasons: string[]; scroll: number[]; url: string };
type Page = Window & { __diveActivitySnapshot?: () => Snapshot; __diveActivityChanged?: (payload: string) => void };

function install(page?: Page) {
  if (!page) {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    page = frame.contentWindow as Page;
  }
  const signals: string[] = [];
  page.__diveActivityChanged = (payload) => signals.push(payload);
  Object.defineProperty(page.document, "readyState", { configurable: true, value: "loading" });
  new Function("window", "document", "navigator", source.replaceAll("__NONCE__", '"test-nonce"'))(page, page.document, page.navigator);
  Object.defineProperty(page.document, "readyState", { configurable: true, value: "complete" });
  return { page, signals, snapshot: () => page.__diveActivitySnapshot!() };
}

afterEach(() => { document.body.innerHTML = ""; });

describe("discard activity guard", () => {
  it("allows an idle fully observed page and protects dirty form state", () => {
    const { page, snapshot, signals } = install();
    expect(snapshot()).toMatchObject({ known: true, reasons: [], scroll: [0, 0] });
    page.document.body.innerHTML = '<input value="saved">';
    const input = page.document.querySelector("input")!;
    input.value = "unsaved";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(snapshot().reasons).toContain("unsaved_form");
    expect(signals.length).toBeGreaterThan(0);
  });

  it("protects playing media in an observed child frame", () => {
    const { page, snapshot } = install();
    const child = page.document.createElement("iframe");
    page.document.body.append(child);
    const nested = install(child.contentWindow as Page);
    nested.page.document.body.innerHTML = "<video></video>";
    const media = nested.page.document.querySelector("video")!;
    Object.defineProperties(media, { paused: { value: false }, ended: { value: false } });
    expect(snapshot().reasons).toContain("media");
  });

  it("keeps inaccessible and not-yet-observed frames instead of guessing idle", () => {
    const { page, snapshot } = install();
    const child = page.document.createElement("iframe");
    page.document.body.append(child);
    expect(snapshot().known).toBe(false);
    Object.defineProperty(child, "contentWindow", { configurable: true, get() { throw new Error("cross origin"); } });
    expect(snapshot().known).toBe(false);
    Reflect.deleteProperty(child, "contentWindow");
  });

  it("protects WebAudio and live WebRTC objects, releasing closed objects", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const page = frame.contentWindow as Page;
    class Audio extends EventTarget {
      state = "running";
      close() { this.state = "closed"; this.dispatchEvent(new Event("statechange")); }
    }
    class Peer extends EventTarget {
      connectionState = "connected";
      close() { this.connectionState = "closed"; this.dispatchEvent(new Event("connectionstatechange")); }
    }
    const native = page as unknown as { AudioContext: typeof Audio; RTCPeerConnection: typeof Peer };
    native.AudioContext = Audio;
    native.RTCPeerConnection = Peer;
    const { snapshot } = install(page);
    const audio = new native.AudioContext();
    const peer = new native.RTCPeerConnection();
    expect(snapshot().reasons).toEqual(expect.arrayContaining(["web_audio", "webrtc"]));
    audio.close();
    peer.close();
    expect(snapshot().reasons).toEqual([]);
  });

  it("protects pending capture and live capture tracks until they end", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const page = frame.contentWindow as Page;
    let resolve!: (value: { getTracks: () => Track[] }) => void;
    class Track extends EventTarget { readyState = "live"; }
    const track = new Track();
    const devices = { getUserMedia: () => new Promise<{ getTracks: () => Track[] }>((done) => { resolve = done; }) };
    Object.defineProperty(page.navigator, "mediaDevices", { value: devices });
    const { snapshot } = install(page);
    const request = devices.getUserMedia();
    expect(snapshot().reasons).toContain("capture");
    resolve({ getTracks: () => [track] });
    await request;
    expect(snapshot().reasons).toContain("capture");
    track.readyState = "ended";
    track.dispatchEvent(new Event("ended"));
    expect(snapshot().reasons).toEqual([]);
  });

  it("protects detached audio and legacy capture calls", () => {
    const frame = document.createElement("iframe"); document.body.append(frame);
    const page = frame.contentWindow as Page;
    const media = page.document.createElement("audio");
    Object.defineProperties(media, { paused: { value: false }, ended: { value: false } });
    Object.defineProperty(page, "Audio", { value: function () { return media; }, writable: true });
    const navigator = page.navigator as Navigator & { webkitGetUserMedia: (...args: unknown[]) => void };
    navigator.webkitGetUserMedia = () => undefined;
    const { snapshot } = install(page);
    new (page as unknown as { Audio: new () => HTMLAudioElement }).Audio();
    expect(snapshot().reasons).toContain("media");
    navigator.webkitGetUserMedia({}, () => {}, () => {});
    expect(snapshot().reasons).toContain("capture");
  });

  it("treats replaced instrumentation as unknown", () => {
    const { page, snapshot } = install();
    (page as unknown as { Element: typeof Element }).Element.prototype.attachShadow = (() => { throw new Error("replacement"); }) as typeof Element.prototype.attachShadow;
    expect(snapshot().known).toBe(false);
  });

  it("protects unload handlers and closed shadow content", () => {
    const { page, snapshot } = install();
    page.onbeforeunload = () => "unsaved";
    expect(snapshot().reasons).toContain("beforeunload");
    page.onbeforeunload = null;
    const host = page.document.createElement("div");
    page.document.body.append(host);
    host.attachShadow({ mode: "closed" });
    expect(snapshot().known).toBe(false);
  });
});
