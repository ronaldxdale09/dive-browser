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
