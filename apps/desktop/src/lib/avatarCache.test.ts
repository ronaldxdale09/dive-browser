import { afterEach, describe, expect, it, vi } from "vitest";
import { AvatarCache } from "./avatarCache";

class TestWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  answer(key: string, url: string) { this.onmessage?.({ data: { key, url } } as MessageEvent); }
}
const input = { kind: "profile" as const, seed: "ada", color: "#7FD8C8" };
const svg = "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E";
function setup(storage: Storage | null = localStorage) {
  const worker = new TestWorker();
  const createWorker = vi.fn(() => worker);
  const cache = new AvatarCache(createWorker, () => storage, (run) => { setTimeout(run, 10); });
  return { worker, createWorker, cache };
}
afterEach(() => { localStorage.clear(); vi.useRealTimers(); });

describe("avatar cache", () => {
  it("does no generation during lookup, defers one worker and coalesces identical requests", async () => {
    vi.useFakeTimers();
    const { cache, worker, createWorker } = setup();
    expect(cache.get(input)).toBeUndefined();
    expect(createWorker).not.toHaveBeenCalled();
    const a = cache.load(input), b = cache.load(input);
    expect(createWorker).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    worker.answer(worker.postMessage.mock.calls[0]![0].key, svg);
    expect(await a).toBe(svg);
    expect(await b).toBe(svg);
    await vi.advanceTimersByTimeAsync(5000);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("restores exact saved artwork after reload without creating a worker", async () => {
    vi.useFakeTimers();
    const first = setup();
    const pending = first.cache.load(input);
    await vi.advanceTimersByTimeAsync(10);
    first.worker.answer(first.worker.postMessage.mock.calls[0]![0].key, svg);
    await pending;
    const reopened = setup();
    expect(reopened.cache.get(input)).toBe(svg);
    expect(await reopened.cache.load(input)).toBe(svg);
    expect(reopened.createWorker).not.toHaveBeenCalled();
    expect(reopened.cache.get({ ...input, seed: "new" })).toBeUndefined();
    expect(reopened.cache.get({ ...input, kind: "workspace" })).toBeUndefined();
  });

  it("survives unavailable storage and worker failure, then retries on a later request", async () => {
    vi.useFakeTimers();
    const storage = { getItem: () => { throw Error("denied"); }, setItem: () => { throw Error("quota"); } } as unknown as Storage;
    const { cache, worker, createWorker } = setup(storage);
    expect(cache.get(input)).toBeUndefined();
    const pending = cache.load(input);
    await vi.advanceTimersByTimeAsync(10);
    worker.onerror?.();
    expect(await pending).toBeUndefined();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    const retry = cache.load(input);
    await vi.advanceTimersByTimeAsync(10);
    expect(createWorker).toHaveBeenCalledTimes(2);
    worker.answer(worker.postMessage.mock.calls.at(-1)![0].key, svg);
    expect(await retry).toBe(svg);
    expect(cache.get(input)).toBe(svg);
  });

  it("times out a hung worker and ignores late results from the terminated generation", async () => {
    vi.useFakeTimers();
    const { cache, worker } = setup(null);
    const pending = cache.load(input);
    await vi.advanceTimersByTimeAsync(10);
    const deliver = worker.onmessage!;
    const key = worker.postMessage.mock.calls[0]![0].key;
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toBeUndefined();
    deliver({ data: { key, url: svg } } as MessageEvent);
    expect(cache.get(input)).toBeUndefined();
  });

  it("keeps persistence bounded when an index write fails after an artwork write", async () => {
    vi.useFakeTimers();
    const storage = {
      getItem: (key: string) => localStorage.getItem(key),
      removeItem: (key: string) => localStorage.removeItem(key),
      setItem: (key: string, value: string) => {
        if (key.endsWith(":index")) throw Error("index quota");
        localStorage.setItem(key, value);
      },
    } as Storage;
    const { cache, worker } = setup(storage);
    for (let i = 0; i < 20; i++) {
      const pending = cache.load({ ...input, seed: String(i) });
      await vi.advanceTimersByTimeAsync(10);
      worker.answer(worker.postMessage.mock.calls.at(-1)![0].key, svg + "a".repeat(32000));
      await pending;
    }
    let retained = 0;
    for (let i = 0; i < localStorage.length; i++) retained += localStorage.getItem(localStorage.key(i)!)!.length;
    expect(retained).toBeLessThanOrEqual(256 * 1024);
  });

  it("bounds stored artwork without deleting unrelated settings", async () => {
    vi.useFakeTimers();
    localStorage.setItem("theme", "dark");
    const { cache, worker } = setup();
    const largeSvg = svg + "a".repeat(32000);
    for (let i = 0; i < 20; i++) {
      const pending = cache.load({ ...input, seed: String(i) });
      await vi.advanceTimersByTimeAsync(10);
      worker.answer(worker.postMessage.mock.calls.at(-1)![0].key, largeSvg);
      await pending;
    }
    let bytes = 0;
    for (let i = 0; i < localStorage.length; i++) bytes += (localStorage.getItem(localStorage.key(i)!)?.length ?? 0);
    expect(bytes).toBeLessThan(270000);
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(setup().cache.get({ ...input, seed: "0" })).toBeUndefined();
    expect(setup().cache.get({ ...input, seed: "19" })).toBe(largeSvg);
  });
});
