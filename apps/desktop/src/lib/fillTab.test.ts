import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import source from "../../src-tauri/src/inject/fill-tab.js?raw";

type Page = Window & { __diveFillTab?: { toggle(): string; exit(): void; filling(): boolean } };

function install() {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const page = frame.contentWindow as Page;
  new Function("window", "document", source)(page, page.document);
  const video = page.document.createElement("video");
  video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
  page.document.body.append(video);
  return { page, video, api: page.__diveFillTab! };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("fill-tab idle work", () => {
  it("does not schedule polling before a video is filled", () => {
    install();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers a detached player and stops polling after recovery", () => {
    const { page, video, api } = install();
    expect(api.toggle()).toBe("filled");
    video.remove();
    vi.advanceTimersByTime(1000);
    expect(api.filling()).toBe(false);
    expect(page.document.documentElement.classList.contains("dive-filling")).toBe(false);
    expect(page.document.querySelector(".dive-fill-stage")).toBeNull();
    expect(video.parentNode).toBe(page.document.body);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer after repeated Escape and explicit exits", () => {
    const { page, api } = install();
    for (let i = 0; i < 3; i++) {
      api.toggle();
      expect(api.filling()).toBe(true);
      page.document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(api.filling()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      api.toggle();
      api.exit();
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});
