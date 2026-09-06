import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportProject } from "./export";
import { newProject } from "./model";
import { useEditor } from "./store";

const mock = vi.hoisted(() => ({ begin: vi.fn(), append: vi.fn(), finish: vi.fn(), cancel: vi.fn(), draw: vi.fn() }));
vi.mock("../lib/ipc", () => ({ ipc: { screenExportBegin: mock.begin, screenExportAppend: mock.append, screenExportFinish: mock.finish, screenExportCancel: mock.cancel } }));
vi.mock("./render", () => ({ Renderer: class { draw = mock.draw; snap() {} } }));
vi.mock("webm-muxer", () => ({
  ArrayBufferTarget: class { buffer = new ArrayBuffer(8); },
  Muxer: class { addVideoChunk() {} finalize() {} },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const encoders: FakeEncoder[] = [];
let queue: number;
let flush: Promise<void>;
let encodeThrows: boolean;
let frames: FakeFrame[];
class FakeEncoder {
  static async isConfigSupported() { return { supported: true }; }
  state = "unconfigured";
  get encodeQueueSize() { return queue; }
  close = vi.fn(() => { this.state = "closed"; });
  configure() { this.state = "configured"; }
  encode() { if (encodeThrows) throw new Error("encode failed"); }
  flush = vi.fn(() => flush);
  constructor() { encoders.push(this); }
}
class FakeFrame {
  close = vi.fn();
  constructor() { frames.push(this); }
}
function video(ready = 2, seeks = true) {
  const element = document.createElement("video");
  element.src = "asset:original.webm";
  let time = 0;
  Object.defineProperty(element, "readyState", { configurable: true, value: ready });
  Object.defineProperty(element, "currentTime", {
    configurable: true,
    get: () => time,
    set: (value: number) => { time = value; if (seeks) queueMicrotask(() => element.dispatchEvent(new Event("seeked"))); },
  });
  element.pause = vi.fn();
  element.load = vi.fn();
  element.play = vi.fn().mockResolvedValue(undefined);
  return element;
}
function input(element: HTMLVideoElement | null, signal?: AbortSignal) {
  const project = newProject({ source: "original.mp4", playable: "original.webm", events: null, durationMs: 100, width: 64, height: 64 });
  return { project, playable: "asset:original.webm", cursorRaw: [], cursorSmooth: [], segments: [{ srcStartMs: 0, srcEndMs: 100, outStartMs: 0, outEndMs: 100, speed: 1 }], onProgress: vi.fn(), video: element, ...(signal ? { signal } : {}) };
}
beforeEach(() => {
  vi.useFakeTimers();
  encoders.length = 0; queue = 0; flush = Promise.resolve(); encodeThrows = false; frames = [];
  vi.stubGlobal("VideoEncoder", FakeEncoder);
  vi.stubGlobal("VideoFrame", FakeFrame);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  mock.cancel.mockResolvedValue("cancelled");
  mock.begin.mockResolvedValue("stage"); mock.append.mockResolvedValue(null); mock.finish.mockResolvedValue({ path: "output.mp4" });
});
afterEach(() => {
  delete window.__diveUiInputTimingEnabled;
  delete window.__diveScreenMediaProbe;
  document.body.replaceChildren();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks();
});

async function expectCancelled(pending: Promise<unknown>, controller: AbortController) {
  let settled = false;
  const outcome = pending.then(() => null, (error: Error) => error).then((error) => { settled = true; return error; });
  controller.abort();
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(true);
  expect((await outcome)?.message).toMatch(/cancel/i);
  expect(mock.begin).not.toHaveBeenCalled();
}

describe("export frontend ownership and bounded waits", () => {
  it("cancels media readiness and removes its callbacks", async () => {
    const element = video(0);
    const removed = vi.spyOn(element, "removeEventListener");
    const controller = new AbortController();
    await expectCancelled(exportProject(input(element, controller.signal)), controller);
    expect(removed.mock.calls.map(([name]) => name)).toEqual(expect.arrayContaining(["loadeddata", "canplay", "error"]));
    expect(element.hasAttribute("src")).toBe(true);
  });

  it("cancels a seek that never acknowledges", async () => {
    const element = video(2, false);
    const controller = new AbortController();
    const pending = exportProject(input(element, controller.signal));
    await vi.waitFor(() => expect(encoders[0]).toBeDefined());
    await expectCancelled(pending, controller);
    expect(encoders[0]?.close).toHaveBeenCalledOnce();
  });

  it.each(["drain", "flush"])("cancels encoder %s without leaking the encoder or frames", async (phase) => {
    if (phase === "drain") queue = 25;
    else flush = deferred<void>().promise;
    const controller = new AbortController();
    const pending = exportProject(input(video(), controller.signal));
    await vi.waitFor(() => {
      expect(encoders[0]).toBeDefined();
      if (phase === "flush") expect(encoders[0]?.flush).toHaveBeenCalledOnce();
    });
    await expectCancelled(pending, controller);
    expect(encoders[0]?.close).toHaveBeenCalledOnce();
    expect(frames.every((frame) => frame.close.mock.calls.length === 1)).toBe(true);
  });

  it.each(["ready", "seek", "drain", "flush"])("bounds a stalled %s without external cancellation", async (phase) => {
    if (phase === "drain") queue = 25;
    if (phase === "flush") flush = deferred<void>().promise;
    const pending = exportProject(input(video(phase === "ready" ? 0 : 2, phase !== "seek")));
    let settled = false;
    const outcome = pending.then(() => null, (error: Error) => error).then((error) => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(settled).toBe(true);
    expect((await outcome)?.message).toMatch(/too long|timed out/i);
    expect(mock.begin).not.toHaveBeenCalled();
    if (encoders[0]) expect(encoders[0].close).toHaveBeenCalledOnce();
  });

  it("retains the exact failed seek frame and phase in the manually enabled diagnostic", async () => {
    window.__diveUiInputTimingEnabled = true;
    const pending = exportProject(input(video(2, false)));
    const outcome = pending.then(() => null, (error: Error) => error);
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await outcome)?.message).toBe("seeking video timed out");
    const failure = window.__diveScreenMediaProbe?.find((entry) => entry.event === "export_seek_timeout");
    expect(failure).toMatchObject({ phase: "seeking", frame: 2, targetMs: 1000 / 30 });
    expect(window.__diveScreenMediaProbe?.at(-1)?.event).toBe("export_end");
  });

  it("attributes cancelled old seeks to their captured editor generation", async () => {
    window.__diveUiInputTimingEnabled = true;
    useEditor.setState({ generation: 41 });
    const controller = new AbortController();
    const pending = exportProject(input(video(2, false), controller.signal));
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    useEditor.setState({ generation: 42 });
    await expectCancelled(pending, controller);
    expect(window.__diveScreenMediaProbe?.filter((entry) => entry.event === "export_seek_cancelled" || entry.event === "export_end")).toMatchObject([
      { event: "export_seek_cancelled", generation: 41, frame: 2 },
      { event: "export_end", generation: 41 },
    ]);
  });

  it("closes the current frame and encoder after encode throws, preserving borrowed media", async () => {
    encodeThrows = true;
    const element = video();
    await expect(exportProject(input(element))).rejects.toThrow("encode failed");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.close).toHaveBeenCalledOnce();
    expect(encoders[0]?.close).toHaveBeenCalledOnce();
    expect(element.getAttribute("src")).toBe("asset:original.webm");
    expect(element.load).not.toHaveBeenCalled();
  });

  it("unloads owned fallback media after canvas setup fails", async () => {
    const owned = video();
    const create = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag, options) => tag === "video" ? owned : create(tag, options));
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    await expect(exportProject(input(null))).rejects.toThrow("no canvas");
    expect(owned.isConnected).toBe(false);
    expect(owned.hasAttribute("src")).toBe(false);
    expect(owned.pause).toHaveBeenCalled();
    expect(owned.load).toHaveBeenCalled();
  });

  it("does not pause a borrowed preview from a late readiness play callback after cancellation", async () => {
    const element = video(0);
    const play = deferred<void>();
    vi.mocked(element.play).mockReturnValue(play.promise);
    const controller = new AbortController();
    const pending = exportProject(input(element, controller.signal));
    await vi.advanceTimersByTimeAsync(400);
    expect(element.play).toHaveBeenCalledOnce();
    await expectCancelled(pending, controller);
    vi.mocked(element.pause).mockClear();
    play.resolve();
    await Promise.resolve();
    expect(element.pause).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops before native finishing when cancellation arrives during the last append", async () => {
    const append = deferred<null>();
    mock.append.mockReturnValue(append.promise);
    const controller = new AbortController();
    const pending = exportProject(input(video(), controller.signal));
    const outcome = pending.then(() => null, (error: Error) => error);
    await vi.waitFor(() => expect(mock.append).toHaveBeenCalledOnce());
    controller.abort();
    append.resolve(null);
    expect((await outcome)?.message).toMatch(/cancel/i);
    expect(mock.finish).not.toHaveBeenCalled();
  });

  it("unloads owned media and closes the encoder after successful export", async () => {
    const owned = video();
    const create = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag, options) => tag === "video" ? owned : create(tag, options));
    await exportProject(input(null));
    expect(owned.isConnected).toBe(false);
    expect(owned.hasAttribute("src")).toBe(false);
    expect(owned.load).toHaveBeenCalledOnce();
    expect(encoders[0]?.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the owned native finish and waits for its cleanup acknowledgement", async () => {
    const finish = deferred<{ path: string }>();
    const receipt = deferred<string>();
    mock.finish.mockReturnValue(finish.promise);
    mock.cancel.mockImplementation(() => { finish.reject(new Error("export cancelled")); return receipt.promise; });
    const controller = new AbortController();
    let settled = false;
    const pending = exportProject(input(video(), controller.signal)).then(() => null, (error: Error) => error).then((error) => { settled = true; return error; });
    await vi.waitFor(() => expect(mock.finish).toHaveBeenCalledOnce());
    controller.abort();
    await vi.advanceTimersByTimeAsync(1);
    expect(mock.cancel).toHaveBeenCalledExactlyOnceWith("stage");
    expect(settled).toBe(false);
    receipt.resolve("cancelled");
    expect((await pending)?.message).toMatch(/cancelled/);
  });

  it("does not announce done before a concurrent cancellation receipt confirms completed", async () => {
    const finish = deferred<{ path: string }>();
    const receipt = deferred<string>();
    mock.finish.mockReturnValue(finish.promise);
    mock.cancel.mockReturnValue(receipt.promise);
    const controller = new AbortController();
    const request = input(video(), controller.signal);
    const pending = exportProject(request);
    await vi.waitFor(() => expect(mock.finish).toHaveBeenCalledOnce());
    controller.abort();
    finish.resolve({ path: "output.mp4" });
    await vi.advanceTimersByTimeAsync(1);
    expect(request.onProgress.mock.calls.some(([progress]) => progress.phase === "done")).toBe(false);
    receipt.resolve("completed");
    expect((await pending).path).toBe("output.mp4");
    expect(request.onProgress).toHaveBeenLastCalledWith({ phase: "done", progress: 1 });
  });

  it("cleans a job admitted after its renderer was already cancelled", async () => {
    const begin = deferred<string>();
    mock.begin.mockReturnValue(begin.promise);
    const controller = new AbortController();
    const pending = exportProject(input(video(), controller.signal));
    const outcome = pending.then(() => null, (error: Error) => error);
    await vi.waitFor(() => expect(mock.begin).toHaveBeenCalledOnce());
    controller.abort();
    begin.resolve("stage");
    expect((await outcome)?.message).toMatch(/cancelled/);
    expect(mock.cancel).toHaveBeenCalledExactlyOnceWith("stage");
    expect(mock.append).not.toHaveBeenCalled();
  });

  it("cleans owned staging when append fails", async () => {
    mock.append.mockRejectedValueOnce(new Error("write failed"));
    await expect(exportProject(input(video()))).rejects.toThrow("write failed");
    expect(mock.cancel).toHaveBeenCalledExactlyOnceWith("stage");
  });

  it("successfully exports without resetting or removing the borrowed preview", async () => {
    const element = video();
    const result = await exportProject(input(element));
    expect(result.path).toBe("output.mp4");
    expect(element.getAttribute("src")).toBe("asset:original.webm");
    expect(element.load).not.toHaveBeenCalled();
    expect(encoders[0]?.close).toHaveBeenCalledOnce();
  });
});
