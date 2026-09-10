import { beforeEach, describe, expect, it } from "vitest";
import { useConnectHint } from "./connectHint";
import { resetUiStorage, uiStorage } from "../lib/uiStorage";

beforeEach(() => {
  resetUiStorage();
  useConnectHint.getState().reset();
});

describe("the Connect hint", () => {
  it("starts wanting to be noticed and stops once", () => {
    expect(useConnectHint.getState().seen).toBe(false);
    useConnectHint.getState().markSeen();
    expect(useConnectHint.getState().seen).toBe(true);
  });

  it("survives a restart, so the hint is spent rather than repeated", async () => {
    // The chrome's storage arrives after the stores are built, so a store
    // that is never rehydrated shows a first-run hint on every launch.
    useConnectHint.getState().markSeen();
    const written = uiStorage.getItem("dive.connectHint");
    expect(written).toContain('"seen":true');

    // A fresh launch: the store starts at its default and the stored value
    // is put back the way `loadUiStorage` puts it back, before rehydrating.
    useConnectHint.setState({ seen: false });
    uiStorage.setItem("dive.connectHint", written ?? "");
    await useConnectHint.persist.rehydrate();
    expect(useConnectHint.getState().seen).toBe(true);
  });
});
