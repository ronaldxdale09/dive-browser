import { afterEach, describe, expect, it, vi } from "vitest";
import { events, ipc } from "../lib/ipc";
import { foldPrivacy, listenPrivacy, selectPrivacyCounts, usePrivacy } from "./privacy";

describe("foldPrivacy", () => {
  it("counts blocked categories separately", () => {
    expect(foldPrivacy(undefined, { type: "blocked", data: { tab_id: "t", category: "ads" } })).toEqual({ ads: 1, trackers: 0, youtube: 0 });
    expect(foldPrivacy({ ads: 1, trackers: 0, youtube: 0 }, { type: "blocked", data: { tab_id: "t", category: "tracker" } })).toEqual({ ads: 1, trackers: 1, youtube: 0 });
  });

  it("adds YouTube removals and caps every count at safe integers", () => {
    expect(foldPrivacy({ ads: Number.MAX_SAFE_INTEGER, trackers: 0, youtube: 0 }, { type: "blocked", data: { tab_id: "t", category: "ads" } })).toEqual({ ads: Number.MAX_SAFE_INTEGER, trackers: 0, youtube: 0 });
    expect(foldPrivacy({ ads: 1, trackers: 0, youtube: 0 }, { type: "youtube", data: { tab_id: "t", count: 2 } })).toEqual({ ads: 1, trackers: 0, youtube: 2 });
    expect(foldPrivacy({ ads: 0, trackers: 0, youtube: 1 }, { type: "youtube", data: { tab_id: "t", count: Number.MAX_SAFE_INTEGER } })).toEqual({ ads: 0, trackers: 0, youtube: Number.MAX_SAFE_INTEGER });
  });
});

describe("privacy store", () => {
  const initial = usePrivacy.getState();

  afterEach(() => {
    usePrivacy.setState(initial, true);
    vi.restoreAllMocks();
  });

  it("loads bundled metadata once", async () => {
    const info = { version: "2026.09.04.1", ad_rules: 1, tracker_rules: 2, cosmetic_hosts: 3 };
    const read = vi.spyOn(ipc, "privacyInfo").mockResolvedValue(info);
    await usePrivacy.getState().loadInfo();
    await usePrivacy.getState().loadInfo();
    expect(usePrivacy.getState().info?.version).toBe("2026.09.04.1");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps counts per tab and clears or drops them", () => {
    usePrivacy.getState().apply({ type: "blocked", data: { tab_id: "a", category: "ads" } });
    usePrivacy.getState().apply({ type: "youtube", data: { tab_id: "b", count: 2 } });
    expect(selectPrivacyCounts("a")(usePrivacy.getState())).toEqual({ ads: 1, trackers: 0, youtube: 0 });
    usePrivacy.getState().clearPrivacy("a");
    expect(selectPrivacyCounts("a")(usePrivacy.getState())).toEqual({ ads: 0, trackers: 0, youtube: 0 });
    usePrivacy.getState().drop("b");
    expect(selectPrivacyCounts("b")(usePrivacy.getState())).toEqual({ ads: 0, trackers: 0, youtube: 0 });
  });

  it("subscribes to privacy events only once", async () => {
    const listen = vi.spyOn(events.privacyEvent, "listen").mockResolvedValue(() => undefined);
    await listenPrivacy();
    await listenPrivacy();
    expect(listen).toHaveBeenCalledTimes(1);
  });
});
