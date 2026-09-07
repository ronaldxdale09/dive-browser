import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { events, ipc } from "../lib/ipc";
import type { SubtitleCue, SubtitleModel, SubtitleModelProgress, SubtitleState } from "../lib/ipc";
import { useBrowser } from "./browser";
import { bootSubtitles, resetSubtitlesListener, useSubtitles } from "./subtitles";

const MODELS: SubtitleModel[] = [
  { id: "base", label: "Base", detail: "Fastest", size_mb: 142, downloaded: false },
  { id: "small", label: "Small", detail: "Balanced", size_mb: 466, downloaded: false },
  { id: "medium", label: "Medium", detail: "Most accurate", size_mb: 1500, downloaded: false },
];

const initial = useSubtitles.getState();

/** Capture the handler each listener is given, so tests can fire events. */
type Handlers = {
  progress?: (e: { payload: SubtitleModelProgress }) => void;
  state?: (e: { payload: SubtitleState }) => void;
  cue?: (e: { payload: SubtitleCue }) => void;
};

function stubListeners(): Handlers {
  const h: Handlers = {};
  vi.spyOn(events.subtitleModelProgress, "listen").mockImplementation((cb) => {
    h.progress = cb as NonNullable<Handlers["progress"]>;
    return Promise.resolve(() => undefined);
  });
  vi.spyOn(events.subtitleState, "listen").mockImplementation((cb) => {
    h.state = cb as NonNullable<Handlers["state"]>;
    return Promise.resolve(() => undefined);
  });
  vi.spyOn(events.subtitleCue, "listen").mockImplementation((cb) => {
    h.cue = cb as NonNullable<Handlers["cue"]>;
    return Promise.resolve(() => undefined);
  });
  return h;
}

beforeEach(() => {
  resetSubtitlesListener();
  useSubtitles.setState(initial, true);
  useBrowser.setState({ activeTab: "t1" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useSubtitles", () => {
  it("does not reactivate a stopped session when a pending start resolves", async () => {
    let finish!: () => void;
    vi.spyOn(ipc, "subtitleStart").mockReturnValue(new Promise<null>((resolve) => { finish = () => resolve(null); }));
    vi.spyOn(ipc, "subtitleStop").mockResolvedValue(undefined);
    useSubtitles.setState({ models: MODELS.map((m) => ({ ...m, downloaded: true })) });
    const pending = useSubtitles.getState().start();
    await useSubtitles.getState().stop();
    finish();
    expect(await pending).toBe(false);
    expect(useSubtitles.getState().active).toBe(false);
  });

  it("clears another tab's caption and running state on tab switch", async () => {
    stubListeners();
    vi.spyOn(ipc, "subtitleRunning").mockResolvedValue(false);
    await bootSubtitles();
    useSubtitles.setState({ active: true, lastCue: "Tab one words" });
    useBrowser.setState({ activeTab: "t2" });
    expect(useSubtitles.getState().lastCue).toBe("");
    expect(useSubtitles.getState().active).toBe(false);
  });
  it("suppresses duplicate starts while the model is loading", async () => {
    let finish!: () => void;
    const pending = new Promise<null>((resolve) => { finish = () => resolve(null); });
    const start = vi.spyOn(ipc, "subtitleStart").mockReturnValue(pending);
    useSubtitles.setState({ models: MODELS.map((m) => ({ ...m, downloaded: true })) });
    const first = useSubtitles.getState().start();
    const second = useSubtitles.getState().start();
    expect(start).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, second]);
  });
  it("loads the model list", async () => {
    vi.spyOn(ipc, "subtitleModels").mockResolvedValue(MODELS);
    await useSubtitles.getState().loadModels();
    expect(useSubtitles.getState().models).toHaveLength(3);
    expect(useSubtitles.getState().models[0]?.id).toBe("base");
  });

  it("remembers the chosen model and falls back to a downloaded one", async () => {
    useSubtitles.getState().setModel("small");
    expect(localStorage.getItem("dive.subtitles.model")).toBe("small");
    vi.spyOn(ipc, "subtitleModels").mockResolvedValue(MODELS.map((m) => ({ ...m, downloaded: m.id === "medium" })));
    await useSubtitles.getState().loadModels();
    // "small" was never downloaded; the one on disk is ready to start.
    expect(useSubtitles.getState().model).toBe("medium");
  });

  it("records progress from the event and flips a model to downloaded on done", async () => {
    vi.spyOn(ipc, "subtitleModels").mockResolvedValue(MODELS);
    vi.spyOn(ipc, "subtitleModelDownload").mockResolvedValue(null);
    const h = stubListeners();
    await bootSubtitles();
    await useSubtitles.getState().loadModels();

    await useSubtitles.getState().download("base");
    expect(ipc.subtitleModelDownload).toHaveBeenCalledWith("base");

    h.progress?.({ payload: { id: "base", received: 5_000_000, total: 142_000_000, done: false, error: null } });
    expect(useSubtitles.getState().downloading.base).toEqual({ received: 5_000_000, total: 142_000_000 });

    h.progress?.({ payload: { id: "base", received: 142_000_000, total: 142_000_000, done: true, error: null } });
    expect(useSubtitles.getState().downloading.base).toBeUndefined();
    expect(useSubtitles.getState().models.find((m) => m.id === "base")?.downloaded).toBe(true);
  });

  it("selects a model when it is downloaded while the chosen one is not on disk", async () => {
    const tiny = { id: "tiny", label: "Tiny", detail: "", size_mb: 78, downloaded: false };
    const base = { id: "base", label: "Base", detail: "", size_mb: 148, downloaded: false };
    const small = { id: "small", label: "Small", detail: "", size_mb: 488, downloaded: true };
    vi.spyOn(ipc, "subtitleModelDownload").mockResolvedValue(null);
    useSubtitles.setState({ models: [tiny, base, small], model: "base", downloading: {} });
    await useSubtitles.getState().download("tiny");
    expect(useSubtitles.getState().model).toBe("tiny");
    // A choice that is already usable is left alone.
    useSubtitles.setState({ model: "small", downloading: {} });
    await useSubtitles.getState().download("base");
    expect(useSubtitles.getState().model).toBe("small");
  });

  it("surfaces a download error and drops the in-flight entry", async () => {
    vi.spyOn(ipc, "subtitleModels").mockResolvedValue(MODELS);
    vi.spyOn(ipc, "subtitleModelDownload").mockResolvedValue(null);
    const h = stubListeners();
    await bootSubtitles();
    await useSubtitles.getState().download("small");
    h.progress?.({ payload: { id: "small", received: 0, total: null, done: false, error: "disk full" } });
    expect(useSubtitles.getState().downloading.small).toBeUndefined();
    expect(useSubtitles.getState().error).toBe("disk full");
  });

  it("refuses to start without a downloaded model", async () => {
    const start = vi.spyOn(ipc, "subtitleStart").mockResolvedValue(null);
    useSubtitles.setState({ models: MODELS, model: "base" });
    await useSubtitles.getState().start();
    expect(start).not.toHaveBeenCalled();
    expect(useSubtitles.getState().error).toMatch(/download/i);
  });

  it("refuses to start with no active tab", async () => {
    const start = vi.spyOn(ipc, "subtitleStart").mockResolvedValue(null);
    useBrowser.setState({ activeTab: null });
    useSubtitles.setState({ models: MODELS.map((m) => (m.id === "base" ? { ...m, downloaded: true } : m)), model: "base" });
    await useSubtitles.getState().start();
    expect(start).not.toHaveBeenCalled();
    expect(useSubtitles.getState().error).toMatch(/tab/i);
  });

  it("starts with the chosen model, language and translate flag", async () => {
    const start = vi.spyOn(ipc, "subtitleStart").mockResolvedValue(null);
    useSubtitles.setState({
      models: MODELS.map((m) => (m.id === "small" ? { ...m, downloaded: true } : m)),
      model: "small",
      language: "ja",
      translate: true,
    });
    await useSubtitles.getState().start();
    expect(start).toHaveBeenCalledWith("t1", "small", "ja", true);
    expect(useSubtitles.getState().error).toBeNull();
  });

  it("stops the active tab's session", async () => {
    const stop = vi.spyOn(ipc, "subtitleStop").mockResolvedValue(undefined);
    useSubtitles.setState({ active: true });
    await useSubtitles.getState().stop();
    expect(stop).toHaveBeenCalledWith("t1");
    expect(useSubtitles.getState().active).toBe(false);
  });

  it("follows state and cue events for the active tab", async () => {
    const h = stubListeners();
    await bootSubtitles();

    h.state?.({ payload: { tab_id: "t1", active: true, error: null } });
    expect(useSubtitles.getState().active).toBe(true);

    h.cue?.({ payload: { tab_id: "t1", text: "Hello there", language: "en", is_final: false } });
    expect(useSubtitles.getState().lastCue).toBe("Hello there");

    // A different tab's cue is ignored.
    h.cue?.({ payload: { tab_id: "other", text: "nope", language: "en", is_final: false } });
    expect(useSubtitles.getState().lastCue).toBe("Hello there");

    h.state?.({ payload: { tab_id: "t1", active: false, error: "engine gone" } });
    expect(useSubtitles.getState().active).toBe(false);
    expect(useSubtitles.getState().error).toBe("engine gone");
  });

  it("subscribes only once however many times it boots", async () => {
    vi.spyOn(events.subtitleModelProgress, "listen").mockResolvedValue(() => undefined);
    vi.spyOn(events.subtitleState, "listen").mockResolvedValue(() => undefined);
    const cue = vi.spyOn(events.subtitleCue, "listen").mockResolvedValue(() => undefined);
    await bootSubtitles();
    await bootSubtitles();
    expect(cue).toHaveBeenCalledTimes(1);
  });
});
