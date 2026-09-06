import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { useAgent } from "./agent";

const initial = useAgent.getState();
beforeEach(() => {
  vi.useFakeTimers();
  useAgent.setState(initial, true);
  vi.spyOn(ipc, "agentProviders").mockResolvedValue([]);
  vi.spyOn(ipc, "agentKeys").mockResolvedValue([]);
});
afterEach(() => { useAgent.setState(initial, true); vi.useRealTimers(); vi.restoreAllMocks(); });

it("leaves loading with an actionable error when credential discovery never answers", async () => {
  vi.mocked(ipc.agentKeys).mockReturnValue(new Promise(() => {}));
  const pending = useAgent.getState().init();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(useAgent.getState().loaded).toBe(true);
  expect(useAgent.getState().initError).toMatch(/timed out/i);
  await pending;
});

it("coalesces initialization and supports retry after a failure", async () => {
  vi.mocked(ipc.agentKeys).mockRejectedValueOnce(Error("Credential store unavailable"));
  await Promise.all([useAgent.getState().init(), useAgent.getState().init()]);
  expect(ipc.agentProviders).toHaveBeenCalledTimes(1);
  expect(ipc.agentKeys).toHaveBeenCalledTimes(1);
  expect(useAgent.getState().initError).toBe("Credential store unavailable");
  await useAgent.getState().init();
  expect(useAgent.getState().initError).toBeNull();
  expect(useAgent.getState().loaded).toBe(true);
  expect(ipc.agentKeys).toHaveBeenCalledTimes(2);
});

it("ignores late timed-out results after a successful retry", async () => {
  let resolveOld!: (value: Awaited<ReturnType<typeof ipc.agentKeys>>) => void;
  vi.mocked(ipc.agentKeys).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  const pending = useAgent.getState().init();
  await vi.advanceTimersByTimeAsync(10_000);
  await pending;
  await useAgent.getState().init();
  resolveOld(["anthropic"]);
  await Promise.resolve();
  expect(useAgent.getState().keyed).toEqual([]);
  expect(useAgent.getState().initError).toBeNull();
});
