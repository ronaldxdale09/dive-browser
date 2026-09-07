import { uiStorage } from "../lib/uiStorage";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AvatarImage } from "./AvatarImage";

class WorkerStub {
  static latest: WorkerStub;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror = null;
  onmessageerror = null;
  jobs: { key: string; seed: string }[] = [];
  constructor() { WorkerStub.latest = this; }
  postMessage(job: { key: string; seed: string }) { this.jobs.push(job); }
  terminate() {}
  answer(seed: string, url: string) {
    const key = this.jobs.find((job) => job.seed === seed)!.key;
    this.onmessage?.({ data: { key, url } } as MessageEvent);
  }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); uiStorage.clear(); });

it("keeps dimensions while loading and cannot show a previous profile after a late result", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", WorkerStub);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(callback, 1));
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => setTimeout(callback, 1));
  const view = render(<AvatarImage kind="profile" seed="first-person" color="#7FD8C8" width={20} height={20} alt="" />);
  const image = view.container.querySelector("img")!;
  expect(image.getAttribute("data-avatar-state")).toBe("pending");
  expect(image.width).toBe(20);
  await act(() => vi.advanceTimersByTimeAsync(3));
  view.rerender(<AvatarImage kind="profile" seed="second-person" color="#F0B35E" width={20} height={20} alt="" />);
  const worker = WorkerStub.latest;
  const old = "data:image/svg+xml;utf8,%3Csvg%2F%3E#first";
  await act(async () => worker.answer("first-person", old));
  expect(image.getAttribute("src")).not.toBe(old);
  const current = "data:image/svg+xml;utf8,%3Csvg%2F%3E#second";
  await act(async () => worker.answer("second-person", current));
  expect(image.getAttribute("src")).toBe(current);
  expect(image.getAttribute("data-avatar-state")).toBe("ready");
  view.unmount();
  const warm = render(<AvatarImage kind="profile" seed="second-person" color="#F0B35E" alt="" />);
  expect(warm.container.querySelector("img")!.getAttribute("src")).toBe(current);
  await act(() => vi.advanceTimersByTimeAsync(5000));
});

it("waits for observed contentful paint before starting a cold avatar worker", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  const worker = vi.fn(function () { return new WorkerStub(); });
  let painted!: () => void;
  const disconnect = vi.fn();
  vi.stubGlobal("Worker", worker);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(callback, 1));
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => setTimeout(callback, 1));
  vi.stubGlobal("PerformanceObserver", class {
    static supportedEntryTypes = ["paint"];
    constructor(callback: (list: {getEntries(): {name: string}[]}) => void) {
      painted = () => callback({getEntries: () => [{name: "first-contentful-paint"}]});
    }
    observe() {}
    disconnect = disconnect;
  });
  const {AvatarImage: ColdAvatar} = await import("./AvatarImage");
  render(<ColdAvatar kind="profile" seed="paint-gated-person" color="#123456" alt="" />);
  await act(() => vi.advanceTimersByTimeAsync(10));
  expect(worker).not.toHaveBeenCalled();
  await act(async () => { painted(); await vi.advanceTimersByTimeAsync(10); });
  expect(worker).toHaveBeenCalledTimes(1);
  expect(disconnect).toHaveBeenCalledTimes(1);
});
