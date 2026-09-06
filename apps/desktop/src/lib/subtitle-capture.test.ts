import script from "../../src-tauri/src/inject/subtitles.js?raw";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Capture = { running: () => boolean; stop: () => void; show: (text: string, epoch?: number) => void };
const page = window as unknown as { __diveSubtitles?: Capture; __diveSubtitleError?: string; __testAudio: (data: string) => void };
let processors: { onaudioprocess?: (event: unknown) => void; connect: () => void; disconnect: () => void }[];
let packets: string[];
let track: { readyState: string; stop: () => void };
let video: HTMLVideoElement;
let sampleRate: number;

function install() {
  return window.eval(`(function(){${script.replaceAll("__AUDIO_BINDING__", "__testAudio")}})()`);
}
function feed(count = 2) {
  for (let i = 0; i < count; i++) processors.at(-1)?.onaudioprocess?.({
    inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.25) },
    outputBuffer: { getChannelData: () => new Float32Array(4096) },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  packets = [];
  sampleRate = 48000;
  processors = [];
  track = { readyState: "live", stop() { this.readyState = "ended"; } };
  document.body.innerHTML = "<video></video>";
  video = document.querySelector("video")!;
  Object.defineProperties(video, {
    readyState: { value: 4, configurable: true },
    paused: { value: false, configurable: true },
    captureStream: { value: () => {
      const capturedTrack = { ...track, readyState: "live" };
      return { getAudioTracks: () => [capturedTrack], getTracks: () => [capturedTrack] };
    }, configurable: true },
  });
  video.getBoundingClientRect = () => ({ width: 1280, height: 720 } as DOMRect);
  vi.stubGlobal("AudioContext", class {
    state = "running";
    sampleRate = sampleRate;
    destination = {};
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() {
      const processor = { connect() {}, disconnect() {} };
      processors.push(processor);
      return processor;
    }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  });
  page.__testAudio = (data) => packets.push(data);
});

afterEach(() => {
  page.__diveSubtitles?.stop();
  delete page.__diveSubtitles;
  delete page.__diveSubtitleError;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("captures again after stop and reinjection", () => {
  install();
  page.__diveSubtitles!.stop();
  track.readyState = "live";
  install();
  expect(page.__diveSubtitles!.running()).toBe(true);
  feed();
  expect(packets.length).toBeGreaterThan(0);
});

it("reports a capture error without pretending to run", () => {
  Object.defineProperty(video, "captureStream", { value: () => { throw new Error("Access denied"); } });
  install();
  expect(page.__diveSubtitles?.running() ?? false).toBe(false);
  expect(page.__diveSubtitleError).toMatch(/Access denied/);
});

it("resamples continuously into exact 100 ms PCM frames", () => {
  install();
  feed(12); // 49152 samples at 48 kHz: ten complete frames at 16 kHz.
  const frames = packets.map((p) => JSON.parse(p)).filter((p) => p.kind === "audio");
  expect(frames).toHaveLength(10);
  expect(atob(frames[0].pcm).length).toBe(3200);
});

it("clears old captions on seek and rejects late results from before the seek", () => {
  install();
  page.__diveSubtitles!.show("old words", 0);
  video.dispatchEvent(new Event("seeking"));
  page.__diveSubtitles!.show("stale words", 0);
  expect(document.body.textContent).not.toContain("stale words");
  expect(document.body.textContent).not.toContain("old words");
});

it("sends no audio while paused", () => {
  install();
  Object.defineProperty(video, "paused", { value: true });
  video.dispatchEvent(new Event("pause"));
  packets = [];
  feed();
  expect(packets.filter((p) => JSON.parse(p).kind === "audio")).toHaveLength(0);
});

it("does not recreate an overlay from late results after stopping", () => {
  install();
  const capture = page.__diveSubtitles!;
  capture.stop();
  capture.show("late words");
  expect(document.body.textContent).not.toContain("late words");
});

it("preserves fractional resampling phase at 44.1 kHz", () => {
  sampleRate = 44100;
  install();
  feed(100);
  const frames = packets.map((p) => JSON.parse(p)).filter((p) => p.kind === "audio");
  expect(frames).toHaveLength(Math.floor(409600 / 4410));
  const bytes = Uint8Array.from(atob(frames.at(-1).pcm), (c) => c.charCodeAt(0));
  const samples = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length; i += 2) expect(samples.getInt16(i, true)).toBe(8192);
});

it("reattaches when the player changes its media source", () => {
  install();
  page.__diveSubtitles!.show("previous source", 0);
  Object.defineProperty(video, "currentSrc", { value: "https://example.test/next-video.mp4" });
  vi.advanceTimersByTime(500);
  expect(processors).toHaveLength(2);
  expect(page.__diveSubtitles!.running()).toBe(true);
  expect(document.body.textContent).not.toContain("previous source");
  expect(packets.map((p) => JSON.parse(p)).some((p) => p.kind === "reset")).toBe(true);
});

it("ends capture on page departure", () => {
  install();
  window.dispatchEvent(new Event("pagehide"));
  expect(page.__diveSubtitles!.running()).toBe(false);
  expect(packets.map((p) => JSON.parse(p)).at(-1).kind).toBe("ended");
  expect(document.querySelector("[data-dive=subtitles]")).toBeNull();
});

it("reports stalled capture instead of listening forever", () => {
  install();
  vi.advanceTimersByTime(16000);
  expect(page.__diveSubtitles!.running()).toBe(false);
  expect(page.__diveSubtitleError).toMatch(/No audio received/);
});
