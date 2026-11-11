import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RETRY_MS } from "../lib/useTabData";
import { useDockPanels, usePanelRead } from "./dockPanels";

const RACE = "cdp error -32000: Inspected target navigated or closed";
const FRIENDLY = "The page was still loading when it was read.";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useDockPanels.setState({ slots: {} });
});

describe("usePanelRead", () => {
  it("retries once after a page that was still loading", async () => {
    vi.useFakeTimers();
    const read = vi.fn<(id: string) => Promise<string>>().mockRejectedValueOnce(new Error(RACE)).mockResolvedValueOnce("audit");
    const { result } = renderHook(() => usePanelRead<string>("a11y", "t1", "https://a.test/"));
    await act(async () => {
      const run = result.current.run(read);
      await vi.advanceTimersByTimeAsync(RETRY_MS + 10);
      await run;
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe("audit");
    expect(result.current.error).toBeNull();
  });

  it("gives up with the friendly text after a second transient failure", async () => {
    vi.useFakeTimers();
    const read = vi.fn<(id: string) => Promise<string>>().mockRejectedValue(new Error(RACE));
    const { result } = renderHook(() => usePanelRead<string>("stack", "t1", "https://a.test/"));
    await act(async () => {
      const run = result.current.run(read);
      await vi.advanceTimersByTimeAsync(RETRY_MS + 10);
      await run;
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBe(FRIENDLY);
    expect(result.current.busy).toBe(false);
  });

  it("does not retry a real failure", async () => {
    const read = vi.fn<(id: string) => Promise<string>>().mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => usePanelRead<string>("palette", "t1", "https://a.test/"));
    await act(async () => {
      await result.current.run(read);
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe("boom");
  });
});
