import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { useTabAudio } from "./tabAudio";

beforeEach(() => {
  vi.spyOn(ipc, "tabSetMuted").mockResolvedValue(null);
  useTabAudio.setState({ byTab: {}, listening: true });
});

afterEach(() => {
  useTabAudio.setState({ byTab: {}, listening: false });
  vi.restoreAllMocks();
});

describe("useTabAudio", () => {
  it("answers a mute straight away and tells the host", async () => {
    useTabAudio.setState({ byTab: { t1: { tab_id: "t1", audible: true, muted: false } } });
    await useTabAudio.getState().toggle("t1");
    expect(ipc.tabSetMuted).toHaveBeenCalledWith("t1", true);
    // The speaker crosses out on the click, not on the round trip.
    expect(useTabAudio.getState().byTab.t1).toMatchObject({ muted: true, audible: true });
    await useTabAudio.getState().toggle("t1");
    expect(ipc.tabSetMuted).toHaveBeenLastCalledWith("t1", false);
  });

  it("mutes a silent tab, so a tab can be silenced before it makes a sound", async () => {
    await useTabAudio.getState().setMuted("t2", true);
    expect(useTabAudio.getState().byTab.t2).toMatchObject({ audible: false, muted: true });
  });

  it("drops a tab that is neither playing nor muted, and forgets a closed one", () => {
    useTabAudio.setState({ byTab: { t1: { tab_id: "t1", audible: true, muted: false } } });
    // What the host reports when the sound stops.
    useTabAudio.setState((s) => {
      const rest = { ...s.byTab };
      delete rest.t1;
      return { byTab: rest };
    });
    expect(useTabAudio.getState().byTab.t1).toBeUndefined();
    useTabAudio.setState({ byTab: { t3: { tab_id: "t3", audible: true, muted: true } } });
    useTabAudio.getState().forget("t3");
    expect(useTabAudio.getState().byTab.t3).toBeUndefined();
  });

  it("survives a host that refuses the call", async () => {
    vi.spyOn(ipc, "tabSetMuted").mockRejectedValue(new Error("no such tab"));
    await useTabAudio.getState().setMuted("t4", true);
    expect(useTabAudio.getState().byTab.t4).toMatchObject({ muted: true });
  });
});
