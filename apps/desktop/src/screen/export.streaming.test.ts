import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_OUTPUT_MS, exportProject } from "./export";
import { newProject } from "./model";

/**
 * The muxer's output goes to the native job as it is produced: the job is
 * admitted before the first frame, pieces arrive in order at contiguous
 * offsets, and nothing accumulates in memory across the whole render.
 */
const mock = vi.hoisted(() => ({ begin: vi.fn(), append: vi.fn(), finish: vi.fn(), cancel: vi.fn(), draw: vi.fn() }));
vi.mock("../lib/ipc", () => ({ ipc: { screenExportBegin: mock.begin, screenExportAppend: mock.append, screenExportFinish: mock.finish, screenExportCancel: mock.cancel } }));
vi.mock("./render", () => ({ Renderer: class { draw = mock.draw; snap() {} } }));

type OnData = (data: Uint8Array, position: number) => void;
const fake = vi.hoisted(() => {
  const state = { muxers: [] as { options: { target: FakeTarget; streaming?: boolean } }[], pieceBytes: 4, skipAt: null as number | null };
  class FakeTarget {
    constructor(public options: { onData: OnData; chunked?: boolean; chunkSize?: number }) {}
  }
  class FakeMuxer {
    position = 0;
    options: { target: FakeTarget; streaming?: boolean };
    constructor(options: { target: FakeTarget; streaming?: boolean }) {
      this.options = options;
      state.muxers.push(this);
    }
    addVideoChunk() {
      this.emit();
    }
    finalize() {
      this.emit();
    }
    private emit() {
      const piece = new Uint8Array(state.pieceBytes).fill(this.position & 0xff);
      const at = state.skipAt !== null && this.position >= state.skipAt ? this.position + 1 : this.position;
      this.options.target.options.onData(piece, at);
      this.position += state.pieceBytes;
    }
  }
  return { state, FakeTarget, FakeMuxer };
});
vi.mock("webm-muxer", () => ({ StreamTarget: fake.FakeTarget, Muxer: fake.FakeMuxer }));

class FakeEncoder {
  static async isConfigSupported() { return { supported: true }; }
  state = "unconfigured";
  encodeQueueSize = 0;
  private output: (chunk: unknown, meta: unknown) => void;
  constructor(init: { output: (chunk: unknown, meta: unknown) => void }) { this.output = init.output; }
  configure() { this.state = "configured"; }
  encode() { this.output({}, {}); }
  flush = vi.fn(async () => undefined);
  close = vi.fn(() => { this.state = "closed"; });
}
class FakeFrame { close = vi.fn(); }

function video() {
  const element = document.createElement("video");
  element.src = "asset:original.webm";
  let time = 0;
  Object.defineProperty(element, "readyState", { configurable: true, value: 2 });
  Object.defineProperty(element, "currentTime", {
    configurable: true,
    get: () => time,
    set: (value: number) => { time = value; queueMicrotask(() => element.dispatchEvent(new Event("seeked"))); },
  });
  element.pause = vi.fn();
  element.load = vi.fn();
  element.play = vi.fn().mockResolvedValue(undefined);
  return element;
}
function input(outEndMs: number, signal?: AbortSignal) {
  const project = newProject({ source: "original.mp4", playable: "original.webm", events: null, durationMs: outEndMs, width: 64, height: 64 });
  return { project, playable: "asset:original.webm", cursorRaw: [], cursorSmooth: [], segments: [{ srcStartMs: 0, srcEndMs: outEndMs, outStartMs: 0, outEndMs, speed: 1 }], onProgress: vi.fn(), video: video(), ...(signal ? { signal } : {}) };
}

beforeEach(() => {
  fake.state.muxers.length = 0; fake.state.pieceBytes = 4; fake.state.skipAt = null;
  vi.stubGlobal("VideoEncoder", FakeEncoder);
  vi.stubGlobal("VideoFrame", FakeFrame);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  mock.cancel.mockResolvedValue("cancelled");
  mock.begin.mockResolvedValue("stage"); mock.append.mockResolvedValue(null); mock.finish.mockResolvedValue({ path: "output.mp4" });
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks();
});

describe("export streaming", () => {
  it("admits the job before encoding and appends the muxer's pieces in order at contiguous offsets", async () => {
    const request = input(100);
    const order: string[] = [];
    mock.begin.mockImplementation(async () => { order.push("begin"); return "stage"; });
    mock.draw.mockImplementation(() => { order.push("draw"); });
    const result = await exportProject(request);
    expect(result.path).toBe("output.mp4");
    expect(order[0]).toBe("begin");
    expect(order.filter((step) => step === "draw")).toHaveLength(3);
    const frames = 3;
    expect(mock.append).toHaveBeenCalledTimes(frames + 1);
    const offsets = mock.append.mock.calls.map(([, offset]) => offset);
    expect(offsets).toEqual(offsets.map((_, i) => i * fake.state.pieceBytes));
    expect(mock.append.mock.calls.every(([job]) => job === "stage")).toBe(true);
    expect(mock.append.mock.calls.map(([, , base64]) => atob(base64 as string).length)).toEqual(Array<number>(frames + 1).fill(fake.state.pieceBytes));
    expect(mock.finish).toHaveBeenCalledOnce();
    expect(mock.cancel).not.toHaveBeenCalled();
    expect(fake.state.muxers[0]?.options.streaming).toBe(true);
    expect(fake.state.muxers[0]?.options.target.options.chunked).toBe(true);
    const phases = request.onProgress.mock.calls.map(([p]) => p.phase);
    expect(phases[0]).toBe("preparing");
    expect(phases).toContain("rendering");
    expect(phases.indexOf("uploading")).toBeGreaterThan(phases.lastIndexOf("rendering"));
    expect(phases.indexOf("finishing")).toBeGreaterThan(phases.indexOf("uploading"));
    expect(phases.at(-1)).toBe("done");
  });

  it("does not hold the whole render: pieces from earlier frames are already gone before the last frame", async () => {
    const request = input(200);
    let appendsBeforeLastDraw = 0;
    let draws = 0;
    mock.draw.mockImplementation(() => { draws++; if (draws === 6) appendsBeforeLastDraw = mock.append.mock.calls.length; });
    await exportProject(request);
    expect(draws).toBe(6);
    expect(appendsBeforeLastDraw).toBeGreaterThan(0);
  });

  it("stops and cleans the job when the muxer hands over a non-contiguous piece", async () => {
    fake.state.skipAt = 4;
    await expect(exportProject(input(100))).rejects.toThrow(/not contiguous/);
    expect(mock.cancel).toHaveBeenCalledExactlyOnceWith("stage");
    expect(mock.finish).not.toHaveBeenCalled();
  });

  it("cancels the admitted job when an append fails mid-render", async () => {
    mock.append.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("disk full"));
    await expect(exportProject(input(100))).rejects.toThrow("disk full");
    expect(mock.cancel).toHaveBeenCalledExactlyOnceWith("stage");
    expect(mock.finish).not.toHaveBeenCalled();
  });

  it("refuses an output longer than the limit before touching media or the engine", async () => {
    const request = input(MAX_OUTPUT_MS + 1000);
    await expect(exportProject(request)).rejects.toThrow(/20 minutes/);
    expect(request.onProgress).not.toHaveBeenCalled();
    expect(mock.begin).not.toHaveBeenCalled();
    expect(request.video.pause).not.toHaveBeenCalled();
    await expect(exportProject(input(MAX_OUTPUT_MS)).then(() => "ok")).resolves.toBe("ok");
  });
});
