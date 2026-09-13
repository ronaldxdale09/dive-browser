// @ts-expect-error Vitest runs in Node; the browser-only tsconfig intentionally omits Node types.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface RectValue {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface Observation {
  url: string;
  documentIdentity: string;
  visibilityState: DocumentVisibilityState;
  hasFocus: boolean;
  scroll: { x: number; y: number };
  viewport: { width: number; height: number };
  video: {
    identity: string;
    connected: boolean;
    currentTime: number;
    readyState: number;
    networkState: number;
    paused: boolean;
    muted: boolean;
    rect: RectValue;
  } | null;
  startup_target: { locator: string; rect: RectValue } | null;
  content: { video_id: string | null; ad_showing: boolean; player_state: number | null } | null;
  trusted_pointer_events: Array<{ type: string; trusted: boolean }>;
}

const helper = readFileSync("../../scripts/media-playback-check.py", "utf8");
const expressionMatch = helper.match(/OBSERVE_EXPRESSION = r"""([\s\S]*?)"""/);
if (!expressionMatch?.[1]) throw new Error("media helper observation expression is missing");
const observeExpression = expressionMatch[1];

function box(element: Element, rect: RectValue): void {
  element.getBoundingClientRect = () => ({ ...rect, toJSON: () => ({}) }) as DOMRect;
}

function rect(x: number, y: number, width: number, height: number): RectValue {
  return { x, y, width, height, top: y, right: x + width, bottom: y + height, left: x };
}

function mediaState(video: HTMLVideoElement, state: { currentTime: number; readyState: number; paused: boolean; networkState?: number }): void {
  Object.defineProperties(video, {
    currentTime: { configurable: true, value: state.currentTime, writable: true },
    readyState: { configurable: true, value: state.readyState },
    paused: { configurable: true, value: state.paused },
    networkState: { configurable: true, value: state.networkState ?? 1 },
    ended: { configurable: true, value: false },
    duration: { configurable: true, value: 4 },
    error: { configurable: true, value: null },
  });
}

function observe(): Observation {
  return eval(observeExpression) as Observation;
}

beforeEach(() => {
  document.body.innerHTML = "";
  Reflect.deleteProperty(window, "__diveMediaPlaybackCheck");
  Object.defineProperty(window, "scrollX", { configurable: true, value: 12 });
  Object.defineProperty(window, "scrollY", { configurable: true, value: 34 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("media playback browser observation", () => {
  it("reports the player's content identity separately from an advertisement", () => {
    document.body.innerHTML = '<div id="movie_player" class="ad-showing"></div>';
    const player = document.getElementById("movie_player")!;
    const getPlayerState = vi.fn(() => 1);
    Object.assign(player, { getVideoData: () => ({ video_id: "jNQXAC9IVRw" }), getPlayerState });
    expect(observe().content).toEqual({ video_id: "jNQXAC9IVRw", ad_showing: true, player_state: 1 });
    player.classList.remove("ad-showing");
    getPlayerState.mockReturnValue(0);
    expect(observe().content).toEqual({ video_id: "jNQXAC9IVRw", ad_showing: false, player_state: 0 });
  });

  it.each(["missing", "throwing"])("preserves content identity when the player-state method is %s", (method) => {
    document.body.innerHTML = '<div id="movie_player" class="ad-showing"></div>';
    const player = document.getElementById("movie_player")!;
    Object.assign(player, { getVideoData: () => ({ video_id: "jNQXAC9IVRw" }) });
    if (method === "throwing") {
      Object.assign(player, { getPlayerState: () => { throw new Error("player not initialized"); } });
    }

    expect(observe().content).toEqual({ video_id: "jNQXAC9IVRw", ad_showing: true, player_state: null });
  });

  it.each([
    { visibility: "hidden" as const, focus: false },
    { visibility: "visible" as const, focus: true },
  ])("reports document visibility $visibility and focus $focus", ({ visibility, focus }) => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue(visibility);
    vi.spyOn(document, "hasFocus").mockReturnValue(focus);

    const result = observe();

    expect(result.visibilityState).toBe(visibility);
    expect(result.hasFocus).toBe(focus);
    expect(result.video).toBeNull();
    expect(result.content).toBeNull();
  });

  it("reports media state, bounds and scroll while prioritizing the visible YouTube startup overlay", () => {
    document.body.innerHTML = `
      <video></video>
      <button class="ytp-large-play-button" style="opacity:1">YouTube play</button>
      <button data-startup-play style="opacity:1">Fixture play</button>
    `;
    const video = document.querySelector("video")!;
    const youtube = document.querySelector(".ytp-large-play-button")!;
    const fixture = document.querySelector("[data-startup-play]")!;
    mediaState(video, { currentTime: 1.25, readyState: 4, paused: true, networkState: 2 });
    box(video, rect(10, 20, 320, 180));
    box(youtube, rect(136, 86, 68, 48));
    box(fixture, rect(140, 90, 60, 40));
    document.elementsFromPoint = vi.fn(() => [youtube, fixture]);

    const result = observe();

    expect(result.video).toMatchObject({
      connected: true,
      currentTime: 1.25,
      readyState: 4,
      networkState: 2,
      paused: true,
      muted: true,
      rect: rect(10, 20, 320, 180),
    });
    expect(video.muted).toBe(true);
    expect(result.scroll).toEqual({ x: 12, y: 34 });
    expect(result.viewport).toEqual({ width: window.innerWidth, height: window.innerHeight });
    expect(result.startup_target).toEqual({
      locator: "css=.ytp-large-play-button",
      rect: rect(136, 86, 68, 48),
    });
  });

  it("keeps document and video identities stable, then changes the video identity on replacement", () => {
    document.body.innerHTML = `<video></video>`;
    const firstVideo = document.querySelector("video")!;
    mediaState(firstVideo, { currentTime: 0, readyState: 4, paused: false });
    box(firstVideo, rect(0, 0, 320, 180));
    document.elementsFromPoint = vi.fn(() => []);

    const first = observe();
    const second = observe();
    const replacement = document.createElement("video");
    mediaState(replacement, { currentTime: 0, readyState: 3, paused: false });
    box(replacement, rect(0, 0, 320, 180));
    firstVideo.replaceWith(replacement);
    const third = observe();

    expect(second.documentIdentity).toBe(first.documentIdentity);
    expect(second.video?.identity).toBe(first.video?.identity);
    expect(third.documentIdentity).toBe(first.documentIdentity);
    expect(third.video?.identity).not.toBe(first.video?.identity);
    expect(third.video?.readyState).toBe(3);
  });

  it("ignores synthetic pointer events and falls back when the preferred startup target is hidden", () => {
    document.body.innerHTML = `
      <video></video>
      <button class="ytp-large-play-button" style="display:none;opacity:1">Hidden play</button>
      <button data-startup-play style="opacity:1">Fixture play</button>
    `;
    const video = document.querySelector("video")!;
    const fixture = document.querySelector("[data-startup-play]")!;
    mediaState(video, { currentTime: 0, readyState: 2, paused: true });
    box(video, rect(10, 20, 320, 180));
    box(document.querySelector(".ytp-large-play-button")!, rect(136, 86, 68, 48));
    box(fixture, rect(140, 90, 60, 40));
    document.elementsFromPoint = vi.fn(() => [fixture]);
    observe();

    fixture.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 170, clientY: 110 }));
    const result = observe();

    expect(result.trusted_pointer_events).toEqual([]);
    expect(result.startup_target).toEqual({
      locator: "css=[data-startup-play]",
      rect: rect(140, 90, 60, 40),
    });
  });
});
