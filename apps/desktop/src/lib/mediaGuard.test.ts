import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import source from "../../src-tauri/src/inject/media-guard.js?raw";

// Each installation gets its own page globals, just as a new execution context
// does. The real injected script wraps these native-media boundary fakes.
function install(binding?: (payload: string) => void) {
  const requests: { id: number; kind: string }[] = [];
  const nativeUserMedia = vi.fn(async () => "camera stream");
  const nativeDisplayMedia = vi.fn(async () => "display stream");
  const media: {
    getUserMedia: (constraints: MediaStreamConstraints) => Promise<string>;
    getDisplayMedia: (constraints: DisplayMediaStreamOptions) => Promise<string>;
  } = { getUserMedia: nativeUserMedia, getDisplayMedia: nativeDisplayMedia };
  const page: {
    __divePermissionRequest: (payload: string) => void;
    __divePermissionResolve: (id: number, allowed: boolean) => void;
  } = {
    __divePermissionRequest: binding ?? ((payload: string) => requests.push(JSON.parse(payload))),
    __divePermissionResolve: () => {},
  };
  const script = source.replaceAll("__NONCE__", '"test"').replaceAll("__BINDING__", "__divePermissionRequest");
  new Function("navigator", "window", script)({ mediaDevices: media }, page);
  return { media, page, requests, nativeUserMedia, nativeDisplayMedia };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("media permission request lifetime", () => {
  it("denies a lost reply by the deadline and ignores a late grant", async () => {
    const { media, page, requests, nativeUserMedia } = install();
    let outcome: unknown;
    const request = media.getUserMedia({ video: true }).catch((error: unknown) => { outcome = error; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(outcome).toMatchObject({ name: "NotAllowedError" });
    await request;
    page.__divePermissionResolve(requests[0]!.id, true);
    expect(nativeUserMedia).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases successful request deadlines before invoking native media", async () => {
    const { media, page, requests, nativeUserMedia } = install();
    const request = media.getUserMedia({ video: true, audio: true });
    expect(requests.map((request) => request.kind)).toEqual(["camera", "microphone"]);
    page.__divePermissionResolve(requests[0]!.id, true);
    page.__divePermissionResolve(requests[1]!.id, true);
    await expect(request).resolves.toBe("camera stream");
    expect(nativeUserMedia).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed and releases the deadline when the binding throws", async () => {
    const { media, nativeDisplayMedia } = install(() => { throw new Error("binding unavailable"); });
    await expect(media.getDisplayMedia({ video: true })).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(vi.getTimerCount()).toBe(0);
    expect(nativeDisplayMedia).not.toHaveBeenCalled();
  });
});
