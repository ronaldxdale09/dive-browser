import { describe, expect, it, vi } from "vitest";
import { events } from "../lib/ipc";
import { listenConsole } from "./console";
import { listenNetwork } from "./network";

describe("event listeners", () => {
  it("listenNetwork retries a failed subscription and caches the first successful one", async () => {
    const listen = vi.spyOn(events.networkEventBatch, "listen")
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue(() => undefined);
    await expect(listenNetwork()).rejects.toThrow("unavailable");
    const second = listenNetwork();
    await second;
    expect(listenNetwork()).toBe(second);
    expect(listen).toHaveBeenCalledTimes(2);
  });

  it("listenConsole retries a failed subscription and caches the first successful one", async () => {
    const listen = vi.spyOn(events.consoleBatch, "listen")
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue(() => undefined);
    await expect(listenConsole()).rejects.toThrow("unavailable");
    const second = listenConsole();
    await second;
    expect(listenConsole()).toBe(second);
    expect(listen).toHaveBeenCalledTimes(2);
  });
});
