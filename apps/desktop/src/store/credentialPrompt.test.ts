import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { events, ipc } from "../lib/ipc";
import type { CoreEvent, CredentialPrompt, Tab } from "../lib/ipc";
import { useBrowser } from "./browser";
import { useCredentialPrompt } from "./credentialPrompt";

const prompt: CredentialPrompt = { tab_id: "t1", kind: "save", origin: "https://example.com", username: "ada", token: "tok-1" };
const tab: Tab = {
  id: "t1",
  workspace_id: "w",
  tier: "today",
  url: "https://example.com/login",
  title: "Example",
  favicon: null,
  position: 0,
  state: "active",
  last_active_at: "2026-09-04T00:00:00Z",
};

let deliverPrompt: (payload: CredentialPrompt) => void;
let deliverState: (payload: CoreEvent) => void;
let answered: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  useCredentialPrompt.setState({ byTab: {}, listening: false });
  useBrowser.setState({ tabs: [] });
  vi.spyOn(events.credentialPrompt, "listen").mockImplementation(async (callback) => {
    deliverPrompt = (payload) => callback({ event: "credential-prompt", id: 0, payload });
    return () => undefined;
  });
  vi.spyOn(events.stateChanged, "listen").mockImplementation(async (callback) => {
    deliverState = (payload) => callback({ event: "state-changed", id: 0, payload });
    return () => undefined;
  });
  answered = vi.spyOn(ipc, "passwordsAnswer").mockResolvedValue(null);
  await useCredentialPrompt.getState().init();
});

afterEach(() => vi.restoreAllMocks());

describe("credential prompts and tabs", () => {
  it("keeps a save prompt when its tab leaves the list because the workspace changed", () => {
    deliverPrompt(prompt);
    useBrowser.setState({ tabs: [tab] });
    useBrowser.setState({ tabs: [] });
    expect(answered).not.toHaveBeenCalled();
    expect(useCredentialPrompt.getState().byTab.t1).toBeDefined();
  });

  it("declines a save prompt when its tab really closes", () => {
    deliverPrompt(prompt);
    deliverState({ type: "tab_closed", data: "t1" });
    expect(answered).toHaveBeenCalledWith("tok-1", false);
    expect(useCredentialPrompt.getState().byTab.t1).toBeUndefined();
  });

  it("drops a missing-password card when its tab moves to another site", () => {
    deliverPrompt({ ...prompt, kind: "missing" });
    useBrowser.setState({ tabs: [{ ...tab, url: "https://other.test/" }] });
    expect(answered).not.toHaveBeenCalled();
    expect(useCredentialPrompt.getState().byTab.t1).toBeUndefined();
  });
});
