import { afterEach, describe, expect, it, vi } from "vitest";
import { events, ipc } from "../lib/ipc";
import { foldPrivacy, listenPrivacy, selectPrivacyCounts, usePrivacy } from "./privacy";

describe("foldPrivacy", () => {
  it("counts blocked categories separately", () => {
    expect(foldPrivacy(undefined, { type: "blocked", data: { tab_id: "t", category: "ads" } })).toEqual({ ads: 1, trackers: 0, youtube: 0 });
    expect(foldPrivacy({ ads: 1, trackers: 0, youtube: 0 }, { type: "blocked", data: { tab_id: "t", category: "tracker" } })).toEqual({ ads: 1, trackers: 1, youtube: 0 });
  });

  it("adds YouTube interventions and caps every count at safe integers", () => {
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

  it("retries failed metadata loads and caches the first success", async () => {
    const info = { version: "2026.09.04.1", ad_rules: 1, tracker_rules: 2, cosmetic_hosts: 3 };
    const read = vi.spyOn(ipc, "privacyInfo")
      .mockRejectedValueOnce(new Error("metadata unavailable"))
      .mockResolvedValue(info);
    await expect(usePrivacy.getState().loadInfo()).rejects.toThrow("metadata unavailable");
    expect(usePrivacy.getState().info).toBeNull();
    expect(usePrivacy.getState().infoError).toBe("metadata unavailable");
    await usePrivacy.getState().loadInfo();
    await usePrivacy.getState().loadInfo();
    expect(usePrivacy.getState().info?.version).toBe("2026.09.04.1");
    expect(usePrivacy.getState().infoError).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
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

  it("lands a burst of blocked requests as one update, and drops what a closed or reloaded tab had waiting", () => {
    vi.useFakeTimers();
    try {
      const updates = vi.fn();
      const unsubscribe = usePrivacy.subscribe(updates);
      for (let i = 0; i < 50; i += 1) usePrivacy.getState().enqueue({ type: "blocked", data: { tab_id: "a", category: i % 2 ? "ads" : "tracker" } });
      usePrivacy.getState().enqueue({ type: "youtube", data: { tab_id: "a", count: 3 } });
      usePrivacy.getState().enqueue({ type: "blocked", data: { tab_id: "b", category: "ads" } });
      usePrivacy.getState().enqueue({ type: "blocked", data: { tab_id: "c", category: "ads" } });
      usePrivacy.getState().drop("b");
      usePrivacy.getState().clearPrivacy("c");
      expect(updates).not.toHaveBeenCalled();
      expect(selectPrivacyCounts("a")(usePrivacy.getState())).toEqual({ ads: 0, trackers: 0, youtube: 0 });
      vi.advanceTimersByTime(100);
      expect(updates).toHaveBeenCalledTimes(1);
      expect(selectPrivacyCounts("a")(usePrivacy.getState())).toEqual({ ads: 25, trackers: 25, youtube: 3 });
      expect(usePrivacy.getState().byTab.b).toBeUndefined();
      expect(usePrivacy.getState().byTab.c).toBeUndefined();
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a failed subscription and caches the first successful listener", async () => {
    const listen = vi.spyOn(events.privacyEvent, "listen")
      .mockRejectedValueOnce(new Error("privacy events unavailable"))
      .mockResolvedValue(() => undefined);
    await expect(listenPrivacy()).rejects.toThrow("privacy events unavailable");
    expect(usePrivacy.getState().eventError).toBe("privacy events unavailable");
    await listenPrivacy();
    await listenPrivacy();
    expect(usePrivacy.getState().eventError).toBeNull();
    expect(listen).toHaveBeenCalledTimes(2);
  });
});
