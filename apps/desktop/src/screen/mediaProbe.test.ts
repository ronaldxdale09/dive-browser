import { afterEach, expect, it, vi } from "vitest";
import { recordMediaProbe, setMediaProbePhase } from "./mediaProbe";
import { leasePreviewMedia } from "./previewMedia";
import { useEditor } from "./store";

afterEach(() => {
  delete window.__diveUiInputTimingEnabled;
  delete window.__diveScreenMediaProbe;
  vi.restoreAllMocks();
});

it("does nothing without the exact manual diagnostic gate", () => {
  const video = document.createElement("video");
  const state = vi.spyOn(useEditor, "getState");
  recordMediaProbe(video, "media_error");
  expect(window.__diveScreenMediaProbe).toBeUndefined();
  expect(state).not.toHaveBeenCalled();
});

it("captures fixed numeric and enum context without URLs or free-form native errors", () => {
  window.__diveUiInputTimingEnabled = true;
  useEditor.setState({ generation: 12, exporting: true });
  const video = document.createElement("video");
  video.src = "https://private.example/secret.mp4";
  Object.defineProperties(video, {
    error: { value: { code: 3, message: "private.example secret decode details" } },
    currentTime: { value: Infinity }, readyState: { value: 2 }, networkState: { value: 1 }, seeking: { value: true },
  });
  setMediaProbePhase(video, "seeking", 2, 33.333);
  recordMediaProbe(video, "export_seek_failed");
  expect(window.__diveScreenMediaProbe?.[0]).toMatchObject({ event: "export_seek_failed", phase: "seeking", frame: 2, targetMs: 33.333, generation: 12, exporting: 1, code: 3, currentTime: null, readyState: 2, networkState: 1, seeking: 1 });
  const record = window.__diveScreenMediaProbe?.[0];
  expect(Object.keys(record ?? {}).sort()).toEqual(["atMs", "code", "currentTime", "event", "exporting", "frame", "generation", "networkState", "paused", "phase", "readyState", "seeking", "targetMs"].sort());
  expect(JSON.stringify(record)).not.toMatch(/private|secret|https|decode details/);
});

it("keeps only the newest 64 fixed records and normalizes nonfinite inputs", () => {
  window.__diveUiInputTimingEnabled = true;
  const video = document.createElement("video");
  for (let i = 0; i < 90; i++) recordMediaProbe(video, "lease_setup", i);
  expect(window.__diveScreenMediaProbe).toHaveLength(64);
  expect(window.__diveScreenMediaProbe?.[0]?.generation).toBe(26);
  setMediaProbePhase(video, "seeking", NaN, Infinity);
  recordMediaProbe(video, "export_seek_failed", NaN);
  expect(window.__diveScreenMediaProbe?.at(-1)).toMatchObject({ generation: null, targetMs: null, frame: null });
});

it("records current lease setup, error, then release before clearing the resource", () => {
  window.__diveUiInputTimingEnabled = true;
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const video = document.createElement("video");
  const release = leasePreviewMedia(video, "asset:private.webm", { isCurrent: () => true, onError: () => {}, generation: 42 });
  Object.defineProperty(video, "error", { value: { code: 2 } });
  video.dispatchEvent(new Event("error"));
  release();
  release();
  expect(window.__diveScreenMediaProbe?.map((entry) => entry.event)).toEqual(["lease_setup", "media_error", "lease_release"]);
  expect(window.__diveScreenMediaProbe?.every((entry) => entry.generation === 42)).toBe(true);
});
