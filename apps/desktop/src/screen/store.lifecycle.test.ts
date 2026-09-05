import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  info: vi.fn(), read: vi.fn(), write: vi.fn(), size: vi.fn(), chunk: vi.fn(), report: vi.fn(),
}));
vi.mock("../lib/ipc", () => ({ ipc: {
  screenMediaInfo: mocks.info, screenProjectRead: mocks.read, screenProjectWrite: mocks.write,
  fileSize: mocks.size, fileReadChunk: mocks.chunk,
} }));
vi.mock("../store/browser", () => ({ useBrowser: { setState: mocks.report } }));
vi.mock("../lib/mediaUrl", () => ({ captureMediaUrl: (path: string) => `asset:${path}` }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const media = (source: string) => ({ playable: `${source}.webm`, events: null, duration_ms: 5000, width: 640, height: 360, has_audio: false });
let store: typeof import("./store").useEditor;
const edit = (padding: number) => store.getState().update((editor) => ({ ...editor, padding }));
const padding = () => store.getState().project?.editor.padding;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.info.mockImplementation(async (source: string) => media(source));
  mocks.read.mockResolvedValue(null);
  mocks.write.mockResolvedValue(null);
  store = (await import("./store")).useEditor;
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("recording editor persistence lifecycle", () => {
  it("does not let a delayed A load replace recording B", async () => {
    const a = deferred<ReturnType<typeof media>>();
    mocks.info.mockImplementation((source: string) => source === "A" ? a.promise : Promise.resolve(media(source)));
    const openingA = store.getState().open("A");
    await store.getState().open("B");
    a.resolve(media("A"));
    await openingA;
    expect(store.getState().source).toBe("B");
    expect(store.getState().project?.media.source).toBe("B");
    expect(store.getState().playable).toBe("asset:B.webm");
  });

  it("ignores an old project-read failure after switching recordings", async () => {
    const readA = deferred<string | null>();
    mocks.read.mockImplementation((source: string) => source === "A" ? readA.promise : Promise.resolve(null));
    const a = store.getState().open("A");
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledWith("A"));
    await store.getState().open("B");
    readA.reject(new Error("old read failed"));
    await a;
    expect(store.getState().error).toBeNull();
    expect(store.getState().project?.media.source).toBe("B");
  });

  it("flushes an edit when the tab closes before its debounce", async () => {
    await store.getState().open("A");
    edit(37);
    store.getState().close();
    await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(1));
    expect(mocks.write.mock.calls[0]?.[0]).toBe("A");
    expect(JSON.parse(mocks.write.mock.calls[0]?.[1] as string).editor.padding).toBe(37);
    expect(store.getState().project).toBeNull();
  });

  it("serializes writes and does not mark a newer edit saved after an old acknowledgment", async () => {
    await store.getState().open("A");
    const first = deferred<null>();
    const second = deferred<null>();
    mocks.write.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    edit(23);
    const savingFirst = store.getState().save();
    await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(1));
    edit(47);
    const savingSecond = store.getState().save();
    await Promise.resolve();
    expect(mocks.write).toHaveBeenCalledTimes(1);
    first.resolve(null);
    await savingFirst;
    expect(store.getState().dirty).toBe(true);
    await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(2));
    expect(JSON.parse(mocks.write.mock.calls[1]?.[1] as string).editor.padding).toBe(47);
    second.resolve(null);
    await savingSecond;
    expect(store.getState().dirty).toBe(false);
  });

  it("waits for a same-source close flush before reading the project again", async () => {
    let disk: string | null = null;
    mocks.read.mockImplementation(async () => disk);
    await store.getState().open("A");
    const write = deferred<null>();
    mocks.write.mockImplementation(async (_source: string, json: string) => { await write.promise; disk = json; return null; });
    edit(61);
    store.getState().close();
    const reopening = store.getState().open("A");
    await Promise.resolve();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    write.resolve(null);
    await reopening;
    expect(padding()).toBe(61);
    expect(store.getState().dirty).toBe(false);
  });

  it("retains failed saves as editable drafts and retries after reopening", async () => {
    await store.getState().open("A");
    edit(69);
    mocks.write.mockRejectedValue(new Error("disk full"));
    await store.getState().save();
    expect(store.getState().error).toBeNull();
    expect(store.getState().saveError).toContain("disk full");
    expect(store.getState().dirty).toBe(true);
    store.getState().close();
    await store.getState().open("B");
    await store.getState().open("A");
    expect(padding()).toBe(69);
    expect(store.getState().dirty).toBe(true);
    mocks.write.mockResolvedValue(null);
    await store.getState().save();
    expect(store.getState().saveError).toBeNull();
    expect(store.getState().dirty).toBe(false);
  });

  it("retains B's failed draft when its copied sidecar still names recording A", async () => {
    const { newProject } = await import("./model");
    const copied = newProject({ source: "A", playable: "A.webm", events: "A.events.json", durationMs: 99_000, width: 1920, height: 1080 });
    mocks.read.mockResolvedValue(JSON.stringify(copied));
    await store.getState().open("B");
    edit(73);
    mocks.write.mockRejectedValue(new Error("B disk full"));
    await store.getState().save();
    store.getState().close();
    await store.getState().open("B");
    expect(padding()).toBe(73);
    expect(store.getState().dirty).toBe(true);
    expect(store.getState().project?.media).toEqual({
      source: "B", playable: "B.webm", events: null, durationMs: 5000, width: 640, height: 360,
    });
    expect(mocks.write.mock.calls.every(([source, json]) => source === "B" && JSON.parse(json as string).media.source === "B")).toBe(true);
  });

  it("does not apply an old save failure to another recording", async () => {
    await store.getState().open("A");
    edit(31);
    const write = deferred<null>();
    mocks.write.mockReturnValueOnce(write.promise);
    const saving = store.getState().save();
    await store.getState().open("B");
    write.reject(new Error("A write failed"));
    await saving;
    expect(store.getState().error).toBeNull();
    expect(store.getState().saveError).toBeNull();
    expect(store.getState().project?.media.source).toBe("B");
  });

  it("rejects old ownership cleanup even when the replacement uses the same source", async () => {
    await store.getState().open("A");
    const oldOwner = store.getState().generation;
    await store.getState().open("A");
    store.getState().close(oldOwner);
    expect(store.getState().project?.media.source).toBe("A");
  });
});
